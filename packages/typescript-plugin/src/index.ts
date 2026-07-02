import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import { hasEquivalentProjectCounterpart } from "./lib/ts";
import { loadFile } from "./lib/ts/file";
import { setupSessionHandlers } from "./session-handler";
import WorkspaceContext from "./workspaceContext";

function init(modules: { typescript: typeof ts }) {
	const { typescript } = modules;

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

		setupSessionHandlers(info.session, typescript);

		const workspaceCtx = WorkspaceContext.getOrCreate(workspace);
		const isNew = !workspaceCtx.hasProject(info.project);
		workspaceCtx.registerProject(info.project, info.languageServiceHost);
		if (isNew) {
			workspaceCtx.setDefinitions(typescript, workspaceCtx.definitions);
		}

		return decorateLanguageService(
			workspace,
			typescript,
			info.languageServiceHost,
			info.languageService,
			workspaceCtx.vfs,
			info.project,
			info.project.projectService,
			() => workspaceCtx.unregisterProject(info.project),
		);
	}

	function getExternalFiles(project: ts.server.Project) {
		const rawWorkspace = findSalesforceWorkspaceRoot(
			typescript,
			project.getCurrentDirectory(),
		);
		if (!rawWorkspace) {
			return [];
		}
		const workspace = typescript.server.toNormalizedPath(rawWorkspace);
		const definitions = WorkspaceContext.resolve(workspace)?.definitions ?? [];
		const files: string[] = [];
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
