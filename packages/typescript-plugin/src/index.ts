import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import { hasEquivalentProjectCounterpart } from "./lib/ts";
import { loadFile, unloadFile } from "./lib/ts/file";
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

	const sessionWithHandlers = new WeakSet<ts.server.Session>();
	const workspaceApexDefinitions = new Map<
		string,
		ReadonlyArray<ApexPayloadFile>
	>();
	const hardcodedApexFiles = new Map<string, ReadonlyArray<ApexPayloadFile>>();

	function create(info: ts.server.PluginCreateInfo) {
		console.log(
			"[tatzeroko-plugin] create",
			info.project.getCurrentDirectory(),
		);
		console.log(
			`[tatzeroko-plugin] create project=${info.project.getProjectName()} cwd=${info.project.getCurrentDirectory()}`,
		);
		info.project.projectService.logger.info(
			`tatzeroko: create plugin for ${info.project.getCurrentDirectory()}`,
		);

		const rawWorkspace = findSalesforceWorkspaceRoot(
			typescript,
			info.project.getCurrentDirectory(),
		);
		if (!rawWorkspace) {
			return info.languageService;
		}
		const workspace = typescript.server.toNormalizedPath(rawWorkspace);
		console.log(`[tatzeroko-plugin] create workspace=${workspace}`);

		const projectName = info.project.getProjectName();
		if (
			projectName.endsWith("jsconfig.json") &&
			hasEquivalentProjectCounterpart(typescript, projectName)
		) {
			console.log(
				`[tatzeroko-plugin] create skipped jsconfig counterpart project=${projectName}`,
			);
			return info.languageService;
		}

		setupSessionHandlers(info.session, info.project.projectService.logger);

		const existingContext = ProjectContext.get(workspace, info.project);
		const context =
			existingContext ??
			new ProjectContext(
				workspace,
				info.project,
				info.languageServiceHost,
				new VirtualFileStore(),
			);
		if (existingContext) {
			console.log(
				`[tatzeroko-plugin] create reusing context workspace=${workspace}`,
			);
			info.project.projectService.logger.info(
				`tatzeroko: reusing plugin context for ${workspace}`,
			);
			return decorateLanguageService(
				workspace,
				typescript,
				info.languageServiceHost,
				info.languageService,
				context.vfs,
				() => {},
				(moduleName) => resolveApexModulePath(workspace, moduleName),
			);
		}

		info.project.projectService.logger.info(
			`tatzeroko: created plugin context for ${workspace}`,
		);
		setHardcodedApexFiles(workspace);
		applyWorkspaceApexFiles(workspace);

		return decorateLanguageService(
			workspace,
			typescript,
			info.languageServiceHost,
			info.languageService,
			context.vfs,
			() => context.dispose(),
			(moduleName) => resolveApexModulePath(workspace, moduleName),
		);
	}

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
				logger.info("tatzeroko: updateApexTypes rejected invalid payload");
				return { response: { success: false } };
			}

			const normalizedWorkspace = typescript.server.toNormalizedPath(
				payload.workspace,
			);
			logger.info(
				`tatzeroko: updateApexTypes workspace=${normalizedWorkspace} files=${payload.files.length}`,
			);
			const files = payload.files.filter(
				(file): file is ApexPayloadFile =>
					!!file &&
					typeof file.path === "string" &&
					typeof file.content === "string" &&
					typeof file.moduleName === "string",
			);
			for (const file of files) {
				logger.info(
					`tatzeroko: updateApexTypes file path=${file.path} module=${file.moduleName} length=${file.content.length}`,
				);
			}
			workspaceApexDefinitions.set(normalizedWorkspace, files);
			seedFilesInProjectService(session, normalizedWorkspace, files);
			applyWorkspaceApexFiles(normalizedWorkspace);
			logger.info(
				`tatzeroko: updateApexTypes applied workspace=${normalizedWorkspace}`,
			);
			return {
				response: buildApexStateSnapshot(normalizedWorkspace),
				responseRequired: true,
			};
		});
	}

	function seedFilesInProjectService(
		session: ts.server.Session | undefined,
		workspace: string,
		files: ReadonlyArray<ApexPayloadFile>,
	) {
		const projectService = (
			session as unknown as { projectService?: ts.server.ProjectService }
		)?.projectService;
		if (!projectService) {
			console.log(
				`[tatzeroko-plugin] seedFilesInProjectService skipped workspace=${workspace} reason=no-project-service`,
			);
			return;
		}

		for (const file of files) {
			const normalizedPath = typescript.server.toNormalizedPath(file.path);
			try {
				projectService.openClientFileWithNormalizedPath(
					normalizedPath,
					file.content,
					typescript.ScriptKind.TS,
					false,
					typescript.server.toNormalizedPath(workspace),
				);
				console.log(
					`[tatzeroko-plugin] seedFilesInProjectService opened path=${normalizedPath} workspace=${workspace}`,
				);
			} catch (error) {
				console.log(
					`[tatzeroko-plugin] seedFilesInProjectService failed path=${normalizedPath} error=${String(error)}`,
				);
			}
		}
	}

	function applyWorkspaceApexFiles(workspace: string) {
		const definitions = [
			...(hardcodedApexFiles.get(workspace) ?? []),
			...(workspaceApexDefinitions.get(workspace) ?? []),
		];
		console.log(
			`[tatzeroko-plugin] applyWorkspaceApexFiles workspace=${workspace} count=${definitions.length}`,
		);
		for (const ctx of getContextsForWorkspace(workspace)) {
			console.log(
				`[tatzeroko-plugin] applyWorkspaceApexFiles context workspace=${workspace} project=${ctx.project.getCurrentDirectory()} existing=${ctx.vfs.list().length}`,
			);
			const nextPaths = new Set(
				definitions.map((definition) => definition.path),
			);
			for (const existingPath of ctx.vfs.list()) {
				if (!nextPaths.has(existingPath)) {
					unloadFile(typescript, ctx.project, existingPath);
					ctx.vfs.delete(existingPath);
				}
			}
			for (const definition of definitions) {
				console.log(
					`[tatzeroko-plugin] applyWorkspaceApexFiles definition path=${definition.path} module=${definition.moduleName} length=${definition.content.length}`,
				);
				ctx.vfs.set(definition.path, definition.content);
				console.log(
					`[tatzeroko-plugin] applyWorkspaceApexFiles vfsSize=${ctx.vfs.list().length}`,
				);
				loadFile(typescript, ctx.project, definition.path, definition.content);
			}
			ctx.project.updateGraph();
		}
		console.log(
			`[tatzeroko-plugin] applyWorkspaceApexFiles done workspace=${workspace}`,
		);
	}

	function setHardcodedApexFiles(workspace: string) {
		console.log(
			`[tatzeroko-plugin] setHardcodedApexFiles workspace=${workspace}`,
		);
		hardcodedApexFiles.set(workspace, [
			{
				path: path.join(
					workspace,
					".tatzeroko",
					"virtual",
					"apex",
					"ContactController.search.d.ts",
				),
				moduleName: "@salesforce/apex/ContactController.search",
				content: `/**
 * Finds contacts matching the query.
 * @param params - The parameters for this call.
 * @return matching contacts.
 */
export default function search(params: {
	query: string;
}): Promise<unknown[]>;`,
			},
		]);
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
			console.log(
				`[tatzeroko-plugin] resolveApexModulePath ignored module=${moduleName}`,
			);
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
		console.log(
			`[tatzeroko-plugin] resolveApexModulePath module=${moduleName} resolved=${resolved}`,
		);
		return resolved;
	}

	function buildApexStateSnapshot(workspace?: string) {
		const workspaces = workspace
			? [workspace]
			: Array.from(
					new Set([
						...hardcodedApexFiles.keys(),
						...workspaceApexDefinitions.keys(),
					]),
				);
		return {
			success: true,
			workspace: workspace ?? null,
			hardcoded: Array.from(hardcodedApexFiles.entries()).map(
				([ws, files]) => ({
					workspace: ws,
					count: files.length,
					paths: files.map((file) => file.path),
				}),
			),
			definitions: Array.from(workspaceApexDefinitions.entries()).map(
				([ws, files]) => ({
					workspace: ws,
					count: files.length,
					paths: files.map((file) => file.path),
				}),
			),
			contexts: workspaces.flatMap((ws) =>
				getContextsForWorkspace(ws).map((ctx) => ({
					workspace: ws,
					project: ctx.project.getCurrentDirectory(),
					projectRootPath:
						(ctx.project as { projectRootPath?: string }).projectRootPath ??
						null,
					vfs: ctx.vfs.list(),
					openFiles: Array.from(ctx.project.projectService.openFiles.keys()),
					contains: Array.from(ctx.vfs.list()).map((file) => {
						const normalizedFile = typescript.server.toNormalizedPath(file);
						return {
							path: normalizedFile,
							containsFile: ctx.project.containsFile(normalizedFile),
							scriptInfo:
								!!ctx.project.projectService.getScriptInfo(normalizedFile),
						};
					}),
				})),
			),
		};
	}

	return {
		create,
		getExternalFiles: (project: ts.server.Project) => {
			console.log(
				"[tatzeroko-plugin] getExternalFiles",
				project.getCurrentDirectory(),
			);
			project.projectService.logger?.info?.(
				`tatzeroko: getExternalFiles for ${project.getCurrentDirectory()}`,
			);
			const rawWorkspace = findSalesforceWorkspaceRoot(
				typescript,
				project.getCurrentDirectory(),
			);
			if (!rawWorkspace) {
				return [];
			}
			const workspace = typescript.server.toNormalizedPath(rawWorkspace);
			console.log(`[tatzeroko-plugin] getExternalFiles workspace=${workspace}`);
			const files: string[] = [];
			project.projectService.logger?.info?.(
				`tatzeroko: seeding files for ${workspace}`,
			);
			setHardcodedApexFiles(workspace);
			const definitions = [
				...(hardcodedApexFiles.get(workspace) ?? []),
				...(workspaceApexDefinitions.get(workspace) ?? []),
			];
			project.projectService.logger?.info?.(
				`tatzeroko: getExternalFiles workspace=${workspace} count=${definitions.length}`,
			);
			for (const definition of definitions) {
				console.log(
					`[tatzeroko-plugin] getExternalFiles definition path=${definition.path} module=${definition.moduleName} length=${definition.content.length}`,
				);
				project.projectService.logger?.info?.(
					`tatzeroko: getExternalFiles loading path=${definition.path} module=${definition.moduleName} length=${definition.content.length}`,
				);
				for (const ctx of getContextsForWorkspace(workspace)) {
					ctx.vfs.set(definition.path, definition.content);
				}
				loadFile(typescript, project, definition.path, definition.content);
				files.push(typescript.server.toNormalizedPath(definition.path));
			}
			for (const [
				ctxWorkspace,
				definitionsForWorkspace,
			] of workspaceApexDefinitions) {
				if (!isWorkspaceMatch(workspace, ctxWorkspace)) {
					continue;
				}
				for (const definition of definitionsForWorkspace) {
					if (
						files.includes(typescript.server.toNormalizedPath(definition.path))
					) {
						console.log(
							`[tatzeroko-plugin] getExternalFiles skip duplicate path=${definition.path}`,
						);
						continue;
					}
					console.log(
						`[tatzeroko-plugin] getExternalFiles extra path=${definition.path} workspace=${ctxWorkspace}`,
					);
					loadFile(typescript, project, definition.path, definition.content);
					files.push(typescript.server.toNormalizedPath(definition.path));
				}
			}
			return files;
		},
	};
}

export = init;
