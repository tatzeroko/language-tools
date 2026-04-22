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
	content?: string,
) {
	const normalizedPath = typescript.server.toNormalizedPath(path);
	const fileContent = content ?? project.readFile(normalizedPath);
	console.log(
		`[tatzeroko-plugin] loadFile start path=${normalizedPath} source=${content ? "provided" : "project.readFile"}`,
	);
	if (fileContent === undefined) {
		console.log(
			`[tatzeroko-plugin] loadFile skipped path=${normalizedPath} reason=no-content`,
		);
		return;
	}
	console.log(
		`[tatzeroko-plugin] loadFile path=${normalizedPath} contentLength=${fileContent.length} contains=${project.containsFile(normalizedPath)}`,
	);

	const scriptInfo =
		project.projectService.getOrCreateScriptInfoForNormalizedPath(
			normalizedPath,
			/*openedByClient*/ true,
			fileContent,
		);

	if (!scriptInfo) {
		console.log(
			`[tatzeroko-plugin] loadFile skipped path=${normalizedPath} reason=no-script-info`,
		);
		return;
	}

	const scriptInfoWithContent = scriptInfo as unknown as {
		getSnapshot?: () => {
			getLength: () => number;
			getText: (start: number, end: number) => string;
		};
		editContent?: (start: number, end: number, newText: string) => void;
	};
	const snapshot = scriptInfoWithContent.getSnapshot?.();
	const existingText = snapshot?.getText(0, snapshot.getLength()) ?? undefined;
	if (existingText !== fileContent && scriptInfoWithContent.editContent) {
		console.log(`[tatzeroko-plugin] loadFile refresh path=${normalizedPath}`);
		scriptInfoWithContent.editContent(
			0,
			snapshot?.getLength() ?? 0,
			fileContent,
		);
	}

	console.log(`[tatzeroko-plugin] loadFile addRoot path=${normalizedPath}`);
	try {
		project.addRoot(scriptInfo);
	} catch (error) {
		console.log(
			`[tatzeroko-plugin] loadFile addRoot failed path=${normalizedPath} error=${String(error)}`,
		);
	}
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
	console.log(`[tatzeroko-plugin] unloadFile path=${normalizedPath}`);
	const scriptInfo = project.projectService.getScriptInfo(normalizedPath);
	if (!scriptInfo) {
		console.log(
			`[tatzeroko-plugin] unloadFile skipped path=${normalizedPath} reason=no-script-info`,
		);
		return;
	}

	project.removeFile(
		scriptInfo,
		/*fileExists*/ false,
		/*detachFromProject*/ true,
	);
	console.log(`[tatzeroko-plugin] unloadFile updated path=${normalizedPath}`);
}
