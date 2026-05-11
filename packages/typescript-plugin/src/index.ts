import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import {
	type ApexDefinitionFile,
	buildApexStateSnapshot as buildApexStateSnapshotImpl,
	isApexUpdateRequest,
	resolveApexModulePath,
} from "./lib/salesforce/apex";
import { getRequestPayload, hasEquivalentProjectCounterpart } from "./lib/ts";
import { loadFile, unloadFile } from "./lib/ts/file";
import ProjectContext from "./projectContext";
import WorkspaceContext from "./workspaceContext";

function init(modules: { typescript: typeof ts }) {
	const { typescript } = modules;

	const handledSessions = new WeakSet<ts.server.Session>();
	const apexDefinitionsByWorkspace = new Map<
		string,
		ReadonlyArray<ApexDefinitionFile>
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

		const projectName = info.project.getProjectName();
		if (
			projectName.endsWith("jsconfig.json") &&
			hasEquivalentProjectCounterpart(typescript, projectName)
		) {
			return info.languageService;
		}

		setupSessionHandlers(info.session);

		const workspaceCtx = WorkspaceContext.getOrCreate(workspace);
		const existingContext = ProjectContext.get(workspace, info.project);
		const context =
			existingContext ??
			new ProjectContext(workspaceCtx, info.project, info.languageServiceHost);
		if (!existingContext) {
			applyWorkspaceApexFiles(workspace);
		}

		return decorateLanguageService(
			workspace,
			typescript,
			info.languageServiceHost,
			info.languageService,
			workspaceCtx.vfs,
			info.project,
			info.project.projectService,
			existingContext ? () => {} : () => context.dispose(),
			(moduleName: string) =>
				resolveApexModulePath(typescript, workspace, moduleName),
		);
	}

	function setupSessionHandlers(session: ts.server.Session | undefined) {
		if (!session || handledSessions.has(session)) return;
		handledSessions.add(session);

		const registerHandler = (
			command: string,
			handler: (
				request: ts.server.protocol.Request,
			) => ts.server.HandlerResponse,
		) => {
			try {
				session.addProtocolHandler(command, handler);
			} catch {
				return;
			}
		};

		registerHandler("_tatzeroko/updateApexTypes", (request) => {
			const payload = getRequestPayload(request);
			if (
				!isApexUpdateRequest(payload) ||
				!payload.workspace ||
				!payload.files
			) {
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
			const canonical = wsCtx.workspace;
			apexDefinitionsByWorkspace.set(canonical, files);
			applyWorkspaceApexFiles(canonical);
			return {
				response: buildApexStateSnapshot(normalizedWorkspace),
				responseRequired: true,
			};
		});
	}

	function applyWorkspaceApexFiles(workspace: string) {
		const wsCtx =
			WorkspaceContext.resolve(workspace) ??
			WorkspaceContext.getOrCreate(workspace);
		const canonical = wsCtx.workspace;

		const definitions = apexDefinitionsByWorkspace.get(canonical) ?? [];
		const nextPaths = new Set(definitions.map((definition) => definition.path));
		const oldPaths = new Set(wsCtx.vfs.list());

		for (const oldPath of oldPaths) {
			if (!nextPaths.has(oldPath)) {
				wsCtx.vfs.delete(oldPath);
			}
		}
		for (const definition of definitions) {
			wsCtx.vfs.set(definition.path, definition.content);
		}

		ProjectContext.forEachMatchingWorkspace(canonical, (_, ctx) => {
			for (const oldPath of oldPaths) {
				if (!nextPaths.has(oldPath)) {
					unloadFile(typescript, ctx.project, oldPath);
				}
			}
			for (const definition of definitions) {
				loadFile(typescript, ctx.project, definition.path, definition.content);
			}
			ctx.project.updateGraph();
		});
	}

	const buildApexStateSnapshot = (workspace?: string) =>
		buildApexStateSnapshotImpl(
			typescript,
			apexDefinitionsByWorkspace,
			workspace,
		);

	function getExternalFiles(project: ts.server.Project) {
		const rawWorkspace = findSalesforceWorkspaceRoot(
			typescript,
			project.getCurrentDirectory(),
		);
		if (!rawWorkspace) {
			return [];
		}
		const workspace = typescript.server.toNormalizedPath(rawWorkspace);

		const files: string[] = [];
		const definitions = apexDefinitionsByWorkspace.get(workspace) ?? [];
		for (const definition of definitions) {
			loadFile(typescript, project, definition.path, definition.content);
			files.push(typescript.server.toNormalizedPath(definition.path));
		}
		return files;
	}

	return {
		create,
		getExternalFiles,
	};
}

export = init;
