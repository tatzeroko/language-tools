import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import ProjectContext from "../projectContext";
import type { VirtualFileStore } from "../vfs";

type ApexModuleResolver = (moduleName: string) => string | undefined;

function toNormalizedPath(typescript: typeof ts, fileName: string) {
	return typescript.server.toNormalizedPath(
		fileName,
	) as ts.server.NormalizedPath;
}

export function decorateLanguageService(
	workspace: string,
	typescript: typeof ts,
	host: ts.LanguageServiceHost,
	ls: ts.LanguageService,
	vfs: VirtualFileStore,
	project: Pick<ts.server.Project, "addRoot">,
	projectService: Pick<
		ts.server.ProjectService,
		"getOrCreateScriptInfoForNormalizedPath"
	>,
	dispose: () => void,
	resolveApexModule?: ApexModuleResolver,
) {
	decorateLanguageServiceHost(
		workspace,
		typescript,
		host,
		vfs,
		project,
		projectService,
		resolveApexModule,
	);
	decorateLanguageServiceInner(ls, dispose);
	return ls;
}

function isSalesforceGeneratedApexTypings(normalizedPath: string) {
	return normalizedPath.includes("/.sfdx/typings/lwc/apex/");
}

function shouldIgnoreApexTyping(normalizedPath: string) {
	return isSalesforceGeneratedApexTypings(normalizedPath);
}

function decorateLanguageServiceHost(
	workspace: string,
	typescript: typeof ts,
	host: ts.LanguageServiceHost,
	vfs: VirtualFileStore,
	project: Pick<ts.server.Project, "addRoot">,
	projectService: Pick<
		ts.server.ProjectService,
		"getOrCreateScriptInfoForNormalizedPath"
	>,
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
			return undefined;
		}
		return resolveApexModule(moduleName);
	};

	const createApexResolvedModule = (moduleName: string) => {
		const resolvedFileName = resolveApexModulePath(moduleName);
		if (!resolvedFileName) {
			return undefined;
		}
		ensurePlaceholderVirtualFile(resolvedFileName);
		return {
			extension: typescript.Extension.Dts,
			isExternalLibraryImport: true,
			resolvedFileName,
		};
	};

	const registerScriptInfo = (normalizedPath: string, content: string) => {
		const normalizedVirtualPath = toNormalizedPath(typescript, normalizedPath);
		const scriptInfo = projectService.getOrCreateScriptInfoForNormalizedPath(
			normalizedVirtualPath,
			true,
			content,
		);
		if (scriptInfo) {
			try {
				project.addRoot(scriptInfo);
			} catch {}
		}
	};

	const ensurePlaceholderVirtualFile = (normalizedPath: string) => {
		const existing = vfs.get(normalizedPath);
		if (existing) {
			registerScriptInfo(normalizedPath, existing.buffer.toString("utf8"));
			return;
		}
		const fileName = path.basename(normalizedPath, ".d.ts");
		const [, methodName] = fileName.split(".");
		if (!methodName) {
			return;
		}
		const content = `export default function ${methodName}(params: unknown): Promise<unknown>;`;
		vfs.set(normalizedPath, content);
		registerScriptInfo(normalizedPath, content);
	};

	host.getScriptFileNames = () => {
		const virtualFiles = vfs.list();
		const scriptFileNames = (orig.getScriptFileNames?.() ?? []).filter(
			(fileName) =>
				!shouldIgnoreApexTyping(toNormalizedPath(typescript, fileName)),
		);
		return [...scriptFileNames, ...virtualFiles];
	};

	host.getScriptSnapshot = (fileName: string) => {
		const normalized = toNormalizedPath(typescript, fileName);
		if (shouldIgnoreApexTyping(normalized)) {
			return undefined;
		}
		const content = vfs.get(normalized)?.buffer.toString("utf8");
		if (content !== undefined)
			return typescript.ScriptSnapshot.fromString(content);
		return orig.getScriptSnapshot?.(fileName);
	};

	host.getScriptVersion = (fileName: string) => {
		const normalized = toNormalizedPath(typescript, fileName);
		const version = vfs.get(normalized)?.version.toString();
		if (version !== undefined) return version;
		return orig.getScriptVersion?.(fileName);
	};

	host.readFile = (fileName: string) => {
		const normalized = toNormalizedPath(typescript, fileName);
		if (shouldIgnoreApexTyping(normalized)) {
			return undefined;
		}
		const content = vfs.get(normalized)?.buffer.toString("utf8");
		if (content !== undefined) return content;
		return orig.readFile?.(fileName);
	};

	host.fileExists = (fileName: string) => {
		const normalized = toNormalizedPath(typescript, fileName);
		if (shouldIgnoreApexTyping(normalized)) {
			return false;
		}
		return vfs.has(normalized) || (orig.fileExists?.(fileName) ?? false);
	};

	host.directoryExists = (directoryName: string) => {
		const normalized = toNormalizedPath(typescript, directoryName);
		return (
			vfs.hasPrefix(`${normalized}/`) ||
			(orig.directoryExists?.(directoryName) ?? false)
		);
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
		const filteredBase = base.filter(
			(file) => !shouldIgnoreApexTyping(toNormalizedPath(typescript, file)),
		);
		const normalizedDir = toNormalizedPath(typescript, directoryName);
		const matchingVirtualFiles = vfs.listUnderPrefix(
			`${normalizedDir}/`,
			extensions,
		);
		return Array.from(new Set([...filteredBase, ...matchingVirtualFiles]));
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
				if (resolvedModule) return { resolvedModule };
			}

			if (!moduleName.startsWith("c/")) {
				return resolution;
			}

			const componentName = moduleName.substring(2);
			let resolutionResult:
				| ts.ResolvedModuleWithFailedLookupLocations
				| undefined;
			ProjectContext.forEachMatchingWorkspace(workspace, (_, ctx) => {
				if (resolutionResult) return;
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
						resolutionResult = {
							resolvedModule: {
								extension,
								resolvedFileName: toNormalizedPath(typescript, candidate),
							},
						};
						return;
					}
				}
			});
			if (resolutionResult) return resolutionResult;

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
			return apexResolutions.map((resolution, _index) => {
				if (resolution) return resolution;
				return undefined;
			});
		}

		const literals = moduleNames.map((text) =>
			typescript.factory.createStringLiteral(text),
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
