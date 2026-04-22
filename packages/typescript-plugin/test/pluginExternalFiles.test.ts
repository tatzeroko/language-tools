import * as fs from "node:fs";
import * as path from "node:path";
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
	it("loads the hard-coded Apex declaration into the project", async () => {
		const workspace = fs.mkdtempSync(path.join(process.cwd(), "sf-plugin-"));
		try {
			fs.writeFileSync(
				path.join(workspace, "sfdx-project.json"),
				JSON.stringify(
					{
						packageDirectories: [{ path: "force-app", default: true }],
						name: "sf-plugin",
					},
					null,
					2,
				),
				"utf8",
			);
			const initModule = await import("../src/index");
			const init =
				(initModule as { default?: typeof initModule }).default ?? initModule;
			const module = (
				init as unknown as (modules: { typescript: typeof ts }) => {
					getExternalFiles: (project: ts.server.Project) => string[];
				}
			)({ typescript });
			const normalizedPath = typescript.server.toNormalizedPath(
				path.join(
					workspace,
					".tatzeroko",
					"virtual",
					"apex",
					"ContactController.search.d.ts",
				),
			);
			const scriptInfo = { path: normalizedPath };
			const getOrCreateScriptInfoForNormalizedPath = vi.fn(() => scriptInfo);
			const addRoot = vi.fn();
			const readFile = vi.fn(() => virtualContent);
			const project = {
				projectRootPath: workspace,
				getCurrentDirectory: () => workspace,
				containsFile: () => false,
				readFile,
				projectService: {
					getOrCreateScriptInfoForNormalizedPath,
					openFiles: new Map<string, undefined>(),
					getScriptInfo: () => undefined,
				},
				addRoot,
			} as never as ts.server.Project;

			const files = module.getExternalFiles(project);

			expect(files).toContain(normalizedPath);
			expect(readFile).not.toHaveBeenCalled();
			expect(getOrCreateScriptInfoForNormalizedPath).toHaveBeenCalledWith(
				normalizedPath,
				true,
				virtualContent,
			);
			expect(addRoot).toHaveBeenCalledWith(scriptInfo);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("loads external files even without projectRootPath", async () => {
		const workspace = fs.mkdtempSync(path.join(process.cwd(), "sf-plugin-"));
		try {
			fs.writeFileSync(
				path.join(workspace, "sfdx-project.json"),
				JSON.stringify(
					{
						packageDirectories: [{ path: "force-app", default: true }],
						name: "sf-plugin",
					},
					null,
					2,
				),
				"utf8",
			);

			const initModule = await import("../src/index");
			const init =
				(initModule as { default?: typeof initModule }).default ?? initModule;
			const module = (
				init as unknown as (modules: { typescript: typeof ts }) => {
					getExternalFiles: (project: ts.server.Project) => string[];
				}
			)({ typescript });
			const normalizedPath = typescript.server.toNormalizedPath(
				path.join(
					workspace,
					".tatzeroko",
					"virtual",
					"apex",
					"ContactController.search.d.ts",
				),
			);
			const scriptInfo = { path: normalizedPath };
			const getOrCreateScriptInfoForNormalizedPath = vi.fn(() => scriptInfo);
			const addRoot = vi.fn();
			const readFile = vi.fn(() => virtualContent);
			const project = {
				getCurrentDirectory: () => workspace,
				containsFile: () => false,
				readFile,
				projectService: {
					getOrCreateScriptInfoForNormalizedPath,
					openFiles: new Map<string, undefined>(),
					getScriptInfo: () => undefined,
				},
				addRoot,
			} as never as ts.server.Project;

			const files = module.getExternalFiles(project);

			expect(files).toContain(normalizedPath);
			expect(readFile).not.toHaveBeenCalled();
			expect(getOrCreateScriptInfoForNormalizedPath).toHaveBeenCalledWith(
				normalizedPath,
				true,
				virtualContent,
			);
			expect(addRoot).toHaveBeenCalledWith(scriptInfo);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

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
});
