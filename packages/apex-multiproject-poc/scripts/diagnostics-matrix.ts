// Phase 3: diagnostics reliability under the official startup sequence, with NO hover/definition priming.
// Every row is a plain textDocument/diagnostic pull. "settle" = first time the expectation held while polling every 100 ms.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects, listOwnedFiles } from "../src/discovery.ts";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const projects = discoverProjects(ws);
const root = projects.find((p) => p.nestedRoots.length > 0) ?? projects[0];
const nested = projects.find((p) => p !== root);
if (!nested) throw new Error("fixture needs a nested project");
const mk = (p: typeof root) =>
	new ApexServerInstance(p, spec, {
		initializationOptions: apexInitOptions(extDir),
		workspaceLoad: "none",
	});
const instances = [mk(root), mk(nested)];
const router = new ApexRouter(instances);
const EDITOR = process.env.DIAG_NO_EDITOR !== "1";
const rootInst = instances[0];
const nestedInst = instances[1];
const file = (p: typeof root, n: string) =>
	listOwnedFiles(p).find((f) => f.endsWith(n)) as string;
const rootCaller = file(root, "RootCaller.cls");
const nestedCaller = file(nested, "NestedCaller.cls");
const uriOf = (f: string) => pathToFileURL(f).toString();
const pull = async (f: string) =>
	((await router.diagnosticReport(f)) as DiagnosticReport).items?.map(
		(i) => i.message,
	) ?? [];

type Row = { step: string; ok: boolean; detail: string };
const rows: Row[] = [];
const rec = (step: string, ok: boolean, detail: string) => {
	rows.push({ step, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${step} — ${detail}`);
};
/** Polls plain pulls until `pred` holds. Returns ms to settle or undefined; also reports whether the very first pull was already right. */
const settle = async (
	f: string,
	pred: (m: string[]) => boolean,
	timeoutMs = 6000,
) => {
	const t = performance.now();
	const first = pred(await pull(f));
	if (first) return { ms: Math.round(performance.now() - t), immediate: true };
	while (performance.now() - t < timeoutMs) {
		await sleep(100);
		if (pred(await pull(f)))
			return { ms: Math.round(performance.now() - t), immediate: false };
	}
	return { ms: undefined as number | undefined, immediate: false };
};
const has = (re: RegExp) => (m: string[]) => m.some((x) => re.test(x));
const lacks = (re: RegExp) => (m: string[]) => !m.some((x) => re.test(x));

try {
	await Promise.all(instances.map((i) => i.start()));
	const inits = await Promise.all(
		instances.map((i) => i.initializeWorkspace(settings)),
	);
	rec(
		"8. workspace ingestion completes on both servers",
		inits.every((i) => i.ingested),
		JSON.stringify(inits.map((i) => ({ files: i.files, readyMs: i.readyMs }))),
	);

	// 1. initial diagnostics with no priming request
	const rText = (await import("node:fs")).readFileSync(rootCaller, "utf8");
	const nText = (await import("node:fs")).readFileSync(nestedCaller, "utf8");
	rootInst.openDocument(uriOf(rootCaller), rText);
	if (EDITOR) void rootInst.editorRefresh(uriOf(rootCaller));
	nestedInst.openDocument(uriOf(nestedCaller), nText);
	if (EDITOR) void nestedInst.editorRefresh(uriOf(nestedCaller));
	const r1 = await settle(rootCaller, has(/RootOnlyBroken/));
	const n1 = await settle(nestedCaller, has(/NestedOnlyBroken/));
	rec(
		"1. initial diagnostics without hover/definition (root)",
		r1.ms !== undefined,
		`immediate=${r1.immediate} settleMs=${r1.ms}`,
	);
	rec(
		"1. initial diagnostics without hover/definition (nested)",
		n1.ms !== undefined,
		`immediate=${n1.immediate} settleMs=${n1.ms}`,
	);
	rec(
		"7. isolation: nested error absent from root, root error absent from nested",
		lacks(/NestedOnlyBroken/)(await pull(rootCaller)) &&
			lacks(/RootOnlyBroken/)(await pull(nestedCaller)),
		"plain pulls",
	);

	// 2. genuine edit (new unknown type)
	const edited = rText.replace(
		"RootOnlyBroken y = 2;",
		"RootOnlyBroken y = 2;\n        FreshUnknownType z = 3;",
	);
	rootInst.changeDocument(uriOf(rootCaller), edited);
	if (EDITOR) void rootInst.editorRefresh(uriOf(rootCaller));
	const immediate = await pull(rootCaller);
	const e = await settle(rootCaller, has(/FreshUnknownType/));
	rec(
		"2. error introduced by a genuine edit is detected",
		e.ms !== undefined,
		`pullRightAfterEditAlreadyHadIt=${has(/FreshUnknownType/)(immediate)} settleMs=${e.ms}`,
	);

	// 3. syntax error
	const syntax = rText.replace("RootOnlyBroken y = 2;", "Integer q = ;");
	rootInst.changeDocument(uriOf(rootCaller), syntax);
	if (EDITOR) void rootInst.editorRefresh(uriOf(rootCaller));
	const s = await settle(
		rootCaller,
		(m) => m.length > 0 && lacks(/RootOnlyBroken/)(m),
	);
	const sMsgs = await pull(rootCaller);
	rec(
		"3. syntax error is detected (and replaces the old error)",
		s.ms !== undefined,
		`settleMs=${s.ms} msgs=${JSON.stringify(sMsgs.slice(0, 2))}`,
	);

	// 4. correction clears
	rootInst.changeDocument(
		uriOf(rootCaller),
		rText.replace("RootOnlyBroken y = 2;", "Integer y = 2;"),
	);
	const c = await settle(rootCaller, (m) => m.length === 0);
	rec(
		"4. corrected code clears all diagnostics",
		c.ms !== undefined,
		`settleMs=${c.ms} remaining=${JSON.stringify(await pull(rootCaller))}`,
	);

	// stale check: re-introduce error then verify it never reverts to the old "clean" state after settling
	rootInst.changeDocument(uriOf(rootCaller), rText);
	if (EDITOR) void rootInst.editorRefresh(uriOf(rootCaller));
	const back = await settle(rootCaller, has(/RootOnlyBroken/));
	await sleep(1500);
	rec(
		"4b. re-introduced error is stable (no stale revert)",
		back.ms !== undefined && has(/RootOnlyBroken/)(await pull(rootCaller)),
		`settleMs=${back.ms}`,
	);

	// 5. close / reopen
	rootInst.closeDocument(uriOf(rootCaller));
	rootInst.openDocument(uriOf(rootCaller), rText);
	if (EDITOR) void rootInst.editorRefresh(uriOf(rootCaller));
	const ro = await settle(rootCaller, has(/RootOnlyBroken/));
	rec(
		"5. diagnostics after close+reopen",
		ro.ms !== undefined,
		`immediate=${ro.immediate} settleMs=${ro.ms}`,
	);

	// 6. restart of one project only; replay includes an UNSAVED edit
	const unsaved = rText.replace(
		"RootOnlyBroken y = 2;",
		"UnsavedUnknown y = 2;",
	);
	rootInst.changeDocument(uriOf(rootCaller), unsaved);
	if (EDITOR) void rootInst.editorRefresh(uriOf(rootCaller));
	await settle(rootCaller, has(/UnsavedUnknown/));
	const nestedPid = nestedInst.pid;
	const restartMs = await rootInst.restart(settings);
	if (EDITOR)
		for (const u of rootInst.docs.keys()) void rootInst.editorRefresh(u);
	const rs = await settle(rootCaller, has(/UnsavedUnknown/));
	rec(
		"6. restart replays unsaved edit and reproduces its diagnostics",
		rs.ms !== undefined && lacks(/RootOnlyBroken/)(await pull(rootCaller)),
		`restartMs=${Math.round(restartMs)} settleMs=${rs.ms}`,
	);
	rec(
		"6b. restarting root did not touch nested",
		nestedInst.pid === nestedPid &&
			has(/NestedOnlyBroken/)(await pull(nestedCaller)),
		`nestedPid=${nestedPid}`,
	);
	rec(
		"6c. restarted server only ever received its own documents",
		[...rootInst.openedUris].every(
			(u) => router.instanceFor(new URL(u).pathname) === rootInst,
		),
		`${rootInst.openedUris.size} docs`,
	);
} finally {
	await Promise.all(instances.map((i) => i.stop(2000)));
}
mkdirSync(path.join(import.meta.dirname, "..", ".cache"), { recursive: true });
writeFileSync(
	path.join(
		import.meta.dirname,
		"..",
		".cache",
		`diagnostics-matrix${process.env.APEX_LS_DIST ? "-patched" : ""}.json`,
	),
	JSON.stringify(rows, null, 2),
);
const failed = rows.filter((r) => !r.ok).length;
console.log(
	failed ? `RESULT: ${failed} failure(s)` : "RESULT: all checks passed",
);
process.exit(failed ? 1 : 0);
