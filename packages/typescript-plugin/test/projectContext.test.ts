import * as typescript from "typescript/lib/tsserverlibrary";
import { describe, expect, it } from "vitest";

import WorkspaceContext from "../src/workspaceContext";

describe("WorkspaceContext project registration", () => {
	it("matches exact and nested workspace roots", () => {
		const host = {} as typescript.LanguageServiceHost;
		const parentProject = {} as typescript.server.Project;
		const childProject = {} as typescript.server.Project;

		const parentWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("/workspace"),
		);
		parentWsCtx.registerProject(parentProject, host);

		const childWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("/workspace/sub"),
		);
		childWsCtx.registerProject(childProject, host);

		try {
			const parentMatches: string[] = [];
			WorkspaceContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("/workspace"),
				(workspace) => {
					parentMatches.push(workspace);
				},
			);

			expect(parentMatches).toEqual(["/workspace", "/workspace/sub"]);

			const childMatches: string[] = [];
			WorkspaceContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("/workspace/sub"),
				(workspace) => {
					childMatches.push(workspace);
				},
			);

			expect(childMatches).toEqual(["/workspace", "/workspace/sub"]);
		} finally {
			parentWsCtx.unregisterProject(parentProject);
			childWsCtx.unregisterProject(childProject);
		}
	});

	it("matches normalized windows-style workspace roots", () => {
		const host = {} as typescript.LanguageServiceHost;
		const parentProject = {} as typescript.server.Project;
		const childProject = {} as typescript.server.Project;

		const parentWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("C:\\workspace"),
		);
		parentWsCtx.registerProject(parentProject, host);

		const childWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("C:\\workspace\\sub"),
		);
		childWsCtx.registerProject(childProject, host);

		try {
			const matches: string[] = [];
			WorkspaceContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("C:\\workspace"),
				(workspace) => {
					matches.push(workspace);
				},
			);

			expect(matches).toEqual(["C:/workspace", "C:/workspace/sub"]);
		} finally {
			parentWsCtx.unregisterProject(parentProject);
			childWsCtx.unregisterProject(childProject);
		}
	});
});
