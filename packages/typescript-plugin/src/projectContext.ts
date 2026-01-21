import type * as ts from "typescript/lib/tsserverlibrary";
import type { VirtualFileStore } from "./vfs";

/**
 * Represents a single TypeScript project context within a Salesforce workspace.
 */
export default class ProjectContext {
	/**
	 * Registry of all ProjectContext instances, organized by Salesforce workspace root.
	 *
	 * @description
	 * Structure:
	 * ```
	 * {
	 *   "<sf-root>": Map<"<project-name>", ProjectContext>
	 * }
	 * ```
	 */
	private static readonly workspaces = new Map<
		string,
		Map<string, ProjectContext>
	>();

	/**
	 * Ensures that a workspace entry exists in the global registry.
	 *
	 * @param workspace The Salesforce workspace root path.
	 */
	private static ensureWorkspace(workspace: string) {
		let entry = ProjectContext.workspaces.get(workspace);
		if (!entry) {
			entry = new Map();
			ProjectContext.workspaces.set(workspace, entry);
		}
		return entry;
	}

	/**
	 * Registers a new ProjectContext instance.
	 *
	 * @param workspace The Salesforce workspace root path.
	 * @param projectName The name of the TypeScript project.
	 * @param ctx The ProjectContext instance to register.
	 */
	private static register(
		workspace: string,
		projectName: string,
		ctx: ProjectContext,
	) {
		const ws = ProjectContext.ensureWorkspace(workspace);
		ws.set(projectName, ctx);
	}

	/**
	 * Unregisters a ProjectContext instance.
	 *
	 * @param workspace The Salesforce workspace root path.
	 * @param projectName The name of the TypeScript project.
	 */
	private static unregister(workspace: string, projectName: string) {
		const ws = ProjectContext.workspaces.get(workspace);
		ws?.delete(projectName);

		if (ws && ws.size === 0) {
			ProjectContext.workspaces.delete(workspace);
		}
	}

	/**
	 * Retrieves a specific ProjectContext instance.
	 *
	 * @param workspace The Salesforce workspace root path.
	 * @param projectName The name of the TypeScript project.
	 */
	static get(workspace: string, projectName: string) {
		return ProjectContext.workspaces.get(workspace)?.get(projectName);
	}

	/**
	 * Retrieves all contexts within a given Salesforce workspace.
	 *
	 * @param workspace The Salesforce workspace root path.
	 */
	static getAllInWorkspace(workspace: string) {
		const ws = ProjectContext.workspaces.get(workspace);
		return ws ? Array.from(ws.values()) : [];
	}

	/**
	 * Retrieves the global registry of all workspaces.
	 */
	static getAllWorkspaces() {
		return ProjectContext.workspaces;
	}

	/**
	 * @param workspace The Salesforce workspace root path.
	 * @param project The TypeScript server project instance.
	 * @param host The TypeScript Language Service Host instance.
	 * @param vfs The Virtual File Store instance for managing virtual files.
	 */
	constructor(
		readonly workspace: string,
		readonly project: ts.server.Project,
		readonly host: ts.LanguageServiceHost,
		readonly vfs: VirtualFileStore,
	) {
		ProjectContext.register(
			this.workspace,
			this.project.getProjectName(),
			this,
		);
	}

	/**
	 * Disposes of the project context, cleaning up resources and unregistering it.
	 */
	dispose() {
		try {
			ProjectContext.unregister(this.workspace, this.project.getProjectName());
		} catch {
			/** ignore errors during shutdown (e.g. project already disposed) */
		}

		this.vfs.clear();
	}
}
