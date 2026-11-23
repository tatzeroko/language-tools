// Router-free repro of "repeated completion returns empty". One server, one project, raw LSP.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects } from "../src/discovery.ts";
import {
	ApexServerInstance,
	apexInitOptions,
	developmentModeOptions,
	type ServerOptions,
	tsServerSpec,
} from "../src/server-host.ts";
import { fetchServer } from "./fetch-server.ts";

const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const root = discoverProjects(ws)[0];
const extDir = process.env.APEX_LS_DIST
	? path.dirname(process.env.APEX_LS_DIST)
	: fetchServer();
const options: ServerOptions =
	process.env.APEX_POC_MODE === "custom"
		? {
				initializationOptions: {
					apex: {
						custom: {
							completionProvider: {
								resolveProvider: false,
								triggerCharacters: ["."],
							},
							definitionProvider: true,
						},
					},
				},
			}
		: {
				initializationOptions: process.env.REPRO_NO_STDLIB
					? developmentModeOptions
					: apexInitOptions(extDir),
			};
if (process.env.APEX_POC_LOG) {
	const apex = (
		options.initializationOptions as { apex: Record<string, unknown> }
	).apex;
	apex.logLevel = process.env.APEX_POC_LOG;
}
const inst = new ApexServerInstance(
	root,
	tsServerSpec(
		process.env.APEX_LS_DIST
			? path.join(process.env.APEX_LS_DIST, "server.node.js")
			: path.join(fetchServer(), "dist", "server.node.js"),
	),
	options,
);
const file = path.join(
	ws,
	"force-app/main/default/classes",
	process.env.REPRO_FILE ?? "AccountService.cls",
);
const uri = pathToFileURL(file).toString();
const text0 = readFileSync(file, "utf8");
const trace: unknown[] = [];
const t00 = performance.now();
const log = (e: object) =>
	trace.push({ t: Math.round(performance.now() - t00), ...e });
let version = 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const complete = async (
	label: string,
	position: { line: number; character: number },
	context?: object,
) => {
	const t = performance.now();
	const params = {
		textDocument: { uri },
		position,
		...(context ? { context } : {}),
	};
	const res = (await inst.connection.sendRequest(
		"textDocument/completion",
		params,
	)) as { items?: { label: string }[]; isIncomplete?: boolean } | null;
	const row = {
		label,
		position,
		context,
		ms: Math.round(performance.now() - t),
		n: res?.items?.length ?? null,
		isIncomplete: res?.isIncomplete,
		first: res?.items?.slice(0, 3).map((i) => i.label),
	};
	log({ req: "completion", ...row });
	console.log(
		`${label.padEnd(44)} n=${String(row.n).padEnd(3)} incomplete=${row.isIncomplete} ${row.ms}ms ${row.first ?? ""}`,
	);
	return row;
};
const change = (text: string) => {
	version++;
	log({ note: "didChange(full)", version, len: text.length });
	inst.connection.sendNotification("textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text }],
	});
};
const lines = text0.split("\n");
const dot = lines.findIndex((l) => l.includes("AccountService."));
const at = { line: dot, character: lines[dot].indexOf("AccountService.") + 15 };

const scenario = process.argv[2] ?? "all";
await inst.start();
const openVersion = Number(process.env.REPRO_OPEN_VERSION ?? 1);
version = openVersion;
if (process.env.REPRO_ONLY_TARGET) inst.openFile(file, openVersion);
else
	for (const f of (await import("../src/discovery.ts")).listOwnedFiles(root))
		inst.openFile(f, openVersion);
log({ note: "didOpen all owned" });
await sleep(4000);

const run = async (name: string, fn: () => Promise<void>) => {
	if (scenario !== "all" && scenario !== name) return;
	console.log(`\n== ${name}`);
	log({ scenario: name });
	await fn();
};

await run("A-same-position", async () => {
	for (let i = 0; i < 4; i++) await complete(`same position #${i + 1}`, at);
	await sleep(3000);
	await complete("same position after 3s idle", at);
});
await run("B-other-positions", async () => {
	await complete("same position (control)", at);
	await complete("position shifted +0 line 0 col 0", { line: 0, character: 0 });
	await complete("inside method body (line+1)", {
		line: dot - 1,
		character: 8,
	});
	await complete("back to dot position", at);
});
await run("C-trigger-context", async () => {
	await complete("triggerKind=Invoked", at, { triggerKind: 1 });
	await complete("triggerKind=TriggerCharacter '.'", at, {
		triggerKind: 2,
		triggerCharacter: ".",
	});
	await complete("triggerKind=Invoked again", at, { triggerKind: 1 });
	await complete("TriggerForIncomplete", at, { triggerKind: 3 });
});
await run("D-didChange", async () => {
	await complete("before edit", at);
	change(`${text0}\n// edit 1\n`);
	await complete("after didChange (no dot edit)", at);
	const edited = text0.replace(
		"AccountService.\n",
		"AccountService.\n        ",
	);
	change(edited);
	await complete("after whitespace edit", {
		line: dot,
		character: at.character,
	});
	change(text0);
	await complete("after reverting to original text", at);
});
await run("E-didSave", async () => {
	await complete("before save", at);
	inst.connection.sendNotification("textDocument/didSave", {
		textDocument: { uri },
		text: text0,
	});
	await sleep(500);
	await complete("after didSave", at);
});
await run("F-close-reopen", async () => {
	await complete("before close", at);
	inst.connection.sendNotification("textDocument/didClose", {
		textDocument: { uri },
	});
	await sleep(500);
	version = 1;
	inst.connection.sendNotification("textDocument/didOpen", {
		textDocument: { uri, languageId: "apex", version, text: text0 },
	});
	await sleep(1500);
	await complete("after close+reopen", at);
	await complete("again", at);
});
await run("H-two-after-change", async () => {
	change(`${text0}\n// h\n`);
	await complete("1st after change", at);
	await complete("2nd after same change", at);
	await complete("3rd after same change", at);
	change(text0);
	await complete("1st after next change", at);
	await complete("2nd after next change", at);
});
const req = async (
	method: string,
	label: string,
	position: { line: number; character: number },
) => {
	const res = (await inst.connection.sendRequest(method, {
		textDocument: { uri },
		position,
	})) as unknown;
	const n = Array.isArray(res) ? res.length : res ? 1 : 0;
	log({ req: method, label, position, n });
	console.log(`${label.padEnd(44)} ${method.split("/")[1]} results=${n}`);
	return n;
};
await run("I-definition-hover-repeat", async () => {
	const l = lines.findIndex(
		(x) => x.includes("rootOnlyMethod()") && x.includes("AccountService."),
	);
	const p = { line: l, character: lines[l].indexOf("rootOnlyMethod") + 2 };
	for (let i = 1; i <= 3; i++)
		await req("textDocument/definition", `definition #${i}`, p);
	for (let i = 1; i <= 3; i++)
		await req("textDocument/hover", `hover #${i}`, p);
});
await run("J-identical-text-version-bump", async () => {
	await complete("1st", at);
	await complete("2nd (expected empty)", at);
	change(text0);
	await complete("after didChange identical text, version+1", at);
	await complete("2nd after identical-text bump", at);
});
await run("K-enrich-first", async () => {
	await req("textDocument/hover", "hover@(0,0) first", {
		line: 0,
		character: 0,
	});
	for (let i = 1; i <= 3; i++)
		await complete(`completion #${i} after hover`, at);
	change(`${text0}\n// k\n`);
	await complete("completion #1 after edit (no hover)", at);
	await complete("completion #2 after edit (no hover)", at);
	await req("textDocument/hover", "hover@(0,0) after edit", {
		line: 0,
		character: 0,
	});
	await complete("completion #3 after hover post-edit", at);
});
await run("G-typing", async () => {
	// Simulate typing 'r','o' after the dot: each keystroke is a didChange + completion at the new column.
	let prefix = "";
	for (const ch of ["", "r", "ro", "roo"]) {
		prefix = ch;
		const l = [...lines];
		l[dot] = `${lines[dot].slice(0, at.character)}${prefix}`;
		change(l.join("\n"));
		await complete(`typed prefix '${prefix}'`, {
			line: dot,
			character: at.character + prefix.length,
		});
	}
});

console.log(
	"\nserver stderr (tail):\n" +
		inst.log.join("").split("\n").slice(-25).join("\n"),
);
mkdirSync(path.resolve(import.meta.dirname, "..", ".cache"), {
	recursive: true,
});
writeFileSync(
	path.resolve(
		import.meta.dirname,
		"..",
		".cache",
		`repro-${scenario}-${process.env.APEX_POC_MODE ?? "development"}.json`,
	),
	JSON.stringify({ trace, serverLog: inst.log.join("") }, null, 1),
);
await inst.stop();
process.exit(0);
