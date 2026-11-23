import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type DxProject = {
	/** Absolute directory containing sfdx-project.json. */
	readonly root: string;
	readonly namespace: string;
	readonly packageDirectories: ReadonlyArray<string>;
	/** Roots of DX projects nested inside this one; their files are not owned by this project. */
	readonly nestedRoots: ReadonlyArray<string>;
};

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".sfdx",
	".sf",
	".cache",
	".tatzeroko",
]);

function readManifest(file: string) {
	try {
		const json = JSON.parse(readFileSync(file, "utf8")) as {
			namespace?: unknown;
			packageDirectories?: Array<{ path?: unknown }>;
		};
		const dirs = (json.packageDirectories ?? [])
			.map((d) => d.path)
			.filter((p): p is string => typeof p === "string");
		return {
			namespace: typeof json.namespace === "string" ? json.namespace : "",
			packageDirectories: dirs,
		};
	} catch {
		return undefined;
	}
}

/** Finds every sfdx-project.json under `workspaceRoot` (including the root itself). */
export function discoverProjects(workspaceRoot: string): DxProject[] {
	const roots: string[] = [];
	const visit = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		if (entries.includes("sfdx-project.json")) roots.push(dir);
		for (const name of entries) {
			if (SKIP_DIRS.has(name)) continue;
			const full = path.join(dir, name);
			try {
				if (statSync(full).isDirectory()) visit(full);
			} catch {}
		}
	};
	visit(path.resolve(workspaceRoot));

	return roots.flatMap((root) => {
		const manifest = readManifest(path.join(root, "sfdx-project.json"));
		if (!manifest) return [];
		return [
			{
				root,
				...manifest,
				nestedRoots: roots.filter((r) => r !== root && isInside(r, root)),
			},
		];
	});
}

export function isInside(child: string, parent: string) {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Nearest-owner lookup: the deepest project whose root contains `file`. */
export function ownerOf(file: string, projects: ReadonlyArray<DxProject>) {
	let best: DxProject | undefined;
	for (const project of projects) {
		if (!isInside(file, project.root)) continue;
		if (!best || project.root.length > best.root.length) best = project;
	}
	return best;
}

/** Source files a project owns: its package directories minus nested projects. */
export function listOwnedFiles(
	project: DxProject,
	extensions: ReadonlyArray<string> = [".cls", ".trigger"],
): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (SKIP_DIRS.has(name)) continue;
			const full = path.join(dir, name);
			if (project.nestedRoots.includes(full)) continue;
			try {
				if (statSync(full).isDirectory()) visit(full);
				else if (extensions.some((e) => name.endsWith(e))) out.push(full);
			} catch {}
		}
	};
	for (const dir of project.packageDirectories) {
		visit(path.join(project.root, dir));
	}
	return out;
}
