import type ts from "typescript/lib/tsserverlibrary";

/**
 * Returns `true` when `path` points to a jsconfig/tsconfig and its counterpart
 * config file also exists — used to skip the jsconfig project when a tsconfig
 * is present, avoiding double-registration of the same source files.
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

/** Reads the internal `projectRootPath` field that TypeScript does not expose publicly. */
export function getProjectRootPath(project: ts.server.Project) {
	const candidate = project as { projectRootPath?: unknown };
	return typeof candidate.projectRootPath === "string"
		? candidate.projectRootPath
		: null;
}

/** Extracts the request payload, handling the TS server quirk where `arguments` may be an array. */
export function getRequestPayload(
	request: ts.server.protocol.Request,
): unknown {
	const candidate = Array.isArray(request.arguments)
		? request.arguments[0]
		: request.arguments;
	return candidate;
}
