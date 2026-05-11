import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import { hasEquivalentProjectCounterpart } from "./lib/ts";
import { loadFile, unloadFile } from "./lib/ts/file";
import ProjectContext from "./projectContext";
import WorkspaceContext from "./workspaceContext";

type ApexDefinitionFile = {
	readonly path: string;
	readonly content: string;
	readonly moduleName: string;
};

type ApexUpdateRequest = {
	readonly workspace?: string;
	readonly files?: ReadonlyArray<ApexDefinitionFile>;
};

function getRequestPayload(request: ts.server.protocol.Request): unknown {
	const candidate = Array.isArray(request.arguments)
		? request.arguments[0]
		: request.arguments;
	return candidate;
}

function getProjectRootPath(project: ts.server.Project) {
	const candidate = project as { projectRootPath?: unknown };
	return typeof candidate.projectRootPath === "string"
		? candidate.projectRootPath
		: null;
}

function isApexUpdateRequest(value: unknown): value is ApexUpdateRequest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ApexUpdateRequest;
	return (
		(candidate.workspace === undefined ||
			typeof candidate.workspace === "string") &&
		(candidate.files === undefined || Array.isArray(candidate.files))
	);
}

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
			(moduleName: string) => resolveApexModulePath(workspace, moduleName),
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

	function resolveApexModulePath(workspace: string, moduleName: string) {
		if (!moduleName.startsWith("@salesforce/apex/")) {
			return undefined;
		}
		const resolved = typescript.server.toNormalizedPath(
			path.join(
				workspace,
				".tatzeroko",
				"virtual",
				"apex",
				`${moduleName.slice("@salesforce/apex/".length)}.d.ts`,
			),
		);
		return resolved;
	}

	function buildApexStateSnapshot(workspace?: string) {
		const contexts: Array<{
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
		}> = [];
		const visitCanonicalWorkspace = (ws: string) => {
			const wsCtx = WorkspaceContext.resolve(ws) ?? WorkspaceContext.get(ws);
			const vfsFiles = wsCtx?.vfs.list() ?? [];
			const canonical = wsCtx?.workspace ?? ws;
			ProjectContext.forEachMatchingWorkspace(canonical, (_, ctx) => {
				contexts.push({
					workspace: canonical,
					project: ctx.project.getCurrentDirectory(),
					projectRootPath: getProjectRootPath(ctx.project),
					vfs: vfsFiles,
					openFiles: Array.from(ctx.project.projectService.openFiles.keys()),
					contains: vfsFiles.map((file) => {
						const normalizedFile = typescript.server.toNormalizedPath(file);
						return {
							path: normalizedFile,
							containsFile: ctx.project.containsFile(normalizedFile),
							scriptInfo:
								!!ctx.project.projectService.getScriptInfo(normalizedFile),
						};
					}),
				});
			});
		};
		if (workspace) {
			visitCanonicalWorkspace(workspace);
		} else {
			for (const ws of apexDefinitionsByWorkspace.keys()) {
				visitCanonicalWorkspace(ws);
			}
		}
		return {
			success: true,
			workspace: workspace ?? null,
			definitions: Array.from(apexDefinitionsByWorkspace.entries()).map(
				([ws, files]) => ({
					workspace: ws,
					count: files.length,
					paths: files.map((file) => file.path),
				}),
			),
			contexts,
		};
	}

	return {
		create,
		getExternalFiles: (project: ts.server.Project) => {
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
		},
	};
}

export = init;
