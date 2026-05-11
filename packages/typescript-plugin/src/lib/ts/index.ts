import type ts from "typescript/lib/tsserverlibrary";

/**
 * Determines whether a JavaScript/TypeScript project has an equivalent counterpart.
 *
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param path The path to the jsconfig.json or tsconfig.json file.
 * @returns `true` if an equivalent counterpart project file exists; otherwise `false`.
 */
export function hasEquivalentProjectCounterpart(
	typescript: typeof ts,
	path: string,
) {
	if (!path.endsWith("jsconfig.json") && !path.endsWith("tsconfig.json")) {
		return false;
	}

	const parent = typescript.sys.resolvePath(`${path}/..`);
	const counterpart = path.endsWith("jsconfig.json")
		? typescript.sys.resolvePath(`${parent}/tsconfig.json`)
		: typescript.sys.resolvePath(`${parent}/jsconfig.json`);

	return typescript.sys.fileExists(counterpart);
}

export function getProjectRootPath(project: ts.server.Project) {
	const candidate = project as { projectRootPath?: unknown };
	return typeof candidate.projectRootPath === "string"
		? candidate.projectRootPath
		: null;
}

export function getRequestPayload(
	request: ts.server.protocol.Request,
): unknown {
	const candidate = Array.isArray(request.arguments)
		? request.arguments[0]
		: request.arguments;
	return candidate;
}
