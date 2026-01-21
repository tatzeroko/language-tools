import type * as ts from "typescript/lib/tsserverlibrary";
import { decorateLanguageService } from "./language-service";
import { findSalesforceWorkspaceRoot } from "./lib/salesforce";
import { hasEquivalentProjectCounterpart } from "./lib/ts";
import ProjectContext from "./projectContext";
import { VirtualFileStore } from "./vfs";

function init(modules: { typescript: typeof ts }) {
	const { typescript } = modules;

	/** Tracks sessions that have had handlers added */
	const sessionWithHandlers = new WeakSet<ts.server.Session>();

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

		setupSessionHandlers(info.session);

		const existingContext = ProjectContext.get(
			workspace,
			info.project.getProjectName(),
		);
		if (existingContext) {
			return info.languageService;
		}

		const vfs = new VirtualFileStore();
		const context = new ProjectContext(
			workspace,
			info.project,
			info.languageServiceHost,
			vfs,
		);

		return decorateLanguageService(
			workspace,
			typescript,
			info.languageServiceHost,
			info.languageService,
			vfs,
			() => context.dispose(),
		);
	}

	/**
	 * @param session The TypeScript server session instance.
	 */
	function setupSessionHandlers(session: ts.server.Session | undefined) {
		if (!session || sessionWithHandlers.has(session)) return;
		sessionWithHandlers.add(session);

		// note: Placeholder for future session protocol handlers
		/*session.addProtocolHandler("<specifier>", (request) => {
			return {
				response: { message: "<message>" },
				responseRequired: true,
			};
		});*/
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
		const context = ProjectContext.get(workspace, project.getProjectName());
		return context?.vfs.list() ?? [];
	}

	return { create, getExternalFiles };
}

export = init;
