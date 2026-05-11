import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import {
	type ApexDefinitionFile,
	resolveApexModulePath,
} from "./lib/salesforce/apex";
import { applyWorkspaceApexFiles } from "./lib/salesforce/workspace";
import { setupSessionHandlers } from "./lib/session-handler";
import { hasEquivalentProjectCounterpart } from "./lib/ts";
import { loadFile } from "./lib/ts/file";
import ProjectContext from "./projectContext";
import WorkspaceContext from "./workspaceContext";

function init(modules: { typescript: typeof ts }) {
	const { typescript } = modules;

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

		setupSessionHandlers(info.session, {
			typescript,
			apexDefinitionsByWorkspace,
			applyWorkspaceApexFiles: (ws) =>
				applyWorkspaceApexFiles(typescript, apexDefinitionsByWorkspace, ws),
		});

		const workspaceCtx = WorkspaceContext.getOrCreate(workspace);
		const existingContext = ProjectContext.get(workspace, info.project);
		const context =
			existingContext ??
			new ProjectContext(workspaceCtx, info.project, info.languageServiceHost);
		if (!existingContext) {
			applyWorkspaceApexFiles(
				typescript,
				apexDefinitionsByWorkspace,
				workspace,
			);
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

	function getExternalFiles(project: ts.server.Project) {
		const rawWorkspace = findSalesforceWorkspaceRoot(
			typescript,
			project.getCurrentDirectory(),
		);
		if (!rawWorkspace) {
			return [];
		}
		const workspace = typescript.server.toNormalizedPath(rawWorkspace);
		const definitions = apexDefinitionsByWorkspace.get(workspace) ?? [];
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
