import * as typescript from "typescript/lib/tsserverlibrary";
import { describe, expect, it } from "vitest";

import ProjectContext from "../src/projectContext";
import WorkspaceContext from "../src/workspaceContext";

describe("ProjectContext", () => {
	it("matches exact and nested workspace roots", () => {
		const host = {} as typescript.LanguageServiceHost;
		const parentWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("/workspace"),
		);
		const parent = new ProjectContext(
			parentWsCtx,
			{} as typescript.server.Project,
			host,
		);

		const childWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("/workspace/sub"),
		);
		const child = new ProjectContext(
			childWsCtx,
			{} as typescript.server.Project,
			host,
		);

		try {
			const parentMatches: string[] = [];
			ProjectContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("/workspace"),
				(workspace, ctx) => {
					parentMatches.push(`${workspace}:${ctx.workspaceCtx.workspace}`);
				},
			);

			expect(parentMatches).toEqual([
				"/workspace:/workspace",
				"/workspace/sub:/workspace/sub",
			]);

			const childMatches: string[] = [];
			ProjectContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("/workspace/sub"),
				(workspace, ctx) => {
					childMatches.push(`${workspace}:${ctx.workspaceCtx.workspace}`);
				},
			);

			expect(childMatches).toEqual([
				"/workspace:/workspace",
				"/workspace/sub:/workspace/sub",
			]);
		} finally {
			parent.dispose();
			child.dispose();
		}
	});

	it("matches normalized windows-style workspace roots", () => {
		const host = {} as typescript.LanguageServiceHost;
		const parentWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("C:\\workspace"),
		);
		const parent = new ProjectContext(
			parentWsCtx,
			{} as typescript.server.Project,
			host,
		);

		const childWsCtx = WorkspaceContext.getOrCreate(
			typescript.server.toNormalizedPath("C:\\workspace\\sub"),
		);
		const child = new ProjectContext(
			childWsCtx,
			{} as typescript.server.Project,
			host,
		);

		try {
			const matches: string[] = [];
			ProjectContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("C:\\workspace"),
				(workspace, ctx) => {
					matches.push(`${workspace}:${ctx.workspaceCtx.workspace}`);
				},
			);

			expect(matches).toEqual([
				"C:/workspace:C:/workspace",
				"C:/workspace/sub:C:/workspace/sub",
			]);
		} finally {
			parent.dispose();
			child.dispose();
		}
	});
});
