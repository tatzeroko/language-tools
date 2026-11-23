// Engine comparison on IDENTICAL projects: same fixture, same two DX projects, same requests, same measurement code.
//   node scripts/engine-compare.ts typescript|jorje   (JORJE_JAR=... for jorje)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects, listOwnedFiles } from "../src/discovery.ts";
import { type ApexEngine, createEngine } from "../src/engine.ts";
import { processTreeStats } from "../src/proc-stats.ts";
import { fetchServer } from "./fetch-server.ts";

const kind = (process.argv[2] ?? "typescript") as "typescript" | "jorje";
const ws =
	process.env.CMP_WORKSPACE ??
	path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const projects = discoverProjects(ws);
const cfg =
	kind === "typescript"
		? { typescript: { extensionDir: fetchServer() } }
		: { jorje: { jar: process.env.JORJE_JAR as string } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = async <T>(fn: () => Promise<T>) => {
	const t = performance.now();
	const v = await fn();
	return [Math.round(performance.now() - t), v] as const;
};
const poll = async (fn: () => Promise<boolean>, timeout = 8000) => {
	const t = performance.now();
	while (performance.now() - t < timeout) {
		if (await fn()) return Math.round(performance.now() - t);
		await sleep(100);
	}
	return undefined;
};

const engines: ApexEngine[] = projects.map((p) => createEngine(kind, p, cfg));
const out: Record<string, unknown> = { kind };
const checks: [string, boolean][] = [];
const callerOf = (e: ApexEngine) =>
	listOwnedFiles(e.project).find((f) =>
		/(Root|Nested)Caller\.cls$/.test(f),
	) as string;
try {
	const [startWall] = await ms(() =>
		Promise.all(engines.map((e) => e.start())),
	);
	const [_readyWall, ready] = await ms(() =>
		Promise.all(engines.map((e) => e.waitReady())),
	);
	out.startupMs = startWall;
	out.readyAfterInitMs = ready.map((r) => r.ms);
	out.readyFlags = ready.map((r) => r.ready);
	const res: Record<string, unknown>[] = [];
	for (const e of engines) {
		const file = callerOf(e);
		const uri = pathToFileURL(file).toString();
		const text = readFileSync(file, "utf8");
		e.openDocument(uri, text);
		const lines = text.split("\n");
		const li = lines.findIndex((l) => l.includes("AccountService."));
		const pos = {
			line: li,
			character: lines[li].indexOf("AccountService.") + 15,
		};
		const own = /Root/.test(file) ? "rootOnlyMethod" : "nestedOnlyMethod";
		const foreign = /Root/.test(file) ? "nestedOnlyMethod" : "rootOnlyMethod";
		const comp: number[] = [];
		const compMs: number[] = [];
		let labels: string[] = [];
		for (let i = 0; i < 4; i++) {
			const [t, items] = await ms(() => e.completion(uri, pos).catch(() => []));
			compMs.push(t);
			comp.push(items.length);
			if (i === 0) labels = items.map((x) => x.label);
		}
		const [defMs, defs] = await ms(() =>
			e
				.definition(uri, { line: li, character: pos.character + 3 })
				.catch(() => []),
		);
		const brokenName = /Root/.test(file)
			? "RootOnlyBroken"
			: "NestedOnlyBroken";
		const diagSettle = await poll(async () =>
			(await e.diagnostics(uri)).some((m) => m.includes(brokenName)),
		);
		const diag = await e.diagnostics(uri);
		const stats = e.pid ? processTreeStats(e.pid) : undefined;
		res.push({
			project: path.basename(e.project.root),
			completionCounts: comp,
			completionMs: compMs,
			labels: labels.slice(0, 4),
			definitionMs: defMs,
			definitionTargets: defs.map((d) => d.uri.split("/").slice(-4).join("/")),
			diagnosticSettleMs: diagSettle,
			diagnostics: diag.slice(0, 3),
			...stats,
		});
		checks.push([
			`${path.basename(e.project.root)}: completion has own member`,
			labels.some((l) => l.includes(own)),
		]);
		checks.push([
			`${path.basename(e.project.root)}: completion never offers other project's member`,
			!labels.some((l) => l.includes(foreign)),
		]);
		checks.push([
			`${path.basename(e.project.root)}: definition resolves inside own project`,
			defs.length > 0 &&
				defs.every(
					(d) =>
						d.uri.startsWith(pathToFileURL(e.project.root).toString()) &&
						!e.project.nestedRoots.some((n) =>
							d.uri.startsWith(pathToFileURL(n).toString()),
						),
				),
		]);
		checks.push([
			`${path.basename(e.project.root)}: repeated completion stable`,
			comp.every((c) => c === comp[0]) && comp[0] > 0,
		]);
		checks.push([
			`${path.basename(e.project.root)}: own semantic error reported`,
			diagSettle !== undefined,
		]);
		checks.push([
			`${path.basename(e.project.root)}: no foreign error in diagnostics`,
			!diag.some(
				(m) => /(Root|Nested)OnlyBroken/.test(m) && !m.includes(brokenName),
			),
		]);
	}
	out.perProject = res;
	// restart first project only, with an unsaved edit
	const e0 = engines[0];
	const f0 = callerOf(e0);
	const u0 = pathToFileURL(f0).toString();
	e0.changeDocument(u0, `${readFileSync(f0, "utf8")}\n// unsaved`);
	const pid1 = engines[1].pid;
	const [restartMs] = await ms(() => e0.restart());
	out.restartMs = restartMs;
	checks.push([
		"restart of project 0 left project 1 untouched",
		engines[1].pid === pid1 && engines[1].alive,
	]);
	const comp = await e0
		.completion(u0, { line: 0, character: 0 })
		.catch(() => []);
	out.completionAfterRestartCount = comp.length;
} finally {
	const pids = engines.map((e) => e.pid);
	await Promise.all(engines.map((e) => e.stop()));
	await sleep(300);
	out.orphans = pids.filter(
		(p) =>
			p &&
			(() => {
				try {
					process.kill(p, 0);
					return true;
				} catch {
					return false;
				}
			})(),
	);
}
checks.push(["no orphans", (out.orphans as number[]).length === 0]);
for (const [n, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${n}`);
console.log("MEASURED", JSON.stringify(out));
mkdirSync(path.join(import.meta.dirname, "..", ".cache"), { recursive: true });
writeFileSync(
	path.join(import.meta.dirname, "..", ".cache", `engine-compare-${kind}.json`),
	JSON.stringify({ checks, out }, null, 2),
);
