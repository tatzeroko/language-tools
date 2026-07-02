import type * as ts from "typescript/lib/tsserverlibrary";
import type { ApexDefinitionFile } from "./lib/salesforce/apex";
import { loadFile, unloadFile } from "./lib/ts/file";
import { VirtualFileStore } from "./lib/vfs";

/**
 * Two workspace paths are related if they are identical or one is a direct
 * ancestor of the other. Used to propagate Apex type updates across nested
 * workspace roots (e.g. a mono-repo sub-project).
 */
function isRelatedWorkspace(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export default class WorkspaceContext {
	private static workspaces = new Map<string, WorkspaceContext>();

	readonly workspace: string;
	readonly vfs = new VirtualFileStore();
	private readonly projects = new Map<
		ts.server.Project,
		ts.LanguageServiceHost
	>();
	private _definitions: ReadonlyArray<ApexDefinitionFile> = [];

	private constructor(workspace: string) {
		this.workspace = workspace;
	}

	get definitions(): ReadonlyArray<ApexDefinitionFile> {
		return this._definitions;
	}

	static getOrCreate(workspace: string): WorkspaceContext {
		let ws = WorkspaceContext.workspaces.get(workspace);
		if (!ws) {
			ws = new WorkspaceContext(workspace);
			WorkspaceContext.workspaces.set(workspace, ws);
		}
		return ws;
	}

	/** Returns all currently registered workspace contexts. */
	static all(): ReadonlyArray<WorkspaceContext> {
		return Array.from(WorkspaceContext.workspaces.values());
	}

	/**
	 * Finds the registered workspace related to `candidate` (exact path or
	 * parent/child relationship).
	 */
	static resolve(candidate: string): WorkspaceContext | undefined {
		for (const [, wsCtx] of WorkspaceContext.workspaces) {
			if (isRelatedWorkspace(candidate, wsCtx.workspace)) return wsCtx;
		}
		return undefined;
	}

	/**
	 * Calls `callback` for every project registered in any workspace related
	 * to `workspace` (exact path or parent/child relationship).
	 */
	static forEachMatchingWorkspace(
		workspace: string,
		callback: (
			workspace: string,
			project: ts.server.Project,
			host: ts.LanguageServiceHost,
		) => void,
	) {
		for (const [, wsCtx] of WorkspaceContext.workspaces) {
			if (!isRelatedWorkspace(workspace, wsCtx.workspace)) continue;
			for (const [project, host] of wsCtx.projects) {
				callback(wsCtx.workspace, project, host);
			}
		}
	}

	hasProject(project: ts.server.Project): boolean {
		return this.projects.has(project);
	}

	registerProject(project: ts.server.Project, host: ts.LanguageServiceHost) {
		this.projects.set(project, host);
	}

	unregisterProject(project: ts.server.Project) {
		this.projects.delete(project);
		if (this.projects.size === 0) {
			this.vfs.clear();
			WorkspaceContext.workspaces.delete(this.workspace);
		}
	}

	/**
	 * Replaces the stored definitions and syncs them into the VFS and every
	 * TypeScript project related to this workspace. Removes stale files and
	 * triggers a project graph update.
	 */
	setDefinitions(
		typescript: typeof ts,
		files: ReadonlyArray<ApexDefinitionFile>,
	) {
		this._definitions = files;
		this.syncFiles(typescript, files);
	}

	private syncFiles(
		typescript: typeof ts,
		files: ReadonlyArray<{ path: string; content: string }>,
	) {
		const nextPaths = new Set(files.map((f) => f.path));
		const oldPaths = new Set(this.vfs.list());

		for (const oldPath of oldPaths) {
			if (!nextPaths.has(oldPath)) this.vfs.delete(oldPath);
		}
		for (const file of files) {
			this.vfs.set(file.path, file.content);
		}

		WorkspaceContext.forEachMatchingWorkspace(this.workspace, (_, project) => {
			for (const oldPath of oldPaths) {
				if (!nextPaths.has(oldPath)) unloadFile(typescript, project, oldPath);
			}
			for (const file of files) {
				loadFile(typescript, project, file.path, file.content);
			}
			project.updateGraph();
		});
	}
}
