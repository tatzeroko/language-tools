// Lifecycle e2e: edits, stale diagnostics, per-project restart, crash, cancellation, shutdown.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CancellationTokenSource } from "vscode-languageserver-protocol";
import {
	type DxProject,
	discoverProjects,
	listOwnedFiles,
	ownerOf,
} from "../src/discovery.ts";
import { summarizeTree } from "../src/proc-metrics.ts";
import {
	ApexRouter,
	type DiagnosticReport,
	ServerUnavailableError,
} from "../src/router.ts";
import {
	ApexServerInstance,
	apexInitOptions,
	tsServerSpec,
} from "../src/server-host.ts";
import { fetchServer } from "./fetch-server.ts";

const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const extDir = fetchServer();
const spec = tsServerSpec(path.join(extDir, "dist", "server.node.js"));
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail?: string) => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uriOf = (f: string) => pathToFileURL(f).toString();
const rel = (f: string) => path.relative(ws, f);

const projects = discoverProjects(ws);
const root = projects.find((p) => p.nestedRoots.length > 0) as DxProject;
const nested = projects.find((p) => p !== root) as DxProject;
const make = (p: DxProject) =>
	new ApexServerInstance(p, spec, {
		initializationOptions: apexInitOptions(extDir),
	});
const find = (p: DxProject, n: string) =>
	listOwnedFiles(p).find((f) => f.endsWith(n)) as string;
const rootCaller = find(root, "RootCaller.cls");
const nestedCaller = find(nested, "NestedCaller.cls");
const nestedService = find(nested, "AccountService.cls");
const text = new Map<string, string>(
	[...listOwnedFiles(root), ...listOwnedFiles(nested)].map((f) => [
		f,
		readFileSync(f, "utf8"),
	]),
);
const versions = new Map<string, number>();

const posOf = (file: string, needle: string, delta = 0) => {
	const lines = (text.get(file) as string).split("\n");
	const line = lines.findIndex((l) => l.includes(needle));
	return { line, character: lines[line].indexOf(needle) + delta };
};
const edit = (router: ApexRouter, file: string, next: string) => {
	const v = (versions.get(file) ?? 1) + 1;
	versions.set(file, v);
	text.set(file, next);
	router
		.instanceFor(file)
		.connection.sendNotification("textDocument/didChange", {
			textDocument: { uri: uriOf(file), version: v },
			contentChanges: [{ text: next }],
		});
};
const msgs = (r: DiagnosticReport) => (r.items ?? []).map((d) => d.message);
const definitionCount = async (
	router: ApexRouter,
	file: string,
	needle: string,
	delta: number,
) => ((await router.definition(file, posOf(file, needle, delta))) ?? []).length;
const waitReady = async (
	router: ApexRouter,
	file: string,
	needle: string,
	delta: number,
) => {
	const t = performance.now();
	for (;;) {
		if ((await definitionCount(router, file, needle, delta)) > 0)
			return Math.round(performance.now() - t);
		if (performance.now() - t > 60_000)
			throw new Error(`not ready: ${rel(file)}`);
		await sleep(100);
	}
};
const nestedReady = (r: ApexRouter) =>
	waitReady(r, nestedCaller, "AccountService.nestedOnlyMethod", 18);
const rootReady = (r: ApexRouter) =>
	waitReady(r, rootCaller, "AccountService.rootOnlyMethod", 18);
const dotPos = (file: string) => posOf(file, "AccountService.", 15);
const completionLabels = async (r: ApexRouter, file: string) =>
	((await r.completion(file, dotPos(file)))?.items ?? []).map((i) => i.label);
const alivePids = (pids: number[]) =>
	pids.filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});

const instances = { root: make(root), nested: make(nested) };
const router = new ApexRouter([instances.root, instances.nested]);
await Promise.all([instances.root.start(), instances.nested.start()]);
for (const i of Object.values(instances)) i.openOwnedFiles();
await Promise.all([rootReady(router), nestedReady(router)]);
const allPids = [instances.root.pid as number, instances.nested.pid as number];
try {
	// ---- L1: edits and stale diagnostics -------------------------------------------------
	console.log("\n== L1 edits / stale diagnostics");
	const pullE = (f: string) => router.enrichedDiagnosticReport(f);
	const has = (r: DiagnosticReport, re: RegExp) =>
		msgs(r).some((m) => re.test(m));
	check(
		"nested error present before edit (enriched pull)",
		has(await pullE(nestedCaller), /NestedOnlyBroken/),
	);
	const original = text.get(nestedCaller) as string;
	edit(
		router,
		nestedCaller,
		original.replace("NestedOnlyBroken x = 1;", "Integer x = 1;"),
	);
	const dImmediate = await router.diagnosticReport(nestedCaller);
	notes.diagnosticImmediatelyAfterChange = {
		stale: has(dImmediate, /NestedOnlyBroken/),
		messages: msgs(dImmediate),
	};
	console.log(
		`   (info) raw pull immediately after didChange: stale=${has(dImmediate, /NestedOnlyBroken/)}`,
	);
	await sleep(1000);
	const dFixed = await pullE(nestedCaller);
	check(
		"nested error cleared after the fix (enriched pull)",
		!has(dFixed, /NestedOnlyBroken/),
		msgs(dFixed).join("; "),
	);
	check(
		"root error unaffected by nested edit",
		has(await pullE(rootCaller), /RootOnlyBroken/),
	);
	edit(router, nestedCaller, original);
	await sleep(1000);
	const dRaw = await router.diagnosticReport(nestedCaller);
	notes.rawPullAfterReintroducing = {
		semanticErrorReported: has(dRaw, /NestedOnlyBroken/),
	};
	console.log(
		`   (info) raw pull after re-introducing the error, before any enrichment: reported=${has(dRaw, /NestedOnlyBroken/)}`,
	);
	check(
		"nested error returns after re-introducing it (enriched pull)",
		has(await pullE(nestedCaller), /NestedOnlyBroken/),
	);
	const rootEdited = (text.get(rootCaller) as string).replace(
		"RootOnlyBroken y = 2;",
		"NestedOnlyBroken y = 2;",
	);
	edit(router, rootCaller, rootEdited);
	await sleep(1000);
	const dRootEdited = await pullE(rootCaller);
	check(
		"root file naming a nested-only type reports an error (no cross-project resolution)",
		has(dRootEdited, /Illegal assignment from 2 to NestedOnlyBroken/),
		msgs(dRootEdited).join("; "),
	);
	edit(
		router,
		rootCaller,
		rootEdited.replace("NestedOnlyBroken y = 2;", "RootOnlyBroken y = 2;"),
	);
	await sleep(600);

	// ---- L2: planned restart of ONE project ---------------------------------------------
	console.log("\n== L2 restart nested only");
	const rootPidBefore = instances.root.pid;
	const nestedPidBefore = instances.nested.pid;
	await instances.nested.stop();
	check(
		"stopped nested server exited cleanly",
		instances.nested.exitInfo?.requested === true,
		JSON.stringify(instances.nested.exitInfo),
	);
	let unavailable: unknown;
	try {
		await router.completion(nestedService, dotPos(nestedService));
	} catch (e) {
		unavailable = e;
	}
	check(
		"request for stopped project fails with ServerUnavailableError (no wrong-project answer)",
		unavailable instanceof ServerUnavailableError,
		String(unavailable),
	);
	const t = performance.now();
	const rootDuring = await router.definition(
		rootCaller,
		posOf(rootCaller, "AccountService.rootOnlyMethod", 18),
	);
	check(
		"root keeps answering while nested is down",
		(rootDuring?.length ?? 0) > 0,
		`${Math.round(performance.now() - t)} ms`,
	);
	const fresh = make(nested);
	await fresh.start();
	router.replace(fresh);
	fresh.openOwnedFiles();
	// A restarted server re-reads from disk: unsaved in-memory edits must be replayed by the client.
	const readyMs = await nestedReady(router);
	instances.nested = fresh;
	allPids.push(fresh.pid as number);
	check(
		"restarted nested has a new pid; root pid unchanged",
		fresh.pid !== nestedPidBefore && instances.root.pid === rootPidBefore,
		`${nestedPidBefore}->${fresh.pid}, root ${rootPidBefore}`,
	);
	const dNestedAfter = await pullE(nestedCaller);
	check(
		"restarted nested serves its own diagnostics",
		msgs(dNestedAfter).some((m) => /NestedOnlyBroken/.test(m)),
	);
	const rootDiagAfter = await pullE(rootCaller);
	check(
		"nested restart did not change root diagnostics",
		msgs(rootDiagAfter).some((m) => /RootOnlyBroken/.test(m)) &&
			!msgs(rootDiagAfter).some((m) => /NestedOnlyBroken/.test(m)),
	);
	notes.restartNestedReadyMs = readyMs;
	notes.restartNestedStartupMs = Math.round(fresh.startupMs);

	// ---- L3: crash (SIGKILL) -----------------------------------------------------------
	console.log("\n== L3 crash");
	const victim = instances.nested;
	const inflight = router.completion(nestedService, dotPos(nestedService)).then(
		() => "answered",
		(e: Error) => `rejected: ${e.message}`,
	);
	process.kill(victim.pid as number, "SIGKILL");
	const inflightOutcome = await Promise.race([
		inflight,
		sleep(10_000).then(() => "HUNG"),
	]);
	notes.inflightRequestDuringCrash = inflightOutcome;
	check(
		"in-flight request during crash settles (no hang)",
		inflightOutcome !== "HUNG",
		inflightOutcome,
	);
	await sleep(300);
	check("crash is detected", victim.crashed, JSON.stringify(victim.exitInfo));
	let crashErr: unknown;
	try {
		await router.diagnosticReport(nestedCaller);
	} catch (e) {
		crashErr = e;
	}
	check(
		"requests for crashed project fail fast with ServerUnavailableError",
		crashErr instanceof ServerUnavailableError,
		String(crashErr),
	);
	check(
		"root unaffected by nested crash",
		(
			await router.definition(
				rootCaller,
				posOf(rootCaller, "AccountService.rootOnlyMethod", 18),
			)
		)?.length === 1,
	);
	const rootDiagCrash = await pullE(rootCaller);
	check(
		"root diagnostics unaffected by nested crash",
		!msgs(rootDiagCrash).some((m) => /NestedOnlyBroken/.test(m)) &&
			msgs(rootDiagCrash).some((m) => /RootOnlyBroken/.test(m)),
	);
	const recovered = make(nested);
	await recovered.start();
	router.replace(recovered);
	recovered.openOwnedFiles();
	await nestedReady(router);
	instances.nested = recovered;
	allPids.push(recovered.pid as number);
	const dRec = await pullE(nestedCaller);
	check(
		"nested recovered after crash with correct diagnostics",
		msgs(dRec).some((m) => /NestedOnlyBroken/.test(m)) &&
			!msgs(dRec).some((m) => /RootOnlyBroken/.test(m)),
	);
	const labels = await completionLabels(router, nestedService);
	check(
		"nested recovered completion routed correctly",
		labels.some((l) => l.startsWith("nestedOnlyMethod")) &&
			!labels.some((l) => l.startsWith("rootOnlyMethod")),
		labels.join(","),
	);
	// Crash the root server instead (symmetry).
	const rootVictim = instances.root;
	process.kill(rootVictim.pid as number, "SIGKILL");
	await sleep(300);
	check("root crash detected", rootVictim.crashed);
	check(
		"nested keeps answering while root is down",
		(
			await router.definition(
				nestedCaller,
				posOf(nestedCaller, "AccountService.nestedOnlyMethod", 18),
			)
		)?.length === 1,
	);
	const rootRecovered = make(root);
	await rootRecovered.start();
	router.replace(rootRecovered);
	rootRecovered.openOwnedFiles();
	await rootReady(router);
	instances.root = rootRecovered;
	allPids.push(rootRecovered.pid as number);
	check(
		"root recovered",
		msgs(await pullE(rootCaller)).some((m) => /RootOnlyBroken/.test(m)),
	);

	// ---- L4: cancellation -------------------------------------------------------------
	console.log("\n== L4 cancellation");
	const cancelOutcome = async (
		fn: (tok: CancellationTokenSource["token"]) => Promise<unknown>,
	) => {
		const src = new CancellationTokenSource();
		const p = fn(src.token).then(
			(v) => `answered:${JSON.stringify(v).slice(0, 60)}`,
			(e: { code?: number; message?: string }) =>
				`rejected:${e.code ?? ""}:${e.message ?? e}`,
		);
		src.cancel();
		return Promise.race([p, sleep(10_000).then(() => "HUNG")]);
	};
	const inst = router.instanceFor(nestedService);
	const pos = dotPos(nestedService);
	const c1 = await cancelOutcome((tok) =>
		inst.connection.sendRequest(
			"textDocument/completion",
			{ textDocument: { uri: uriOf(nestedService) }, position: pos },
			tok,
		),
	);
	const c2 = await cancelOutcome((tok) =>
		inst.connection.sendRequest(
			"textDocument/diagnostic",
			{ textDocument: { uri: uriOf(nestedCaller) } },
			tok,
		),
	);
	notes.cancellation = { completion: c1, diagnostic: c2 };
	console.log(`   completion cancel -> ${c1}\n   diagnostic cancel -> ${c2}`);
	check("cancelled requests settle (no hang)", c1 !== "HUNG" && c2 !== "HUNG");
	const afterCancel = await pullE(nestedCaller);
	check(
		"server healthy after cancellation (diagnostics still correct)",
		msgs(afterCancel).some((m) => /NestedOnlyBroken/.test(m)),
	);
	check(
		"other project unaffected by cancellation",
		(
			await router.definition(
				rootCaller,
				posOf(rootCaller, "AccountService.rootOnlyMethod", 18),
			)
		)?.length === 1,
	);
	// Cancel a burst of requests, then confirm ordering/answers remain correct.
	const burst = await Promise.all(
		Array.from({ length: 20 }, () =>
			cancelOutcome((tok) =>
				inst.connection.sendRequest(
					"textDocument/definition",
					{
						textDocument: { uri: uriOf(nestedCaller) },
						position: posOf(
							nestedCaller,
							"AccountService.nestedOnlyMethod",
							18,
						),
					},
					tok,
				),
			),
		),
	);
	notes.cancelBurst = {
		answered: burst.filter((b) => b.startsWith("answered")).length,
		rejected: burst.filter((b) => b.startsWith("rejected")).length,
	};
	check(
		"after 20 cancelled definitions the next definition is correct",
		(await definitionCount(
			router,
			nestedCaller,
			"AccountService.nestedOnlyMethod",
			18,
		)) === 1,
	);

	// ---- L5: isolation + shutdown -------------------------------------------------------
	console.log("\n== L5 isolation + shutdown");
	for (const i of [instances.root, instances.nested]) {
		const foreign = [...i.openedUris].filter(
			(u) => ownerOf(fileURLToPath(u), projects)?.root !== i.project.root,
		);
		check(
			`${rel(i.project.root) || "."} server never received a foreign document (incl. after restarts)`,
			foreign.length === 0,
		);
	}
	const trees = [instances.root, instances.nested].map((i) =>
		summarizeTree(i.pid as number),
	);
	notes.finalProcessCounts = trees.map((t) => t.processes);
	const inflightStop = router
		.diagnosticReport(nestedCaller)
		.catch(() => "rejected");
	await Promise.all([instances.root.stop(), instances.nested.stop()]);
	await inflightStop;
	await sleep(200);
	const survivors = alivePids(allPids);
	check(
		"all servers ever started are gone (no orphans)",
		survivors.length === 0,
		survivors.length ? `alive: ${survivors}` : `${allPids.length} pids checked`,
	);
} catch (e) {
	console.error(e);
	results.push({ check: "uncaught", ok: false, detail: String(e) });
	await Promise.all(Object.values(instances).map((i) => i.stop(1000)));
}
mkdirSync(path.resolve(import.meta.dirname, "..", ".cache"), {
	recursive: true,
});
writeFileSync(
	path.resolve(import.meta.dirname, "..", ".cache", "lifecycle-results.json"),
	JSON.stringify({ results, notes }, null, 2),
);
console.log("NOTES", JSON.stringify(notes));
const failed = results.filter((r) => !r.ok);
console.log(
	failed.length
		? `RESULT: ${failed.length} failure(s)`
		: "RESULT: all checks passed",
);
process.exit(failed.length ? 1 : 0);
