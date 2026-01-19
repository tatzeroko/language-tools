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
	 * @param typescript The TypeScript module reference provided by the plugin.
	 * @param workspace The Salesforce workspace root path.
	 */
	private static ensureWorkspace(typescript: typeof ts, workspace: string) {
		const normalized = typescript.server.toNormalizedPath(workspace);
		let entry = ProjectContext.workspaces.get(normalized);
		if (!entry) {
			entry = new Map();
			ProjectContext.workspaces.set(normalized, entry);
		}
		return entry;
	}

	/**
	 * Registers a new ProjectContext instance.
	 *
	 * @param typescript The TypeScript module reference provided by the plugin.
	 * @param workspace The Salesforce workspace root path.
	 * @param projectName The name of the TypeScript project.
	 * @param ctx The ProjectContext instance to register.
	 */
	private static register(
		typescript: typeof ts,
		workspace: string,
		projectName: string,
		ctx: ProjectContext,
	) {
		const normalizedWorkspace = typescript.server.toNormalizedPath(workspace);
		const normalizedProject = typescript.server.toNormalizedPath(projectName);
		const ws = ProjectContext.ensureWorkspace(typescript, normalizedWorkspace);
		ws.set(normalizedProject, ctx);
	}

	/**
	 * Unregisters a ProjectContext instance.
	 *
	 * @param typescript The TypeScript module reference provided by the plugin.
	 * @param workspace The Salesforce workspace root path.
	 * @param projectName The name of the TypeScript project.
	 */
	private static unregister(
		typescript: typeof ts,
		workspace: string,
		projectName: string,
	) {
		const normalizedWorkspace = typescript.server.toNormalizedPath(workspace);
		const normalizedProject = typescript.server.toNormalizedPath(projectName);

		const ws = ProjectContext.workspaces.get(normalizedWorkspace);
		ws?.delete(normalizedProject);

		if (ws && ws.size === 0) {
			ProjectContext.workspaces.delete(normalizedWorkspace);
		}
	}

	/**
	 * Retrieves a specific ProjectContext instance.
	 *
	 * @param typescript The TypeScript module reference provided by the plugin.
	 * @param workspace The Salesforce workspace root path.
	 * @param projectName The name of the TypeScript project.
	 */
	static get(typescript: typeof ts, workspace: string, projectName: string) {
		const normalizedWorkspace = typescript.server.toNormalizedPath(workspace);
		const normalizedProject = typescript.server.toNormalizedPath(projectName);
		return ProjectContext.workspaces
			.get(normalizedWorkspace)
			?.get(normalizedProject);
	}

	/**
	 * Retrieves all contexts within a given Salesforce workspace.
	 *
	 * @param typescript The TypeScript module reference provided by the plugin.
	 * @param workspace The Salesforce workspace root path.
	 */
	static getAllInWorkspace(typescript: typeof ts, workspace: string) {
		const normalizedWorkspace = typescript.server.toNormalizedPath(workspace);
		const ws = ProjectContext.workspaces.get(normalizedWorkspace);
		return ws ? Array.from(ws.values()) : [];
	}

	/**
	 * Retrieves the global registry of all workspaces.
	 */
	static getAllWorkspaces() {
		return ProjectContext.workspaces;
	}

	readonly workspace: string;

	/**
	 * @param workspace The Salesforce workspace root path.
	 * @param typescript The TypeScript module reference provided by the plugin.
	 * @param project The TypeScript server project instance.
	 * @param host The TypeScript Language Service Host instance.
	 * @param vfs The Virtual File Store instance for managing virtual files.
	 */
	constructor(
		workspace: string,
		readonly typescript: typeof ts,
		readonly project: ts.server.Project,
		readonly host: ts.LanguageServiceHost,
		readonly vfs: VirtualFileStore,
	) {
		this.workspace = this.typescript.server.toNormalizedPath(workspace);

		const normalizedProjectName = this.typescript.server.toNormalizedPath(
			this.project.getProjectName(),
		);
		ProjectContext.register(
			this.typescript,
			this.workspace,
			normalizedProjectName,
			this,
		);
	}

	/**
	 * Disposes of the project context, cleaning up resources and unregistering it.
	 */
	dispose() {
		try {
			const normalizedProjectName = this.typescript.server.toNormalizedPath(
				this.project.getProjectName(),
			);
			ProjectContext.unregister(
				this.typescript,
				this.workspace,
				normalizedProjectName,
			);
		} catch {
			/** ignore errors during shutdown (e.g. project already disposed) */
		}

		this.vfs.clear();
	}
}
