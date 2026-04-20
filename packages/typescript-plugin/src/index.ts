import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import { hasEquivalentProjectCounterpart } from "./lib/ts";
import ProjectContext from "./projectContext";
import { VirtualFileStore } from "./vfs";

type ApexPayloadFile = {
	readonly path: string;
	readonly content: string;
	readonly moduleName: string;
};

type ApexUpdateRequest = {
	readonly workspace?: string;
	readonly files?: ReadonlyArray<ApexPayloadFile>;
};

function getRequestPayload<T>(
	request: ts.server.protocol.Request,
): T | undefined {
	const candidate = Array.isArray(request.arguments)
		? request.arguments[0]
		: request.arguments;
	return candidate as T | undefined;
}

function init(modules: { typescript: typeof ts }) {
	const { typescript } = modules;

	/** Tracks sessions that have had handlers added */
	const sessionWithHandlers = new WeakSet<ts.server.Session>();
	const workspaceApexDefinitions = new Map<
		string,
		ReadonlyArray<ApexPayloadFile>
	>();

	function create(info: ts.server.PluginCreateInfo) {
		const rawWorkspace = findSalesforceWorkspaceRoot(
			typescript,
			info.project.getCurrentDirectory(),
		);
		if (!rawWorkspace) {
			return info.languageService;
		}
		const workspace = typescript.server.toNormalizedPath(rawWorkspace);

		/**
		 * If both `jsconfig.json` and `tsconfig.json` exist in the same project directory,
		 * prefer `tsconfig.json` and ignore the `jsconfig.json` project.
		 *
		 * This mirrors TypeScript's own project resolution behavior and prevents
		 * duplicate project contexts and potential conflicts.
		 */
		const projectName = info.project.getProjectName();
		if (
			projectName.endsWith("jsconfig.json") &&
			hasEquivalentProjectCounterpart(typescript, projectName)
		) {
			return info.languageService;
		}

		setupSessionHandlers(info.session, info.project.projectService.logger);

		const existingContext = ProjectContext.get(workspace, info.project);
		if (existingContext) {
			applyWorkspaceApexFiles(workspace);
			return info.languageService;
		}

		const vfs = new VirtualFileStore();
		const context = new ProjectContext(
			workspace,
			info.project,
			info.languageServiceHost,
			vfs,
		);
		applyWorkspaceApexFiles(workspace);

		return decorateLanguageService(
			workspace,
			typescript,
			info.languageServiceHost,
			info.languageService,
			vfs,
			() => context.dispose(),
			(moduleName) => resolveApexModulePath(workspace, moduleName),
		);
	}

	/**
	 * @param session The TypeScript server session instance.
	 */
	function setupSessionHandlers(
		session: ts.server.Session | undefined,
		logger: ts.server.Logger,
	) {
		if (!session || sessionWithHandlers.has(session)) return;
		sessionWithHandlers.add(session);

		const registerHandler = (
			command: string,
			handler: (
				request: ts.server.protocol.Request,
			) => ts.server.HandlerResponse,
		) => {
			try {
				session.addProtocolHandler(command, handler);
			} catch (error) {
				logger.info(
					`tatzeroko: typescript-plugin skip duplicate ${command} handler ${error}`,
				);
			}
		};

		registerHandler("_tatzeroko/updateApexTypes", (request) => {
			const payload = getRequestPayload<ApexUpdateRequest>(request);
			if (!payload?.workspace || !Array.isArray(payload.files)) {
				return { response: { success: false } };
			}

			const normalizedWorkspace = typescript.server.toNormalizedPath(
				payload.workspace,
			);
			const files = payload.files.filter(
				(file): file is ApexPayloadFile =>
					!!file &&
					typeof file.path === "string" &&
					typeof file.content === "string" &&
					typeof file.moduleName === "string",
			);
			workspaceApexDefinitions.set(normalizedWorkspace, files);
			applyWorkspaceApexFiles(normalizedWorkspace);
			return { response: { success: true }, responseRequired: true };
		});
	}

	function applyWorkspaceApexFiles(workspace: string) {
		const definitions = workspaceApexDefinitions.get(workspace) ?? [];
		for (const ctx of getContextsForWorkspace(workspace)) {
			for (const definition of definitions) {
				ctx.vfs.set(definition.path, definition.content);
			}
		}
	}

	function getContextsForWorkspace(workspace: string) {
		const contexts: ProjectContext[] = [];
		for (const [ctxWorkspace, map] of ProjectContext.getAllWorkspaces()) {
			if (isWorkspaceMatch(workspace, ctxWorkspace)) {
				contexts.push(...map.values());
			}
		}
		return contexts;
	}

	function isWorkspaceMatch(workspace: string, ctxWorkspace: string) {
		return (
			workspace === ctxWorkspace ||
			workspace.startsWith(`${ctxWorkspace}/`) ||
			ctxWorkspace.startsWith(`${workspace}/`)
		);
	}

	function resolveApexModulePath(workspace: string, moduleName: string) {
		if (!moduleName.startsWith("@salesforce/apex/")) {
			return undefined;
		}
		return typescript.server.toNormalizedPath(
			path.join(
				workspace,
				".tatzeroko",
				"virtual",
				"apex",
				`${moduleName.slice("@salesforce/apex/".length)}.d.ts`,
			),
		);
	}

	return { create, getExternalFiles: () => [] };
}

export = init;
