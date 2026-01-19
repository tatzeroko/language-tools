import type ts from "typescript/lib/tsserverlibrary";

/**
 * Locates the root directory of a Salesforce (SFDX / SF) workspace.
 *
 * @description
 * Traverses upward from the given `startDir`, looking for any of the following
 * well-known Salesforce workspace markers:
 *
 * - `sfdx-project.json` – legacy SFDX project root
 * - `.sf/` – new Salesforce CLI workspace root
 * - `.sfdx/` – legacy Salesforce CLI workspace root
 *
 * Stops at the filesystem root if no markers are found.
 *
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param startDir The starting directory for the upward search.
 * @return The resolved path to the Salesforce workspace root, or `undefined` if not found.
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

/**
 * Determines whether a TypeScript project belongs to a Salesforce (SFDX / SF) workspace.
 * Internally calls {@link findSalesforceWorkspaceRoot} to detect workspace markers.
 *
 * @param typescript The TypeScript module reference provided by the plugin.
 * @param project The TypeScript server project instance.
 * @return `true` if a Salesforce workspace root is found; otherwise `false`.
 */
export function isSalesforceWorkspace(
	typescript: typeof ts,
	project: ts.server.Project,
) {
	return !!findSalesforceWorkspaceRoot(
		typescript,
		project.getCurrentDirectory(),
	);
}
