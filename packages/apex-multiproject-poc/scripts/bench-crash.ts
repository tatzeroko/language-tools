// Phase 4 + 7: one bounded run. SIGKILL recovery with unsaved-text replay, plus latency / memory numbers.
// Memory: RSS and PSS (smaps_rollup) of the server process (workers are threads inside it, so process == tree here;
// child processes are summed via /proc/*/stat ppid walk). Threads from /proc/<pid>/status.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects, listOwnedFiles } from "../src/discovery.ts";
import { processTreeStats } from "../src/proc-stats.ts";
import { ApexRouter, type DiagnosticReport } from "../src/router.ts";
import {
	ApexServerInstance,
	apexInitOptions,
	tsServerSpec,
} from "../src/server-host.ts";
import { fetchServer } from "./fetch-server.ts";

const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const extDir = process.env.APEX_LS_DIST
	? path.dirname(process.env.APEX_LS_DIST)
	: fetchServer();
const spec = tsServerSpec(path.join(extDir, "dist", "server.node.js"));
const settings = {
	apex: {
		environment: { runtimePlatform: "desktop", serverMode: "development" },
	},
};
const projects = discoverProjects(ws);
const root = projects.find((p) => p.nestedRoots.length > 0) ?? projects[0];
const nested = projects.find((p) => p !== root);
if (!nested) throw new Error("fixture needs a nested project");
const mk = (p: typeof root) =>
	new ApexServerInstance(p, spec, {
		initializationOptions: apexInitOptions(extDir),
		workspaceLoad: "none",
	});
const [rootInst, nestedInst] = [mk(root), mk(nested)];
const router = new ApexRouter([rootInst, nestedInst]);
const uriOf = (f: string) => pathToFileURL(f).toString();
const ms = async <T>(fn: () => Promise<T>) => {
	const t = performance.now();
	const v = await fn();
	return [Math.round(performance.now() - t), v] as const;
};
const mem = processTreeStats;
const rootCaller = listOwnedFiles(root).find((f) =>
	f.endsWith("RootCaller.cls"),
) as string;
const nestedCaller = listOwnedFiles(nested).find((f) =>
	f.endsWith("NestedCaller.cls"),
) as string;
const out: Record<string, unknown> = {};
const checks: [string, boolean][] = [];
try {
	const [startWall] = await ms(() =>
		Promise.all([rootInst.start(), nestedInst.start()]),
	);
	const [readyWall, inits] = await ms(() =>
		Promise.all(
			[rootInst, nestedInst].map((i) => i.initializeWorkspace(settings)),
		),
	);
	out.startupParallelMs = startWall;
	out.workspaceReadyMs = inits.map((i) => i.readyMs);
	out.initializeWorkspaceWallMs = readyWall;
	const text = readFileSync(rootCaller, "utf8");
	rootInst.openDocument(uriOf(rootCaller), text);
	nestedInst.openDocument(
		uriOf(nestedCaller),
		readFileSync(nestedCaller, "utf8"),
	);
	const lines = text.split("\n");
	const li = lines.findIndex((l) => l.includes("AccountService."));
	const position = {
		line: li,
		character: lines[li].indexOf("AccountService.") + 15,
	};
	const comp = () =>
		rootInst.connection.sendRequest("textDocument/completion", {
			textDocument: { uri: uriOf(rootCaller) },
			position,
		});
	out.firstCompletionMs = (await ms(comp))[0];
	out.repeatedCompletionMs = (await ms(comp))[0];
	out.definitionMs = (
		await ms(() =>
			rootInst.connection.sendRequest("textDocument/definition", {
				textDocument: { uri: uriOf(rootCaller) },
				position: { line: li, character: position.character - 3 },
			}),
		)
	)[0];
	void rootInst.editorRefresh(uriOf(rootCaller));
	const t0 = performance.now();
	let d: DiagnosticReport = (await router.diagnosticReport(
		rootCaller,
	)) as DiagnosticReport;
	while (!d.items?.length && performance.now() - t0 < 5000) {
		await new Promise((r) => setTimeout(r, 50));
		d = (await router.diagnosticReport(rootCaller)) as DiagnosticReport;
	}
	out.firstDiagnosticMs = Math.round(performance.now() - t0);
	out.memory = {
		root: mem(rootInst.pid as number),
		nested: mem(nestedInst.pid as number),
	};

	// SIGKILL root with an unsaved edit tracked; nested must stay up; restart must replay unsaved text.
	const unsaved = text.replace(
		"RootOnlyBroken y = 2;",
		"UnsavedUnknown y = 2;",
	);
	rootInst.changeDocument(uriOf(rootCaller), unsaved);
	const nestedPid = nestedInst.pid;
	const oldPid = rootInst.pid as number;
	process.kill(oldPid, "SIGKILL");
	const inflight = await Promise.race([
		comp().then(
			() => "answered",
			(e: Error) => `rejected: ${e.message}`,
		),
		new Promise((r) => setTimeout(() => r("hung"), 5000)),
	]);
	out.requestAfterKill = inflight;
	checks.push([
		"request to killed server settles (no hang)",
		inflight !== "hung",
	]);
	checks.push(["crash detected", rootInst.crashed || !rootInst.alive]);
	checks.push([
		"nested alive during root outage",
		nestedInst.alive && nestedInst.pid === nestedPid,
	]);
	const [restartMs] = await ms(() => rootInst.restart(settings));
	out.crashRestartMs = restartMs;
	checks.push([
		"replayed doc text equals unsaved text",
		rootInst.docs.get(uriOf(rootCaller))?.text === unsaved,
	]);
	checks.push(["restart produced a new pid", rootInst.pid !== oldPid]);
	checks.push([
		"restarted root received only owned docs",
		[...rootInst.openedUris].every(
			(u) => router.instanceFor(new URL(u).pathname) === rootInst,
		),
	]);
	void rootInst.editorRefresh(uriOf(rootCaller));
	const t1 = performance.now();
	let ok = false;
	while (performance.now() - t1 < 6000 && !ok) {
		const r = (await router.diagnosticReport(rootCaller)) as DiagnosticReport;
		ok = !!r.items?.some((i) => /UnsavedUnknown/.test(i.message));
		if (!ok) {
			await new Promise((r2) => setTimeout(r2, 100));
			if (Math.round(performance.now() - t1) % 1000 < 150)
				void rootInst.editorRefresh(uriOf(rootCaller));
		}
	}
	checks.push([
		"diagnostics for unsaved edit reproduced after crash replay",
		ok,
	]);
	out.postCrashDiagnosticMs = Math.round(performance.now() - t1);
	void nestedInst.editorRefresh(uriOf(nestedCaller));
	await new Promise((r) => setTimeout(r, 500));
	const nd = (await router.diagnosticReport(nestedCaller)) as DiagnosticReport;
	checks.push([
		"nested diagnostics unaffected by root crash",
		!!nd.items?.some((i) => /NestedOnlyBroken/.test(i.message)),
	]);
} finally {
	const pids = [rootInst.pid, nestedInst.pid];
	await Promise.all([rootInst, nestedInst].map((i) => i.stop(2000)));
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
checks.push(["no orphan processes", (out.orphans as number[]).length === 0]);
for (const [n, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${n}`);
console.log("MEASURED", JSON.stringify(out));
mkdirSync(path.join(import.meta.dirname, "..", ".cache"), { recursive: true });
writeFileSync(
	path.join(import.meta.dirname, "..", ".cache", "bench-crash.json"),
	JSON.stringify({ checks, out }, null, 2),
);
process.exit(checks.every(([, o]) => o) ? 0 : 1);
