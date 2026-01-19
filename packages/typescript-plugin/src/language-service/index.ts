import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import ProjectContext from "../projectContext";
import type { VirtualFileStore } from "../vfs";

/**
 * Decorates the TypeScript Language Service and its Host with additional functionality
 * specific to Salesforce TypeScript projects.
 *
 * @param workspace The workspace directory path.
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param host The TypeScript Language Service Host instance to decorate.
 * @param ls The TypeScript Language Service instance to decorate.
 * @param vfs The Virtual File Store instance for managing virtual files.
 * @param dispose A callback function to execute when the Language Service is disposed.
 */
export function decorateLanguageService(
	workspace: string,
	typescript: typeof ts,
	host: ts.LanguageServiceHost,
	ls: ts.LanguageService,
	vfs: VirtualFileStore,
	dispose: () => void,
) {
	decorateLanguageServiceHost(workspace, typescript, host, vfs);
	decorateLanguageServiceInner(ls, dispose);

	return ls;
}

/**
 * Decorates the TypeScript Language Service Host to include virtual files
 * managed by the provided Application.
 *
 * @param workspace The workspace directory path.
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param host The TypeScript Language Service Host instance to decorate.
 * @param vfs The Virtual File Store instance for managing virtual files.
 */
function decorateLanguageServiceHost(
	workspace: string,
	typescript: typeof ts,
	host: ts.LanguageServiceHost,
	vfs: VirtualFileStore,
) {
	const orig = {
		getScriptFileNames: host.getScriptFileNames?.bind(host),
		getScriptSnapshot: host.getScriptSnapshot?.bind(host),
		getScriptVersion: host.getScriptVersion?.bind(host),
		readFile: host.readFile?.bind(host),
		fileExists: host.fileExists?.bind(host),
		resolveModuleNameLiterals: host.resolveModuleNameLiterals?.bind(host),
	};

	host.getScriptFileNames = () => {
		const fileNames = orig.getScriptFileNames?.() ?? [];

		return [
			...fileNames,
			...Array.from(vfs.list()).filter((vf) => !fileNames.includes(vf)),
		];
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

		return resolutions.map((resolution, index) => {
			const moduleLiteral = moduleLiterals[index];
			const moduleName = moduleLiteral.text;

			/**
			 * TODO: Namespace support
			 *
			 * Component paths are currently resolved assuming the default namespace (`c/`).
			 *
			 * Proper namespace handling requires:
			 * - A workspace-level namespace registry
			 * - A source of truth for namespace resolution (e.g. org metadata / config)
			 * - Overridable resolution logic shared across projects
			 *
			 * This is intentionally deferred until a namespace abstraction exists.
			 */
			if (!moduleName.startsWith("c/")) {
				return resolution;
			}

			const componentName = moduleName.substring(2);

			const contexts = ProjectContext.getAllInWorkspace(typescript, workspace);

			for (const ctx of contexts) {
				const componentFolder = path.join(
					ctx.project.getCurrentDirectory(),
					componentName,
				);

				/**
				 * Prioritized in order specified
				 */
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
						/**
						 * Prioritizes first found match across all projects in workspace
						 */
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
}

/**
 * Decorates the TypeScript Language Service with additional functionality.
 *
 * @param ls The TypeScript Language Service instance to decorate.
 * @param dispose A callback function to execute when the Language Service is disposed.
 */
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
