import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const JAR = "apex-jorje-lsp.jar";
const EXT_PREFIX = "salesforce.salesforcedx-vscode-apex-";

export function defaultExtensionDirs(home = os.homedir()): string[] {
	return [
		".vscode/extensions",
		".vscode-server/extensions",
		".vscode-server-insiders/extensions",
		".vscode-insiders/extensions",
		".cursor/extensions",
	].map((d) => path.join(home, d));
}

/**
 * Locates (never copies) the apex-jorje-lsp.jar shipped inside an installed
 * official Salesforce Apex extension. Official layout: <ext>/out/apex-jorje-lsp.jar.
 * Newest directory name wins; the TypeScript "apex-ls" VSIX has no JAR and is skipped.
 */
export function findOfficialJorjeJar(
	opts: { extensionPaths?: string[]; extensionDirs?: string[] } = {},
): string | undefined {
	const candidates: string[] = [...(opts.extensionPaths ?? [])];
	for (const dir of opts.extensionDirs ?? defaultExtensionDirs()) {
		if (!existsSync(dir)) continue;
		const names = readdirSync(dir)
			.filter((n) => n.toLowerCase().startsWith(EXT_PREFIX))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		for (const n of names) candidates.push(path.join(dir, n));
	}
	for (const c of candidates)
		for (const sub of ["out", "dist", "jars", "."]) {
			const jar = path.join(c, sub, JAR);
			if (existsSync(jar)) return jar;
		}
	return undefined;
}
