import * as typescript from "typescript/lib/tsserverlibrary";
import { describe, expect, it } from "vitest";

import ProjectContext from "../src/projectContext";
import { VirtualFileStore } from "../src/vfs";

describe("ProjectContext", () => {
	it("matches exact and nested workspace roots", () => {
		const host = {} as typescript.LanguageServiceHost;
		const parent = new ProjectContext(
			typescript.server.toNormalizedPath("/workspace"),
			{} as typescript.server.Project,
			host,
			new VirtualFileStore(),
		);
		const child = new ProjectContext(
			typescript.server.toNormalizedPath("/workspace/sub"),
			{} as typescript.server.Project,
			host,
			new VirtualFileStore(),
		);

		try {
			const parentMatches: string[] = [];
			ProjectContext.forEachMatchingWorkspace(
				typescript.server.toNormalizedPath("/workspace"),
				(workspace, ctx) => {
					parentMatches.push(`${workspace}:${ctx.workspace}`);
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
					childMatches.push(`${workspace}:${ctx.workspace}`);
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
});
