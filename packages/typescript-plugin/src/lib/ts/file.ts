import type * as ts from "typescript/lib/tsserverlibrary";

/**
 * Loads a file into the given TypeScript project if it is not already present.
 *
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param project The TypeScript server project instance.
 * @param path The file path to load.
 * @param content The content of the file to load. Used
 */
export function loadFile(
	typescript: typeof ts,
	project: ts.server.Project,
	path: string,
	content: string,
) {
	const normalizedPath = typescript.server.toNormalizedPath(path);
	if (project.containsFile(normalizedPath)) {
		return;
	}

	const scriptInfo =
		project.projectService.getOrCreateScriptInfoForNormalizedPath(
			normalizedPath,
			/*openedByClient*/ true,
			content,
		);

	if (!scriptInfo) {
		return;
	}

	if (!project.projectService.openFiles.has(scriptInfo.path)) {
		project.projectService.openFiles.set(scriptInfo.path, undefined);
	}

	try {
		project.projectService.openClientFileWithNormalizedPath(
			normalizedPath,
			content,
			undefined,
			false,
			typescript.server.toNormalizedPath(project.getCurrentDirectory()),
		);
	} catch {
		try {
			project.addRoot(scriptInfo);
		} catch {
			/** ignore project root insertion issues for virtual files */
		}
	}

	project.updateGraph();
}

/**
 * Unloads a file from the given TypeScript project if it is present.
 *
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param project The TypeScript server project instance.
 * @param path The file path to unload.
 */
export function unloadFile(
	typescript: typeof ts,
	project: ts.server.Project,
	path: string,
) {
	const normalizedPath = typescript.server.toNormalizedPath(path);
	const scriptInfo = project.projectService.getScriptInfo(normalizedPath);
	if (!scriptInfo) {
		return;
	}

	project.removeFile(
		scriptInfo,
		/*fileExists*/ false,
		/*detachFromProject*/ true,
	);
	project.projectService.openFiles.delete(scriptInfo.path);

	project.updateGraph();
}
