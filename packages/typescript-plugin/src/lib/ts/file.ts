import type * as ts from "typescript/lib/tsserverlibrary";

type LoadableProject = Pick<
	ts.server.Project,
	"containsFile" | "readFile" | "addRoot"
> & {
	projectService: Pick<
		ts.server.ProjectService,
		"getOrCreateScriptInfoForNormalizedPath"
	>;
};

type UnloadableProject = Pick<ts.server.Project, "removeFile"> & {
	projectService: Pick<ts.server.ProjectService, "getScriptInfo">;
};

type ScriptInfoWithContent = ts.server.ScriptInfo & {
	getSnapshot?: () => {
		getLength: () => number;
		getText: (start: number, end: number) => string;
	};
	editContent?: (start: number, end: number, newText: string) => void;
};

/**
 * Loads or refreshes a file in the given TypeScript project.
 *
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param project The TypeScript server project instance.
 * @param path The file path to load.
 * @param content Optional file content. When omitted, the file is read from the project host.
 */
export function loadFile(
	typescript: typeof ts,
	project: LoadableProject,
	path: string,
	content?: string,
) {
	const normalizedPath = typescript.server.toNormalizedPath(path);
	const fileContent = content ?? project.readFile(normalizedPath);
	if (fileContent === undefined) {
		return;
	}

	const scriptInfo =
		project.projectService.getOrCreateScriptInfoForNormalizedPath(
			normalizedPath,
			/*openedByClient*/ true,
			fileContent,
		);

	if (!scriptInfo) {
		return;
	}

	const scriptInfoWithContent = scriptInfo as ScriptInfoWithContent;
	const snapshot = scriptInfoWithContent.getSnapshot?.();
	const existingText = snapshot?.getText(0, snapshot.getLength()) ?? undefined;
	if (existingText !== fileContent && scriptInfoWithContent.editContent) {
		scriptInfoWithContent.editContent(
			0,
			snapshot?.getLength() ?? 0,
			fileContent,
		);
	}

	try {
		project.addRoot(scriptInfo);
	} catch {}
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
	project: UnloadableProject,
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
}
