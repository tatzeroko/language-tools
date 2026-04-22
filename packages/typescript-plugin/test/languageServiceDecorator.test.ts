import * as fs from "node:fs";
import * as path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import * as typescript from "typescript/lib/tsserverlibrary";
import { describe, expect, it } from "vitest";
import { decorateLanguageService } from "../src/language-service";
import { VirtualFileStore } from "../src/vfs";

const virtualContent = `/**
 * Finds contacts matching the query.
 * @param params - The parameters for this call.
 * @return matching contacts.
 */
export default function search(params: {
	query: string;
}): Promise<unknown[]>;`;

describe("language-service decorator", () => {
	it("exposes virtual Apex files through the host", () => {
		const workspace = fs.mkdtempSync(path.join(process.cwd(), "sf-plugin-"));
		try {
			const virtualPath = path.join(
				workspace,
				".tatzeroko",
				"virtual",
				"apex",
				"ContactController.search.d.ts",
			);

			const vfs = new VirtualFileStore();
			const normalized = typescript.server.toNormalizedPath(virtualPath);
			vfs.set(normalized, virtualContent);
			const host: ts.LanguageServiceHost = {
				getScriptFileNames: () => [],
				getScriptVersion: () => "1",
				getScriptSnapshot: (fileName) => {
					const normalizedName = typescript.server.toNormalizedPath(fileName);
					const content = vfs.get(normalizedName)?.buffer.toString("utf8");
					return content
						? typescript.ScriptSnapshot.fromString(content)
						: undefined;
				},
				getCurrentDirectory: () => workspace,
				getCompilationSettings: () => ({
					module: typescript.ModuleKind.ESNext,
					moduleResolution: typescript.ModuleResolutionKind.NodeNext,
				}),
				getDefaultLibFileName: (options) =>
					typescript.getDefaultLibFilePath(options),
				readFile: (fileName) => {
					const normalizedName = typescript.server.toNormalizedPath(fileName);
					return vfs.get(normalizedName)?.buffer.toString("utf8");
				},
				fileExists: (fileName) => {
					const normalizedName = typescript.server.toNormalizedPath(fileName);
					return vfs.has(normalizedName);
				},
				directoryExists: (directoryName) => {
					const normalizedDir =
						typescript.server.toNormalizedPath(directoryName);
					return Array.from(vfs.list()).some((file) =>
						file.startsWith(`${normalizedDir}/`),
					);
				},
				readDirectory: (directoryName) => {
					const normalizedDir =
						typescript.server.toNormalizedPath(directoryName);
					return vfs
						.list()
						.filter((file) => file.startsWith(`${normalizedDir}/`));
				},
				getDirectories: () => [],
			};
			const ls = typescript.createLanguageService(host);
			decorateLanguageService(
				workspace,
				typescript,
				host,
				ls,
				vfs,
				() => ls.dispose(),
				(moduleName) =>
					moduleName === "@salesforce/apex/ContactController.search"
						? normalized
						: undefined,
			);

			expect(host.getScriptFileNames()).toContain(normalized);
			expect(ls.getProgram()?.getSourceFile(normalized)).toBeDefined();
			expect(host.fileExists?.(normalized)).toBe(true);
			expect(host.readFile?.(normalized)).toBe(virtualContent);
			expect(
				host.readDirectory?.(
					path.join(workspace, ".tatzeroko", "virtual", "apex"),
				),
			).toContain(normalized);
			expect(
				host.getScriptSnapshot?.(normalized)?.getText(0, virtualContent.length),
			).toBe(virtualContent);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("resolves generated Apex virtual modules", () => {
		const workspace = fs.mkdtempSync(path.join(process.cwd(), "sf-plugin-"));
		try {
			const virtualPath = path.join(
				workspace,
				".tatzeroko",
				"virtual",
				"apex",
				"ContactController.search.d.ts",
			);
			fs.mkdirSync(path.dirname(virtualPath), { recursive: true });
			fs.writeFileSync(virtualPath, virtualContent, "utf8");

			const vfs = new VirtualFileStore();
			const normalized = typescript.server.toNormalizedPath(virtualPath);
			vfs.set(normalized, fs.readFileSync(virtualPath));
			const consumerPath = path.join(workspace, "src", "index.ts");
			fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
			const consumerText =
				'import search from "@salesforce/apex/ContactController.search";\nsearch({ query: "Ada" });\n';
			fs.writeFileSync(consumerPath, consumerText, "utf8");
			const host: ts.LanguageServiceHost = {
				getScriptFileNames: () => [consumerPath],
				getScriptVersion: () => "1",
				getScriptSnapshot: (fileName) => {
					if (fs.existsSync(fileName)) {
						return typescript.ScriptSnapshot.fromString(
							fs.readFileSync(fileName, "utf8"),
						);
					}
					const normalizedName = typescript.server.toNormalizedPath(fileName);
					const content = vfs.get(normalizedName)?.buffer.toString("utf8");
					return content
						? typescript.ScriptSnapshot.fromString(content)
						: undefined;
				},
				getCurrentDirectory: () => workspace,
				getCompilationSettings: () => ({
					module: typescript.ModuleKind.ESNext,
					moduleResolution: typescript.ModuleResolutionKind.NodeNext,
				}),
				getDefaultLibFileName: (options) =>
					typescript.getDefaultLibFilePath(options),
				readFile: (fileName) => fs.readFileSync(fileName, "utf8"),
				fileExists: (fileName) => fs.existsSync(fileName),
				directoryExists: () => true,
				getDirectories: () => [],
			};
			const ls = typescript.createLanguageService(host);
			decorateLanguageService(
				workspace,
				typescript,
				host,
				ls,
				vfs,
				() => ls.dispose(),
				(moduleName) =>
					moduleName === "@salesforce/apex/ContactController.search"
						? normalized
						: undefined,
			);

			const quickInfo = ls.getQuickInfoAtPosition(
				consumerPath,
				consumerText.indexOf("search"),
			);
			expect(quickInfo).toBeDefined();
			expect(ls.getProgram()?.getSourceFile(normalized)).toBeDefined();
			const diagnostics = ls
				.getSemanticDiagnostics(consumerPath)
				.filter((diagnostic) => diagnostic.code === 2307);
			expect(diagnostics).toHaveLength(0);
			const moduleLiteral = {
				text: "@salesforce/apex/ContactController.search",
			} as ts.StringLiteralLike;
			const sourceFile = typescript.createSourceFile(
				consumerPath,
				consumerText,
				typescript.ScriptTarget.ESNext,
			);
			const resolution = host.resolveModuleNameLiterals?.(
				[moduleLiteral],
				consumerPath,
				undefined,
				host.getCompilationSettings(),
				sourceFile,
				undefined,
			);
			expect(resolution?.[0]?.resolvedModule?.resolvedFileName).toBe(
				normalized,
			);

			const fallbackResolution = host.resolveModuleNames?.(
				["@salesforce/apex/ContactController.search"],
				consumerPath,
				undefined,
				undefined,
				host.getCompilationSettings(),
				undefined,
			);
			expect(fallbackResolution?.[0]?.resolvedFileName).toBe(normalized);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});
