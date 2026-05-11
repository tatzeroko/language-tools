import type * as ts from "typescript/lib/tsserverlibrary";
import type { VirtualFileStore } from "./vfs";
import type WorkspaceContext from "./workspaceContext";

export default class ProjectContext {
	private static readonly workspaces = new Map<
		string,
		Map<ts.server.Project, ProjectContext>
	>();

	private static ensureWorkspace(workspace: string) {
		let entry = ProjectContext.workspaces.get(workspace);
		if (!entry) {
			entry = new Map();
			ProjectContext.workspaces.set(workspace, entry);
		}
		return entry;
	}

	private static register(
		workspace: string,
		project: ts.server.Project,
		ctx: ProjectContext,
	) {
		const ws = ProjectContext.ensureWorkspace(workspace);
		ws.set(project, ctx);
	}

	private static unregister(workspace: string, project: ts.server.Project) {
		const ws = ProjectContext.workspaces.get(workspace);
		ws?.delete(project);

		if (ws && ws.size === 0) {
			ProjectContext.workspaces.delete(workspace);
		}
	}

	static get(workspace: string, project: ts.server.Project) {
		return ProjectContext.workspaces.get(workspace)?.get(project);
	}

	static forEachMatchingWorkspace(
		workspace: string,
		callback: (workspace: string, ctx: ProjectContext) => void,
	) {
		for (const [ctxWorkspace, ws] of ProjectContext.workspaces) {
			if (
				workspace !== ctxWorkspace &&
				!workspace.startsWith(`${ctxWorkspace}/`) &&
				!ctxWorkspace.startsWith(`${workspace}/`)
			) {
				continue;
			}
			for (const ctx of ws.values()) {
				callback(ctxWorkspace, ctx);
			}
		}
	}

	readonly workspaceCtx: WorkspaceContext;

	constructor(
		workspaceCtx: WorkspaceContext,
		readonly project: ts.server.Project,
		readonly host: ts.LanguageServiceHost,
	) {
		this.workspaceCtx = workspaceCtx;
		ProjectContext.register(workspaceCtx.workspace, project, this);
		workspaceCtx.registerProject(project, this);
	}

	get vfs(): VirtualFileStore {
		return this.workspaceCtx.vfs;
	}

	dispose() {
		this.workspaceCtx.unregisterProject(this.project);
		try {
			ProjectContext.unregister(this.workspaceCtx.workspace, this.project);
		} catch {
			/** ignore errors during shutdown (e.g. project already disposed) */
		}
	}
}
