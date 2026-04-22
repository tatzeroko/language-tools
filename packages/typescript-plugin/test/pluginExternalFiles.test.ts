import type * as ts from "typescript/lib/tsserverlibrary";
import * as typescript from "typescript/lib/tsserverlibrary";
import { describe, expect, it, vi } from "vitest";
import { loadFile } from "../src/lib/ts/file";

const virtualContent = `/**
 * Finds contacts matching the query.
 * @param params - The parameters for this call.
 * @return matching contacts.
 */
export default function search(params: {
	query: string;
}): Promise<unknown[]>;`;

describe("plugin external files", () => {
	it("loads an existing script info from project.readFile", () => {
		const normalizedPath = typescript.server.toNormalizedPath(
			"/workspace/.tatzeroko/virtual/apex/ContactController.search.d.ts",
		);
		const addRoot = vi.fn();
		const readFile = vi.fn(() => virtualContent);
		const getOrCreateScriptInfoForNormalizedPath = vi.fn(() => ({
			path: normalizedPath,
		}));
		const project = {
			containsFile: () => true,
			readFile,
			projectService: {
				getOrCreateScriptInfoForNormalizedPath,
				openFiles: new Map<string, undefined>(),
			},
			addRoot,
		} as never as ts.server.Project;

		loadFile(typescript, project, normalizedPath);

		expect(readFile).toHaveBeenCalledWith(normalizedPath);
		expect(getOrCreateScriptInfoForNormalizedPath).toHaveBeenCalledWith(
			normalizedPath,
			true,
			virtualContent,
		);
		expect(addRoot).toHaveBeenCalledWith({ path: normalizedPath });
	});

	it("refreshes an existing script info when content changes", () => {
		const normalizedPath = typescript.server.toNormalizedPath(
			"/workspace/.tatzeroko/virtual/apex/ContactController.search.d.ts",
		);
		const addRoot = vi.fn();
		const editContent = vi.fn();
		const getSnapshot = vi.fn(() => ({
			getLength: () => 18,
			getText: () => "export default old",
		}));
		const getOrCreateScriptInfoForNormalizedPath = vi.fn(() => ({
			path: normalizedPath,
			getSnapshot,
			editContent,
		}));
		const project = {
			containsFile: () => true,
			readFile: vi.fn(),
			projectService: {
				getOrCreateScriptInfoForNormalizedPath,
				openFiles: new Map<string, undefined>(),
			},
			addRoot,
		} as never as ts.server.Project;

		loadFile(
			typescript,
			project,
			normalizedPath,
			"export default function search(params: { query: string }): Promise<unknown[]>;",
		);

		expect(editContent).toHaveBeenCalledWith(
			0,
			18,
			"export default function search(params: { query: string }): Promise<unknown[]>;",
		);
		expect(addRoot).toHaveBeenCalled();
	});
});
