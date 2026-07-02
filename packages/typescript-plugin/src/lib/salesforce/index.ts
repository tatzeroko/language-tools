import type ts from "typescript/lib/tsserverlibrary";

/**
 * Walks upward from `startDir` looking for Salesforce workspace markers
 * (`sfdx-project.json`, `.sf/`, `.sfdx/`). Returns the first matching
 * directory, or `undefined` if none is found before the filesystem root.
 */
export function findSalesforceWorkspaceRoot(
	typescript: typeof ts,
	startDir: string,
) {
	let currentPath = typescript.sys.resolvePath(startDir);

	while (true) {
		const sfdxJson = typescript.sys.resolvePath(
			`${currentPath}/sfdx-project.json`,
		);
		const sfDir = typescript.sys.resolvePath(`${currentPath}/.sf`);
		const sfdxDir = typescript.sys.resolvePath(`${currentPath}/.sfdx`);

		if (
			typescript.sys.fileExists(sfdxJson) ||
			typescript.sys.directoryExists?.(sfDir) ||
			typescript.sys.directoryExists?.(sfdxDir)
		) {
			return currentPath;
		}

		const parent = typescript.sys.resolvePath(`${currentPath}/..`);
		if (parent === currentPath) {
			/** Reached filesystem root */
			break;
		}

		currentPath = parent;
	}

	return undefined;
}
