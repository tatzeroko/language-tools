import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import ProjectContext from "../projectContext";
import type { VirtualFileStore } from "../vfs";

type ApexModuleResolver = (moduleName: string) => string | undefined;

export function decorateLanguageService(
	workspace: string,
	typescript: typeof ts,
	host: ts.LanguageServiceHost,
	ls: ts.LanguageService,
	vfs: VirtualFileStore,
	dispose: () => void,
	resolveApexModule?: ApexModuleResolver,
) {
	decorateLanguageServiceHost(
		workspace,
		typescript,
		host,
		vfs,
		resolveApexModule,
	);
	decorateLanguageServiceInner(ls, dispose);
	return ls;
}

function decorateLanguageServiceHost(
	workspace: string,
	typescript: typeof ts,
	host: ts.LanguageServiceHost,
	vfs: VirtualFileStore,
	resolveApexModule?: ApexModuleResolver,
) {
	const orig = {
		getScriptFileNames: host.getScriptFileNames?.bind(host),
		getScriptSnapshot: host.getScriptSnapshot?.bind(host),
		getScriptVersion: host.getScriptVersion?.bind(host),
		readFile: host.readFile?.bind(host),
		fileExists: host.fileExists?.bind(host),
		resolveModuleNames: host.resolveModuleNames?.bind(host),
		resolveModuleNameLiterals: host.resolveModuleNameLiterals?.bind(host),
	};

	const resolveApexModulePath = (moduleName: string) => {
		if (!resolveApexModule) {
			return undefined;
		}
		return resolveApexModule(moduleName);
	};

	const createApexResolvedModule = (moduleName: string) => {
		const resolvedFileName = resolveApexModulePath(moduleName);
		if (!resolvedFileName) {
			return undefined;
		}
		return {
			extension: typescript.Extension.Dts,
			isExternalLibraryImport: true,
			resolvedFileName,
		};
	};

	host.getScriptFileNames = () => {
		const scriptFileNames = orig.getScriptFileNames?.() ?? [];
		return [...scriptFileNames, ...vfs.list()];
	};

	host.getScriptSnapshot = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const content = vfs.get(normalized)?.buffer.toString("utf8");
		if (content !== undefined) {
			return typescript.ScriptSnapshot.fromString(content);
		}
		return orig.getScriptSnapshot?.(fileName);
	};

	host.getScriptVersion = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const version = vfs.get(normalized)?.version.toString();
		if (version !== undefined) {
			return version;
		}
		return orig.getScriptVersion?.(fileName);
	};

	host.readFile = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const content = vfs.get(normalized)?.buffer.toString("utf8");
		if (content !== undefined) {
			return content;
		}
		return orig.readFile?.(fileName);
	};

	host.fileExists = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		return vfs.has(normalized) || (orig.fileExists?.(fileName) ?? false);
	};

	host.resolveModuleNameLiterals = (
		moduleLiterals,
		containingFile,
		redirectedReference,
		options,
		containingSourceFile,
		reusedNames,
	) => {
		const resolutions =
			orig.resolveModuleNameLiterals?.(
				moduleLiterals,
				containingFile,
				redirectedReference,
				options,
				containingSourceFile,
				reusedNames,
			) ?? [];

		return moduleLiterals.map((moduleLiteral, index) => {
			const moduleName = moduleLiteral.text;
			const resolution = resolutions[index];

			if (moduleName.startsWith("@salesforce/apex/")) {
				const resolvedModule = createApexResolvedModule(moduleName);
				if (resolvedModule) {
					return { resolvedModule };
				}
			}

			if (!moduleName.startsWith("c/")) {
				return resolution;
			}

			const componentName = moduleName.substring(2);
			for (const ctx of ProjectContext.getAllInWorkspace(workspace)) {
				const componentFolder = path.join(
					ctx.project.getCurrentDirectory(),
					componentName,
				);
				const extensions = {
					".d.ts": typescript.Extension.Dts,
					".ts": typescript.Extension.Ts,
					".js": typescript.Extension.Js,
				};

				for (const [ext, extension] of Object.entries(extensions)) {
					const candidate = path.join(
						componentFolder,
						`${componentName}${ext}`,
					);
					if (ctx.host.fileExists?.(candidate)) {
						return {
							resolvedModule: {
								extension,
								resolvedFileName: typescript.server.toNormalizedPath(candidate),
							},
						};
					}
				}
			}

			return resolution;
		});
	};

	host.resolveModuleNames = (
		moduleNames,
		containingFile,
		_reusedNames,
		_redirectedReference,
		options,
		containingSourceFile,
	) => {
		const literals = moduleNames.map(
			(text) => ({ text }) as ts.StringLiteralLike,
		);
		const literalResolutions = containingSourceFile
			? host.resolveModuleNameLiterals?.(
					literals,
					containingFile,
					_redirectedReference,
					options,
					containingSourceFile,
					undefined,
				)
			: undefined;
		if (literalResolutions) {
			return literalResolutions.map((resolution) => resolution?.resolvedModule);
		}
		return (
			orig.resolveModuleNames?.(
				moduleNames,
				containingFile,
				_reusedNames,
				_redirectedReference,
				options,
				containingSourceFile,
			) ?? moduleNames.map(() => undefined)
		);
	};
}

function decorateLanguageServiceInner(
	ls: ts.LanguageService,
	dispose: () => void,
) {
	const orig = { dispose: ls.dispose?.bind(ls) };
	ls.dispose = () => {
		dispose();
		orig.dispose?.();
	};
}
