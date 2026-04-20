import * as fs from "node:fs";
import * as path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import * as typescript from "typescript/lib/tsserverlibrary";
import { describe, expect, it } from "vitest";
import { decorateLanguageService } from "../src/language-service";
import { VirtualFileStore } from "../src/vfs";

describe("language-service decorator", () => {
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
			fs.writeFileSync(
				virtualPath,
				`type ContactControllerSearchParams = { query: string; };
export default function search(params: ContactControllerSearchParams): Promise<unknown[]>;`,
				"utf8",
			);

			const vfs = new VirtualFileStore();
			const normalized = typescript.server.toNormalizedPath(virtualPath);
			vfs.set(normalized, fs.readFileSync(virtualPath));
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

			const consumerPath = path.join(workspace, "src", "index.ts");
			fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
			const consumerText =
				'import search from "@salesforce/apex/ContactController.search";\nsearch({ query: "Ada" });\n';
			fs.writeFileSync(consumerPath, consumerText, "utf8");

			const quickInfo = ls.getQuickInfoAtPosition(
				consumerPath,
				consumerText.indexOf("search"),
			);
			expect(
				quickInfo?.displayParts?.map((part) => part.text).join(" "),
			).toContain("ContactControllerSearchParams");
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
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});
