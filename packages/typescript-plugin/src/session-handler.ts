import type * as ts from "typescript/lib/tsserverlibrary";
import {
	type ApexDefinitionFile,
	isApexUpdateRequest,
} from "./lib/salesforce/apex";
import { getProjectRootPath, getRequestPayload } from "./lib/ts";
import WorkspaceContext from "./workspaceContext";

const handledSessions = new WeakSet<ts.server.Session>();

export function setupSessionHandlers(
	session: ts.server.Session | undefined,
	typescript: typeof ts,
) {
	if (!session || handledSessions.has(session)) return;
	handledSessions.add(session);

	const registerHandler = (
		command: string,
		handler: (request: ts.server.protocol.Request) => ts.server.HandlerResponse,
	) => {
		try {
			session.addProtocolHandler(command, handler);
		} catch {}
	};

	registerHandler("_tatzeroko/updateApexTypes", (request) => {
		const payload = getRequestPayload(request);
		if (!isApexUpdateRequest(payload) || !payload.workspace || !payload.files) {
			return { response: { success: false } };
		}

		const normalizedWorkspace = typescript.server.toNormalizedPath(
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
		wsCtx.setDefinitions(typescript, files);
		return {
			response: buildApexStateSnapshot(typescript, normalizedWorkspace),
			responseRequired: true,
		};
	});
}

function buildApexStateSnapshot(typescript: typeof ts, workspace?: string) {
	type ContextEntry = {
		workspace: string;
		project: string;
		projectRootPath: string | null;
		vfs: string[];
		openFiles: string[];
		contains: Array<{
			path: string;
			containsFile: boolean;
			scriptInfo: boolean;
		}>;
	};
	const contexts: ContextEntry[] = [];

	const visitWorkspace = (wsCtx: WorkspaceContext) => {
		const vfsFiles = wsCtx.vfs.list();
		WorkspaceContext.forEachMatchingWorkspace(wsCtx.workspace, (_, project) => {
			contexts.push({
				workspace: wsCtx.workspace,
				project: project.getCurrentDirectory(),
				projectRootPath: getProjectRootPath(project),
				vfs: vfsFiles,
				openFiles: Array.from(project.projectService.openFiles.keys()),
				contains: vfsFiles.map((file) => {
					const normalizedFile = typescript.server.toNormalizedPath(file);
					return {
						path: normalizedFile,
						containsFile: project.containsFile(normalizedFile),
						scriptInfo: !!project.projectService.getScriptInfo(normalizedFile),
					};
				}),
			});
		});
	};

	if (workspace) {
		const wsCtx = WorkspaceContext.resolve(workspace);
		if (wsCtx) visitWorkspace(wsCtx);
	} else {
		for (const wsCtx of WorkspaceContext.all()) {
			visitWorkspace(wsCtx);
		}
	}

	const allContexts = WorkspaceContext.all();
	return {
		success: true,
		workspace: workspace ?? null,
		definitions: allContexts.map((wsCtx) => ({
			workspace: wsCtx.workspace,
			count: wsCtx.definitions.length,
			paths: wsCtx.definitions.map((f) => f.path),
		})),
		contexts,
	};
}
