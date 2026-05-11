import type * as ts from "typescript/lib/tsserverlibrary";
import WorkspaceContext from "../workspaceContext";
import {
	type ApexDefinitionFile,
	buildApexStateSnapshot,
	isApexUpdateRequest,
} from "./salesforce/apex";
import { getRequestPayload } from "./ts";

type Deps = {
	typescript: typeof ts;
	apexDefinitionsByWorkspace: Map<string, ReadonlyArray<ApexDefinitionFile>>;
	applyWorkspaceApexFiles: (workspace: string) => void;
};

const handledSessions = new WeakSet<ts.server.Session>();

export function setupSessionHandlers(
	session: ts.server.Session | undefined,
	deps: Deps,
) {
	if (!session || handledSessions.has(session)) return;
	handledSessions.add(session);

	const registerHandler = (
		command: string,
		handler: (request: ts.server.protocol.Request) => ts.server.HandlerResponse,
	) => {
		try {
			session.addProtocolHandler(command, handler);
		} catch {
			return;
		}
	};

	registerHandler("_tatzeroko/updateApexTypes", (request) => {
		const payload = getRequestPayload(request);
		if (!isApexUpdateRequest(payload) || !payload.workspace || !payload.files) {
			return { response: { success: false } };
		}

		const normalizedWorkspace = deps.typescript.server.toNormalizedPath(
			payload.workspace,
		);
		const files = payload.files.filter(
			(file): file is ApexDefinitionFile =>
				!!file &&
				typeof file.path === "string" &&
				typeof file.content === "string" &&
				typeof file.moduleName === "string",
		);
		const wsCtx =
			WorkspaceContext.resolve(normalizedWorkspace) ??
			WorkspaceContext.getOrCreate(normalizedWorkspace);
		const canonical = wsCtx.workspace;
		deps.apexDefinitionsByWorkspace.set(canonical, files);
		deps.applyWorkspaceApexFiles(canonical);
		return {
			response: buildApexStateSnapshot(
				deps.typescript,
				deps.apexDefinitionsByWorkspace,
				normalizedWorkspace,
			),
			responseRequired: true,
		};
	});
}
