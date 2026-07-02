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
