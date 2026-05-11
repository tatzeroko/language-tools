import type * as ts from "typescript/lib/tsserverlibrary";
import type ProjectContext from "./projectContext";
import { VirtualFileStore } from "./vfs";

export default class WorkspaceContext {
	private static workspaces = new Map<string, WorkspaceContext>();

	readonly workspace: string;
	readonly vfs = new VirtualFileStore();
	readonly projects = new Map<ts.server.Project, ProjectContext>();

	private constructor(workspace: string) {
		this.workspace = workspace;
	}

	static getOrCreate(workspace: string): WorkspaceContext {
		let ws = WorkspaceContext.workspaces.get(workspace);
		if (!ws) {
			ws = new WorkspaceContext(workspace);
			WorkspaceContext.workspaces.set(workspace, ws);
		}
		return ws;
	}

	static get(workspace: string): WorkspaceContext | undefined {
		return WorkspaceContext.workspaces.get(workspace);
	}

	static resolve(candidate: string): WorkspaceContext | undefined {
		for (const [, wsCtx] of WorkspaceContext.workspaces) {
			const key = wsCtx.workspace;
			if (
				candidate === key ||
				candidate.startsWith(`${key}/`) ||
				key.startsWith(`${candidate}/`)
			) {
				return wsCtx;
			}
		}
		return undefined;
	}

	registerProject(project: ts.server.Project, ctx: ProjectContext) {
		this.projects.set(project, ctx);
	}

	unregisterProject(project: ts.server.Project) {
		this.projects.delete(project);
		if (this.projects.size === 0) {
			this.vfs.clear();
			WorkspaceContext.workspaces.delete(this.workspace);
		}
	}
}
