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
	console.log(
		`[tatzeroko-plugin] decorateLanguageService workspace=${workspace} vfsCount=${vfs.list().length}`,
	);
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
		readDirectory: host.readDirectory?.bind(host),
		directoryExists: host.directoryExists?.bind(host),
		resolveModuleNames: host.resolveModuleNames?.bind(host),
		resolveModuleNameLiterals: host.resolveModuleNameLiterals?.bind(host),
	};

	const resolveApexModulePath = (moduleName: string) => {
		if (!resolveApexModule) {
			console.log(
				`[tatzeroko-plugin] resolveApexModulePath no-resolver module=${moduleName}`,
			);
			return undefined;
		}
		const resolved = resolveApexModule(moduleName);
		if (moduleName.startsWith("@salesforce/apex/")) {
			console.log(
				`[tatzeroko-plugin] resolveApexModule module=${moduleName} resolved=${resolved ?? "undefined"}`,
			);
		}
		return resolved;
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
		const virtualFiles = vfs.list();
		if (virtualFiles.length) {
			console.log(
				`[tatzeroko-plugin] getScriptFileNames virtual=${virtualFiles.join(",")}`,
			);
		}
		return [...scriptFileNames, ...virtualFiles];
	};

	host.getScriptSnapshot = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const content = vfs.get(normalized)?.buffer.toString("utf8");
		if (content !== undefined) {
			console.log(
				`[tatzeroko-plugin] getScriptSnapshot virtual path=${normalized} length=${content.length}`,
			);
			return typescript.ScriptSnapshot.fromString(content);
		}
		return orig.getScriptSnapshot?.(fileName);
	};

	host.getScriptVersion = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const version = vfs.get(normalized)?.version.toString();
		if (version !== undefined) {
			console.log(
				`[tatzeroko-plugin] getScriptVersion virtual path=${normalized} version=${version}`,
			);
			return version;
		}
		return orig.getScriptVersion?.(fileName);
	};

	host.readFile = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const content = vfs.get(normalized)?.buffer.toString("utf8");
		if (content !== undefined) {
			console.log(
				`[tatzeroko-plugin] readFile virtual path=${normalized} length=${content.length}`,
			);
			return content;
		}
		return orig.readFile?.(fileName);
	};

	host.fileExists = (fileName: string) => {
		const normalized = typescript.server.toNormalizedPath(fileName);
		const exists =
			vfs.has(normalized) || (orig.fileExists?.(fileName) ?? false);
		if (normalized.includes("/.tatzeroko/virtual/apex/")) {
			console.log(
				`[tatzeroko-plugin] fileExists path=${normalized} exists=${exists}`,
			);
		}
		return exists;
	};

	host.directoryExists = (directoryName: string) => {
		const normalized = typescript.server.toNormalizedPath(directoryName);
		const exists =
			Array.from(vfs.list()).some((file) =>
				file.startsWith(`${normalized}/`),
			) ||
			(orig.directoryExists?.(directoryName) ?? false);
		if (normalized.includes("/.tatzeroko/virtual/apex/")) {
			console.log(
				`[tatzeroko-plugin] directoryExists path=${normalized} exists=${exists}`,
			);
		}
		if (
			Array.from(vfs.list()).some((file) => file.startsWith(`${normalized}/`))
		) {
			return true;
		}
		return orig.directoryExists?.(directoryName) ?? false;
	};

	host.readDirectory = (
		directoryName: string,
		extensions?: readonly string[],
		exclude?: readonly string[],
		include?: readonly string[],
		depth?: number,
	) => {
		const base =
			orig.readDirectory?.(
				directoryName,
				extensions,
				exclude,
				include,
				depth,
			) ?? [];
		const normalizedDir = typescript.server.toNormalizedPath(directoryName);
		const suffixes = new Set(extensions ?? []);
		const virtualFiles = vfs
			.list()
			.filter((file) => file.startsWith(`${normalizedDir}/`))
			.filter((file) => {
				if (!suffixes.size) {
					return true;
				}
				return Array.from(suffixes).some((ext) => file.endsWith(ext));
			});
		if (normalizedDir.includes("/.tatzeroko/virtual/apex/")) {
			console.log(
				`[tatzeroko-plugin] readDirectory path=${normalizedDir} base=${base.length} virtual=${virtualFiles.length} extensions=${Array.from(suffixes).join(",")}`,
			);
		}
		return Array.from(new Set([...base, ...virtualFiles]));
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
				console.log(
					`[tatzeroko-plugin] resolveModuleNameLiterals module=${moduleName} containing=${containingFile} baseResolved=${resolution?.resolvedModule?.resolvedFileName ?? "undefined"}`,
				);
			}

			if (moduleName.startsWith("@salesforce/apex/")) {
				const resolvedModule = createApexResolvedModule(moduleName);
				if (resolvedModule) {
					console.log(
						`[tatzeroko-plugin] resolveModuleNameLiterals apexHit module=${moduleName} resolved=${resolvedModule.resolvedFileName}`,
					);
					return { resolvedModule };
				}
			}

			if (!moduleName.startsWith("c/")) {
				return resolution;
			}
			console.log(
				`[tatzeroko-plugin] resolveModuleNameLiterals c-module containing=${containingFile} module=${moduleName}`,
			);

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
		const apexResolutions = moduleNames.map((moduleName) => {
			if (!moduleName.startsWith("@salesforce/apex/")) {
				return undefined;
			}
			return createApexResolvedModule(moduleName);
		});
		if (apexResolutions.some(Boolean)) {
			return apexResolutions.map((resolution, index) => {
				if (resolution) {
					console.log(
						`[tatzeroko-plugin] resolveModuleNames apexHit module=${moduleNames[index]} containing=${containingFile} resolved=${resolution.resolvedFileName}`,
					);
					return resolution;
				}
				return undefined;
			});
		}

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
	const orig = {
		dispose: ls.dispose?.bind(ls),
	};
	ls.dispose = () => {
		dispose();
		orig.dispose?.();
	};
}
