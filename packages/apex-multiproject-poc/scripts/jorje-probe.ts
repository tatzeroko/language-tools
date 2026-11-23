// Phase 5: small isolated Jorje (legacy Java Apex LS) probe. Needs JORJE_JAR=/path/to/apex-jorje-lsp.jar and `java`.
// The JAR is read in place from a public checkout; it is never copied into this repository.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createProtocolConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import { discoverProjects, listOwnedFiles } from "../src/discovery.ts";

const jar = process.env.JORJE_JAR;
if (!jar) {
	console.log("SKIP set JORJE_JAR to a locally installed apex-jorje-lsp.jar");
	process.exit(0);
}
const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const projects = discoverProjects(ws);
const root = projects.find((p) => p.nestedRoots.length > 0) ?? projects[0];
const nested = projects.find((p) => p !== root);
if (!nested) throw new Error("fixture needs a nested project");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(project: typeof root, caller: string) {
	const t0 = performance.now();
	const proc = spawn(
		"java",
		[
			"-cp",
			jar as string,
			"-Xmx512M",
			"-Ddebug.semantic.errors=true",
			"-Dlwc.typegeneration.disabled=true",
			`-Dapex.jorje.db.path=${mkdtempSync(path.join(tmpdir(), "jorje-"))}`,
			"apex.jorje.lsp.ApexLanguageServerLauncher",
		],
		{ cwd: project.root, stdio: ["pipe", "pipe", "ignore"] },
	);
	const conn = createProtocolConnection(
		new StreamMessageReader(proc.stdout),
		new StreamMessageWriter(proc.stdin),
	);
	const pushed = new Map<string, string[]>();
	conn.onNotification("textDocument/publishDiagnostics", (raw: unknown) => {
		const p = raw as { uri: string; diagnostics: { message: string }[] };
		pushed.set(
			p.uri,
			p.diagnostics.map((d) => d.message),
		);
	});
	conn.onRequest("workspace/configuration", () => []);
	conn.onRequest("client/registerCapability", () => null);
	conn.onNotification("window/logMessage", () => {});
	conn.listen();
	const rootUri = pathToFileURL(project.root).toString();
	const init = (await conn.sendRequest("initialize", {
		processId: process.pid,
		rootUri,
		workspaceFolders: [{ uri: rootUri, name: path.basename(project.root) }],
		capabilities: {
			textDocument: {
				completion: { completionItem: { snippetSupport: false } },
				publishDiagnostics: {},
			},
			workspace: { workspaceFolders: true },
		},
		initializationOptions: {
			enableSemanticErrors: true,
			enableCompletionStatistics: false,
		},
	})) as { capabilities: Record<string, unknown> };
	const initMs = Math.round(performance.now() - t0);
	conn.sendNotification("initialized", {});
	const uri = pathToFileURL(caller).toString();
	const text = readFileSync(caller, "utf8");
	const rssMB = Math.round(
		Number(
			/VmRSS:\s+(\d+)/.exec(
				readFileSync(`/proc/${proc.pid}/status`, "utf8"),
			)?.[1],
		) / 1024,
	);
	for (const f of listOwnedFiles(project))
		conn.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri: pathToFileURL(f).toString(),
				languageId: "apex",
				version: 1,
				text: readFileSync(f, "utf8"),
			},
		});
	const lines = text.split("\n");
	const li = lines.findIndex((l) => l.includes("AccountService."));
	const position = {
		line: li,
		character: lines[li].indexOf("AccountService.") + 15,
	};
	const counts: number[] = [];
	const lat: number[] = [];
	for (let i = 0; i < 4; i++) {
		const t = performance.now();
		const r = (await conn
			.sendRequest("textDocument/completion", {
				textDocument: { uri },
				position,
			})
			.catch(() => null)) as
			| { items?: { label: string }[] }
			| { label: string }[]
			| null;
		lat.push(Math.round(performance.now() - t));
		counts.push(Array.isArray(r) ? r.length : (r?.items?.length ?? -1));
		await sleep(200);
	}
	const def = (await conn
		.sendRequest("textDocument/definition", {
			textDocument: { uri },
			position: { line: li, character: position.character - 3 },
		})
		.catch(() => null)) as unknown[] | null;
	await sleep(4000);
	const diags = pushed.get(uri) ?? [];
	await conn.sendRequest("shutdown").catch(() => {});
	conn.sendNotification("exit");
	await sleep(500);
	if (proc.exitCode === null) proc.kill("SIGKILL");
	return {
		project: path.basename(project.root),
		pid: proc.pid,
		initMs,
		rssMB,
		providers: Object.keys(init.capabilities).filter(
			(k) => init.capabilities[k],
		),
		counts,
		completionLatencyMs: lat,
		definition: Array.isArray(def) ? def.length : def,
		diagnostics: diags,
	};
}
const [a, b] = await Promise.all([
	run(
		root,
		listOwnedFiles(root).find((f) => f.endsWith("RootCaller.cls")) as string,
	),
	run(
		nested,
		listOwnedFiles(nested).find((f) =>
			f.endsWith("NestedCaller.cls"),
		) as string,
	),
]);
console.log(JSON.stringify([a, b], null, 1));
const leak =
	a.diagnostics.some((m) => /NestedOnly/.test(m)) ||
	b.diagnostics.some((m) => /RootOnly/.test(m));
console.log(
	leak
		? "FAIL diagnostics leaked across projects"
		: "PASS no cross-project diagnostics leak",
);
