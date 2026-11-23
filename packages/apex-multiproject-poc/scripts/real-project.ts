// Read-only validation against real, open-source Salesforce DX projects (P360 is not accessible here).
// Workspace: .cache/real-ws = trailheadapps/apex-recipes (root) + apex-enterprise-patterns/fflib-apex-common (nested).
// Nothing in the source projects is written; edits are in-memory didChange only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type DxProject,
	discoverProjects,
	listOwnedFiles,
	ownerOf,
} from "../src/discovery.ts";
import { summarizeTree } from "../src/proc-metrics.ts";
import { ApexRouter, type DiagnosticReport } from "../src/router.ts";
import {
	ApexServerInstance,
	apexInitOptions,
	tsServerSpec,
} from "../src/server-host.ts";
import { fetchServer } from "./fetch-server.ts";

const ws = path.resolve(import.meta.dirname, "..", ".cache", "real-ws");
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const evidence: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: string) => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rel = (f: string) => path.relative(ws, f);
const fsPath = (u: string) => fileURLToPath(u);
const label = (p: DxProject) => path.relative(ws, p.root) || ".";

const projects = discoverProjects(ws);
const extDir = fetchServer();
const spec = tsServerSpec(path.join(extDir, "dist", "server.node.js"));
const instances = projects.map(
	(p) =>
		new ApexServerInstance(p, spec, {
			initializationOptions: apexInitOptions(extDir),
		}),
);
const router = new ApexRouter(instances);
check(
	"discovers the 2 real projects",
	projects.length === 2,
	projects.map(label).join(", "),
);

type Target = {
	file: string;
	cls: string;
	method: string;
	line: number;
	col: number;
};
const classFiles = (p: DxProject) =>
	new Map(
		listOwnedFiles(p)
			.filter((f) => f.endsWith(".cls"))
			.map((f) => [path.basename(f, ".cls"), f]),
	);
const findTargets = (p: DxProject, max: number): Target[] => {
	const own = classFiles(p);
	const out: Target[] = [];
	const seen = new Set<string>();
	for (const file of own.values()) {
		if (/Test\.cls$|_Test|TEST/i.test(file)) continue; // production-style classes first
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
			const m = /\b([A-Za-z][A-Za-z0-9_]+)\.([a-z][A-Za-z0-9_]*)\(/.exec(
				lines[i],
			);
			if (
				!m ||
				m[1] === path.basename(file, ".cls") ||
				!own.has(m[1]) ||
				seen.has(file)
			)
				continue;
			seen.add(file);
			out.push({
				file,
				cls: m[1],
				method: m[2],
				line: i,
				col: m.index + m[1].length + 1,
			});
			break;
		}
		if (out.length >= max) break;
	}
	return out;
};

const t0 = performance.now();
await Promise.all(instances.map((i) => i.start()));
evidence.startupMs = instances.map((i) => Math.round(i.startupMs));
try {
	const tOpen = performance.now();
	const counts = projects.map((p, k) => {
		const files = listOwnedFiles(p);
		for (const f of files) instances[k].openFile(f);
		return files.length;
	});
	evidence.filesOpened = Object.fromEntries(
		projects.map((p, k) => [label(p), counts[k]]),
	);
	const targetsBy = new Map(projects.map((p) => [p, findTargets(p, 8)]));
	check(
		"found cross-file call sites in both projects",
		[...targetsBy.values()].every((t) => t.length >= 3),
		[...targetsBy].map(([p, t]) => `${label(p)}=${t.length}`).join(", "),
	);

	// Readiness: the first definition that resolves in each project.
	const readyMs: number[] = [];
	for (const [p, targets] of targetsBy) {
		const tg = targets[0];
		for (;;) {
			const d = await router.definition(tg.file, {
				line: tg.line,
				character: tg.col + 1,
			});
			if ((d?.length ?? 0) > 0) break;
			if (performance.now() - tOpen > 120_000)
				throw new Error(`${label(p)} never ready`);
			await sleep(250);
		}
		readyMs.push(Math.round(performance.now() - tOpen));
	}
	evidence.openToFirstDefinitionMs = readyMs;
	const memAfterReady = instances.map((i) => summarizeTree(i.pid as number));

	// Definitions + completions on every target.
	const rows: Array<Record<string, unknown>> = [];
	for (const [p, targets] of targetsBy) {
		const own = classFiles(p);
		for (const tg of targets) {
			const d =
				(await router.definition(tg.file, {
					line: tg.line,
					character: tg.col + 1,
				})) ?? [];
			const expected = own.get(tg.cls) as string;
			const ok =
				d.length > 0 &&
				d.every(
					(x) =>
						fsPath(x.uri) === expected ||
						ownerOf(fsPath(x.uri), projects)?.root === p.root,
				);
			const lands = d.some((x) => fsPath(x.uri) === expected);
			// Completion after "Class." — only the first completion per freshly opened document is reliable (server bug).
			const c = (
				(await router.completion(tg.file, { line: tg.line, character: tg.col }))
					?.items ?? []
			).map((i) => i.label);
			rows.push({
				project: label(p),
				call: `${tg.cls}.${tg.method}`,
				file: rel(tg.file),
				defInProject: ok,
				defLandsOnClass: lands,
				defTargets: d.map((x) => rel(fsPath(x.uri))),
				completionCount: c.length,
				completionHasMethod: c.some((l) => l.startsWith(tg.method)),
			});
		}
	}
	evidence.callSites = rows;
	for (const p of projects) {
		const r = rows.filter((x) => x.project === label(p));
		const defOk = r.filter((x) => x.defLandsOnClass).length;
		const leak = r.filter((x) => !x.defInProject).length;
		const comp = r.filter((x) => x.completionHasMethod).length;
		check(
			`${label(p)}: definitions land on the called class`,
			defOk >= Math.ceil(r.length * 0.75),
			`${defOk}/${r.length}`,
		);
		check(
			`${label(p)}: no definition outside the project`,
			leak === 0,
			`${leak} leaks`,
		);
		check(
			`${label(p)}: completion after 'Class.' offers the called method`,
			comp >= Math.ceil(r.length * 0.75),
			`${comp}/${r.length}`,
		);
	}

	// Diagnostics for every file: enrich then pull.
	const diag: Record<
		string,
		{
			files: number;
			withErrors: number;
			total: number;
			top: Array<[string, number]>;
			leakedForeignNames: number;
			leakSamples: string[];
			ms: number;
		}
	> = {};
	const names = new Map(
		projects.map((p) => [p, new Set(classFiles(p).keys())]),
	);
	for (const p of projects) {
		const t = performance.now();
		const msgCount = new Map<string, number>();
		let withErrors = 0;
		let total = 0;
		let leakedForeign = 0;
		const leakSamples: string[] = [];
		const foreignNames = new Set(
			projects
				.filter((q) => q !== p)
				.flatMap((q) =>
					[...(names.get(q) as Set<string>)].filter(
						(n) => !(names.get(p) as Set<string>).has(n),
					),
				),
		);
		const files = listOwnedFiles(p);
		for (const f of files) {
			const r: DiagnosticReport =
				await router.probeOnlyHoverPrimedDiagnosticReport(f);
			const items = r.items ?? [];
			if (items.length) withErrors++;
			total += items.length;
			for (const it of items) {
				const key = it.message
					.replace(/'[^']*'/g, "'…'")
					.replace(/\b\d+\b/g, "N")
					.slice(0, 70);
				msgCount.set(key, (msgCount.get(key) ?? 0) + 1);
				const hit = [...foreignNames].find((n) =>
					new RegExp(`\\b${n}\\b`).test(it.message),
				);
				if (hit) {
					leakedForeign++;
					leakSamples.push(`${hit}: ${it.message.slice(0, 120)}`);
				}
			}
		}
		diag[label(p)] = {
			files: files.length,
			withErrors,
			total,
			top: [...msgCount].sort((a, b) => b[1] - a[1]).slice(0, 8),
			leakedForeignNames: leakedForeign,
			leakSamples,
			ms: Math.round(performance.now() - t),
		};
		console.log(
			`   ${label(p)}: ${files.length} files, ${withErrors} with diagnostics, ${total} total, ${Math.round(performance.now() - t)} ms`,
		);
	}
	evidence.diagnostics = diag;
	for (const p of projects)
		check(
			`${label(p)}: diagnostics mention no class names that exist only in the other project`,
			diag[label(p)].leakedForeignNames === 0,
			`${diag[label(p)].leakedForeignNames}`,
		);

	// Isolation probe on real code: reference a class that only exists in the OTHER project (in-memory edit).
	const probe = async (p: DxProject, foreignClass: string) => {
		const target = [...classFiles(p).values()].find(
			(f) => !/Test/i.test(f),
		) as string;
		const inst = router.instanceFor(target);
		const src = readFileSync(target, "utf8");
		const probeText = src.replace(/\{/, `{\n    ${foreignClass} __probe = 1;`);
		inst.connection.sendNotification("textDocument/didChange", {
			textDocument: { uri: pathToFileURL(target).toString(), version: 2 },
			contentChanges: [{ text: probeText }],
		});
		await sleep(800);
		const r = await router.probeOnlyHoverPrimedDiagnosticReport(target);
		return (r.items ?? [])
			.map((i) => i.message)
			.filter((m) => m.includes(foreignClass));
	};
	const recipes = projects.find((p) => label(p) === ".") as DxProject;
	const fflib = projects.find((p) => label(p) !== ".") as DxProject;
	const inFflib = [...classFiles(fflib).keys()].find(
		(n) => !(names.get(recipes) as Set<string>).has(n) && /^fflib_/.test(n),
	) as string;
	const inRecipes = [...classFiles(recipes).keys()].find(
		(n) => !(names.get(fflib) as Set<string>).has(n),
	) as string;
	const m1 = await probe(recipes, inFflib);
	const m2 = await probe(fflib, inRecipes);
	evidence.isolationProbe = {
		recipesReferencingFflibClass: { cls: inFflib, errors: m1 },
		fflibReferencingRecipesClass: { cls: inRecipes, errors: m2 },
	};
	check(
		`apex-recipes cannot resolve a class that exists only in fflib (${inFflib})`,
		m1.length > 0,
		m1.join("; ").slice(0, 120),
	);
	check(
		`fflib cannot resolve a class that exists only in apex-recipes (${inRecipes})`,
		m2.length > 0,
		m2.join("; ").slice(0, 120),
	);

	evidence.memory = {
		afterReady: memAfterReady,
		final: instances.map((i) => summarizeTree(i.pid as number)),
	};
	evidence.totalMs = Math.round(performance.now() - t0);
	for (const i of instances) {
		const foreign = [...i.openedUris].filter(
			(u) => ownerOf(fsPath(u), projects)?.root !== i.project.root,
		);
		check(
			`${label(i.project)} server never received a foreign document`,
			foreign.length === 0,
			`${i.openedUris.size} opened`,
		);
	}
} catch (e) {
	console.error(e);
	check("no uncaught error", false, String(e));
}
const pids = instances.map((i) => i.pid as number);
await Promise.all(instances.map((i) => i.stop()));
check(
	"servers stopped",
	pids.every((pid) => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}),
);
mkdirSync(path.resolve(import.meta.dirname, "..", ".cache"), {
	recursive: true,
});
writeFileSync(
	path.resolve(
		import.meta.dirname,
		"..",
		".cache",
		"real-project-results.json",
	),
	JSON.stringify({ results, evidence }, null, 2),
);
const failed = results.filter((r) => !r.ok);
console.log(
	failed.length
		? `RESULT: ${failed.length} failure(s)`
		: "RESULT: all checks passed",
);
process.exit(failed.length ? 1 : 0);
