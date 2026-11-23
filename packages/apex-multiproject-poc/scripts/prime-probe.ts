// Which ordinary LSP request (if any) lets textDocument/diagnostic report body-level errors? One fresh server per probe.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects, listOwnedFiles } from "../src/discovery.ts";
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
const root = discoverProjects(ws).find(
	(p) => p.nestedRoots.length > 0,
) as ReturnType<typeof discoverProjects>[number];
const f = listOwnedFiles(root).find((x) =>
	x.endsWith("RootCaller.cls"),
) as string;
const uri = pathToFileURL(f).toString();
const text = readFileSync(f, "utf8");
const settings = {
	apex: {
		environment: { runtimePlatform: "desktop", serverMode: "development" },
	},
};
const td = { uri };
const pos = { line: 6, character: 10 };
const primes: Record<string, [string, object] | undefined> = {
	none: undefined,
	hover: ["textDocument/hover", { textDocument: td, position: pos }],
	definition: ["textDocument/definition", { textDocument: td, position: pos }],
	completion: ["textDocument/completion", { textDocument: td, position: pos }],
	documentSymbol: ["textDocument/documentSymbol", { textDocument: td }],
	semanticTokens: ["textDocument/semanticTokens/full", { textDocument: td }],
	foldingRange: ["textDocument/foldingRange", { textDocument: td }],
	codeLens: ["textDocument/codeLens", { textDocument: td }],
	references: [
		"textDocument/references",
		{ textDocument: td, position: pos, context: { includeDeclaration: true } },
	],
};
const only = process.argv[2];
const out: Record<string, unknown> = {};
for (const [name, req] of Object.entries(primes)) {
	if (only && only !== name) continue;
	const inst = new ApexServerInstance(root, spec, {
		initializationOptions: apexInitOptions(extDir),
		workspaceLoad: "none",
	});
	await inst.start();
	await inst.initializeWorkspace(settings);
	if (name === "none")
		out.capabilities = Object.keys(inst.capabilities ?? {}).filter((k) =>
			k.endsWith("Provider"),
		);
	inst.openDocument(uri, text);
	let primeResult = "n/a";
	if (req)
		primeResult = await inst.connection.sendRequest(req[0], req[1]).then(
			(r) => `ok(${JSON.stringify(r)?.length ?? 0}B)`,
			(e: Error) => `error: ${e.message.slice(0, 60)}`,
		);
	const t = performance.now();
	let items = 0;
	for (let i = 0; i < 20; i++) {
		items =
			(
				(await inst.connection.sendRequest("textDocument/diagnostic", {
					textDocument: td,
				})) as { items?: unknown[] }
			).items?.length ?? 0;
		if (items) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	out[name] = {
		primeResult,
		diagnosticsItems: items,
		polledMs: Math.round(performance.now() - t),
	};
	console.log(name.padEnd(15), JSON.stringify(out[name]));
	await inst.stop(2000);
}
console.log(JSON.stringify(out.capabilities));
