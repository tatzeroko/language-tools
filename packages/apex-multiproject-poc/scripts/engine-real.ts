// Same two real, indexed projects (apex-recipes + nested fflib under .cache/real-ws) through both engines.
//   node scripts/engine-real.ts typescript|jorje
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects, listOwnedFiles } from "../src/discovery.ts";
import { createEngine } from "../src/engine.ts";
import { processTreeStats } from "../src/proc-stats.ts";
import { fetchServer } from "./fetch-server.ts";

const kind = (process.argv[2] ?? "typescript") as "typescript" | "jorje";
const ws =
	process.env.REAL_WS ??
	path.resolve(import.meta.dirname, "..", ".cache", "real-ws");
const cfg =
	kind === "typescript"
		? { typescript: { extensionDir: fetchServer() } }
		: { jorje: { jar: process.env.JORJE_JAR as string } };
const projects = discoverProjects(ws);
const engines = projects.map((p) => createEngine(kind, p, cfg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timed = async <T>(fn: () => Promise<T>) => {
	const t = performance.now();
	const v = await fn();
	return [Math.round(performance.now() - t), v] as const;
};
const median = (a: number[]) =>
	[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out: Record<string, unknown> = { kind };
const results: Record<string, unknown>[] = [];
try {
	const [startMs] = await timed(() =>
		Promise.all(engines.map((e) => e.start())),
	);
	const [, ready] = await timed(() =>
		Promise.all(engines.map((e) => e.waitReady())),
	);
	out.startupMs = startMs;
	out.readyAfterInitMs = ready.map((r) => r.ms);
	out.ready = ready.map((r) => r.ready);
	for (const e of engines) {
		const files = listOwnedFiles(e.project);
		const names = new Set(files.map((f) => path.basename(f, ".cls")));
		const sites: {
			file: string;
			line: number;
			col: number;
			cls: string;
			member: string;
		}[] = [];
		for (const f of files) {
			if (!f.endsWith(".cls") || sites.length >= 8) continue;
			const lines = readFileSync(f, "utf8").split("\n");
			lines.forEach((l, i) => {
				if (/^\s*(\*|\/\/|\/\*)/.test(l)) return;
				for (const m of l.matchAll(/\b([A-Z]\w+)\.(\w+)\(/g)) {
					if (
						sites.length < 8 &&
						names.has(m[1]) &&
						m[1] !== path.basename(f, ".cls") &&
						!sites.some((s) => s.file === f)
					)
						sites.push({
							file: f,
							line: i,
							col: (m.index ?? 0) + m[1].length + 1,
							cls: m[1],
							member: m[2],
						});
				}
			});
		}
		let compOk = 0;
		let defOk = 0;
		let defInside = 0;
		const compMs: number[] = [];
		const compRepeatMs: number[] = [];
		const defMs: number[] = [];
		const repeatStable: boolean[] = [];
		for (const s of sites) {
			const uri = pathToFileURL(s.file).toString();
			e.openDocument(uri, readFileSync(s.file, "utf8"));
			await sleep(150);
			const [t1, c1] = await timed(() =>
				e.completion(uri, { line: s.line, character: s.col }).catch(() => []),
			);
			const [t2, c2] = await timed(() =>
				e.completion(uri, { line: s.line, character: s.col }).catch(() => []),
			);
			compMs.push(t1);
			compRepeatMs.push(t2);
			if (c1.some((x) => x.label.startsWith(s.member))) compOk++;
			repeatStable.push(c2.length === c1.length && c1.length > 0);
			const [t3, d] = await timed(() =>
				e
					.definition(uri, { line: s.line, character: s.col - s.cls.length })
					.catch(() => []),
			);
			defMs.push(t3);
			if (d.some((x) => x.uri.endsWith(`${s.cls}.cls`))) defOk++;
			if (
				d.length > 0 &&
				d.every(
					(x) =>
						x.uri.startsWith(pathToFileURL(e.project.root).toString()) &&
						!e.project.nestedRoots.some((n) =>
							x.uri.startsWith(pathToFileURL(n).toString()),
						),
				)
			)
				defInside++;
		}
		// diagnostics on a bounded sample (first 15 owned classes), counted after a settle
		const sample = files.filter((f) => f.endsWith(".cls")).slice(0, 15);
		let diagTotal = 0;
		let diagFiles = 0;
		const [diagMs] = await timed(async () => {
			for (const f of sample) {
				const uri = pathToFileURL(f).toString();
				e.openDocument(uri, readFileSync(f, "utf8"));
			}
			await sleep(1500);
			for (const f of sample) {
				const n = (
					await e.diagnostics(pathToFileURL(f).toString()).catch(() => [])
				).length;
				diagTotal += n;
				if (n) diagFiles++;
			}
		});
		results.push({
			project: path.relative(ws, e.project.root) || ".",
			ownedFiles: files.length,
			sites: sites.length,
			completionHasMember: compOk,
			repeatedCompletionStable: repeatStable.filter(Boolean).length,
			definitionOnClass: defOk,
			definitionInsideProject: defInside,
			firstCompletionMedianMs: median(compMs),
			repeatCompletionMedianMs: median(compRepeatMs),
			definitionMedianMs: median(defMs),
			diagSample: sample.length,
			diagTotal,
			diagFiles,
			diagMs,
			...(e.pid ? processTreeStats(e.pid) : {}),
		});
	}
	out.results = results;
} finally {
	await Promise.all(engines.map((e) => e.stop()));
}
console.log("MEASURED", JSON.stringify(out, null, 1));
mkdirSync(path.join(import.meta.dirname, "..", ".cache"), { recursive: true });
writeFileSync(
	path.join(import.meta.dirname, "..", ".cache", `engine-real-${kind}.json`),
	JSON.stringify(out, null, 2),
);
