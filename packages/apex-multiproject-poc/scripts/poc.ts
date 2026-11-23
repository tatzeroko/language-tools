import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type DxProject,
	discoverProjects,
	listOwnedFiles,
	ownerOf,
} from "../src/discovery.ts";
import { cgroupMemoryMb, summarizeTree } from "../src/proc-metrics.ts";
import { ApexRouter } from "../src/router.ts";
import {
	ApexServerInstance,
	developmentModeOptions,
	jorjeSpec,
	type ServerOptions,
	tsServerSpec,
} from "../src/server-host.ts";
import { fetchServer } from "./fetch-server.ts";

const fixture = path.resolve(
	import.meta.dirname,
	"..",
	"fixtures",
	"p360-like",
);
const workspace = process.argv[2] ? path.resolve(process.argv[2]) : fixture;
const cacheDir = path.resolve(import.meta.dirname, "..", ".cache");
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const rel = (p: string) => path.relative(workspace, p) || ".";
const label = (p: DxProject) => rel(p.root);
const fsPath = (uri: string) => fileURLToPath(uri);

// APEX_POC_MODE=development (default) | custom (production + apex.custom enabling only
// completion/definition/diagnostic).
const mode = process.env.APEX_POC_MODE ?? "development";
const options: ServerOptions =
	mode === "custom"
		? {
				initializationOptions: {
					apex: {
						custom: {
							completionProvider: {
								resolveProvider: false,
								triggerCharacters: ["."],
							},
							definitionProvider: true,
							diagnosticProvider: {
								identifier: "apex-ls-ts",
								interFileDependencies: true,
								workspaceDiagnostics: false,
							},
						},
					},
				},
			}
		: { initializationOptions: developmentModeOptions };

const spec = process.env.JORJE_JAR
	? jorjeSpec(process.env.JORJE_JAR)
	: tsServerSpec(path.join(fetchServer(), "dist", "server.node.js"));

const projects = discoverProjects(workspace);
check(
	"discovers >= 2 projects",
	projects.length >= 2,
	projects.map(label).join(", "),
);
const root = projects.find((p) => p.nestedRoots.length > 0) ?? projects[0];
const nested = projects.find((p) => p !== root) as DxProject;

const instances = projects.map((p) => new ApexServerInstance(p, spec, options));
const instanceOf = (p: DxProject) => instances[projects.indexOf(p)];
const evidence: Record<string, unknown> = { mode };
let exitCode = 0;

try {
	const tSpawn = performance.now();
	await Promise.all(instances.map((i) => i.start()));
	evidence.startup = {
		definition:
			"spawn() -> initialize response received (both servers started in parallel)",
		perServerMs: instances.map((i) => Math.round(i.startupMs)),
		wallMs: Math.round(performance.now() - tSpawn),
	};
	check(
		"servers have distinct pids",
		new Set(instances.map((i) => i.pid)).size === instances.length,
	);
	const metricsAfterInit = instances.map((i) => summarizeTree(i.pid as number));

	// Open every owned document, then poll until each server answers a real completion.
	const tOpen = performance.now();
	for (const i of instances) i.openOwnedFiles();
	const router = new ApexRouter(instances);
	const find = (p: DxProject, name: string) =>
		listOwnedFiles(p).find((f) => f.endsWith(name)) as string;
	const pos = (file: string, needle: string, delta = 0) => {
		const lines = readFileSync(file, "utf8").split("\n");
		const line = lines.findIndex((l) => l.includes(needle));
		return { line, character: lines[line].indexOf(needle) + delta };
	};
	const ownMethod = new Map([
		[root, "rootOnlyMethod"],
		[nested, "nestedOnlyMethod"],
	]);
	const readyMs: number[] = [];
	// The server answers the first completion at a position, then returns
	// {items: [], isIncomplete: true} for repeats, so keep the first good answer.
	const firstLabels = new Map<DxProject, string[]>();
	const repeatItems: Record<string, number> = {};
	for (const p of [root, nested]) {
		const file = find(p, "AccountService.cls");
		const deadline = Date.now() + 60_000;
		for (;;) {
			const items =
				(await router.completion(file, pos(file, "AccountService.", 15)))
					?.items ?? [];
			if (items.some((i) => i.label.startsWith(ownMethod.get(p) as string))) {
				firstLabels.set(
					p,
					items.map((i) => i.label),
				);
				repeatItems[label(p)] =
					(await router.completion(file, pos(file, "AccountService.", 15)))
						?.items.length ?? 0;
				break;
			}
			if (Date.now() > deadline)
				throw new Error(`${label(p)} never became ready`);
			await new Promise((r) => setTimeout(r, 100));
		}
		readyMs.push(Math.round(performance.now() - tOpen));
	}
	evidence.readiness = {
		definition:
			"didOpen of all owned files -> first completion containing the project's own member",
		perServerMs: readyMs,
	};
	const metricsAfterReady = instances.map((i) =>
		summarizeTree(i.pid as number),
	);

	// Completion
	const t0 = performance.now();
	for (const [p, own, foreign] of [
		[root, "rootOnlyMethod", "nestedOnlyMethod"],
		[nested, "nestedOnlyMethod", "rootOnlyMethod"],
	] as const) {
		const labels = firstLabels.get(p) ?? [];
		check(
			`completion routed to ${label(p)}`,
			labels.some((l) => l.startsWith(own)) &&
				!labels.some((l) => l.startsWith(foreign)),
			labels.join(","),
		);
	}
	const completionMs = Math.round(performance.now() - t0);
	evidence.repeatCompletionItemCount = repeatItems;

	// Definition
	for (const [p, caller] of [
		[root, "RootCaller.cls"],
		[nested, "NestedCaller.cls"],
	] as const) {
		const file = find(p, caller);
		const defs =
			(await router.definition(file, pos(file, "AccountService.", 18))) ?? [];
		const ok =
			defs.length > 0 &&
			defs.every(
				(d) =>
					ownerOf(fsPath(d.uri), projects)?.root === p.root &&
					fsPath(d.uri).endsWith("AccountService.cls"),
			);
		check(
			`definition routed to ${label(p)}`,
			ok,
			defs.map((d) => rel(fsPath(d.uri))).join(","),
		);
	}

	// Diagnostics: real textDocument/diagnostic pull for every owned file of every project.
	type Row = {
		project: string;
		file: string;
		messages: string[];
		relatedOutside: string[];
	};
	const rows: Row[] = [];
	for (const p of projects) {
		for (const file of listOwnedFiles(p)) {
			const report = await router.diagnosticReport(file);
			const related = Object.keys(report.relatedDocuments ?? {});
			rows.push({
				project: label(p),
				file: rel(file),
				messages: (report.items ?? []).map((d) => d.message),
				relatedOutside: related.filter(
					(u) => ownerOf(fsPath(u), projects)?.root !== p.root,
				),
			});
			check(
				`diagnostic pull answered by owner for ${rel(file)}`,
				instanceOf(p) === router.instanceFor(file) && report.kind === "full",
				`kind=${report.kind}, items=${report.items?.length ?? 0}`,
			);
		}
	}
	evidence.diagnostics = rows;
	const msgs = (p: DxProject) =>
		rows.filter((r) => r.project === label(p)).flatMap((r) => r.messages);
	check(
		"root diagnostics include root error",
		msgs(root).some((m) => /RootOnlyBroken/.test(m)),
		msgs(root).join("; "),
	);
	check(
		"nested diagnostics include nested error",
		msgs(nested).some((m) => /NestedOnlyBroken/.test(m)),
		msgs(nested).join("; "),
	);
	check(
		"nested error never appears in root results",
		!msgs(root).some((m) => /NestedOnlyBroken/.test(m)),
	);
	check(
		"root error never appears in nested results",
		!msgs(nested).some((m) => /RootOnlyBroken/.test(m)),
	);
	check(
		"diagnostic sets differ between projects",
		JSON.stringify(msgs(root)) !== JSON.stringify(msgs(nested)),
	);
	check(
		"no relatedDocuments point outside the owner project",
		rows.every((r) => r.relatedOutside.length === 0),
	);
	for (const i of instances) {
		const foreign = [...i.openedUris].filter(
			(u) => ownerOf(fsPath(u), projects)?.root !== i.project.root,
		);
		check(
			`${label(i.project)} server was never sent foreign documents`,
			foreign.length === 0,
		);
	}
	// Bypass probe (informational): ask each server for a file it was never sent.
	const bypass: Record<string, string> = {};
	for (const [from, to] of [
		[root, nested],
		[nested, root],
	] as const) {
		const file = find(
			to,
			to === nested ? "NestedCaller.cls" : "RootCaller.cls",
		);
		bypass[`${label(from)} server -> ${rel(file)}`] = await instanceOf(from)
			.connection.sendRequest("textDocument/diagnostic", {
				textDocument: { uri: pathToFileURL(file).toString() },
			})
			.then(
				(r) => JSON.stringify(r).slice(0, 200),
				(e: Error) => `error: ${e.message}`,
			);
	}
	evidence.bypassProbe = bypass;

	const metricsFinal = instances.map((i) => summarizeTree(i.pid as number));
	evidence.memory = {
		method:
			"per-process VmRSS/PSS and Threads from /proc/<pid>/status+smaps_rollup; tree = pid + all descendants",
		afterInitialize: metricsAfterInit,
		afterReady: metricsAfterReady,
		final: metricsFinal,
		cgroupMemoryMb: cgroupMemoryMb(),
		completionTwoRequestsMs: completionMs,
	};

	const pids = instances.map((i) => i.pid as number);
	await Promise.all(instances.map((i) => i.stop()));
	const alive = pids.filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
	check(
		"both servers stopped cleanly",
		alive.length === 0,
		alive.length ? `still alive: ${alive}` : "exited",
	);
} catch (e) {
	console.error(e);
	exitCode = 1;
	await Promise.all(instances.map((i) => i.stop(1000)));
}
if (results.some((r) => !r.ok)) exitCode = 1;
mkdirSync(cacheDir, { recursive: true });
writeFileSync(
	path.join(cacheDir, `poc-results-${mode}.json`),
	JSON.stringify({ results, evidence }, null, 2),
);
console.log(
	"EVIDENCE",
	JSON.stringify(evidence.startup),
	JSON.stringify(evidence.readiness),
);
console.log(exitCode === 0 ? "RESULT: all checks passed" : "RESULT: failures");
process.exit(exitCode);
