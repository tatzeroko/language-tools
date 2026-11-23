// A/B matrix: which client protocol step (if any) changes repeated-completion behaviour?
// Axes: client capabilities (minimal vs official), workspace load (none vs protocol), open style (single vs bulk).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverProjects } from "../src/discovery.ts";
import {
	ApexServerInstance,
	apexInitOptions,
	tsServerSpec,
} from "../src/server-host.ts";
import { fetchServer } from "./fetch-server.ts";

const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const root = discoverProjects(ws)[0];
const extDir = process.env.APEX_LS_DIST
	? path.dirname(process.env.APEX_LS_DIST)
	: fetchServer();
const spec = tsServerSpec(path.join(extDir, "dist", "server.node.js"));
const file = path.join(ws, "force-app/main/default/classes/RootCaller.cls");
const uri = pathToFileURL(file).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { startup: string; open: string; counts: number[]; init?: object };
const rows: Row[] = [];
const settings = {
	apex: {
		environment: { runtimePlatform: "desktop", serverMode: "development" },
	},
};

for (const startup of ["bare", "official"] as const) {
	for (const open of ["single", "bulk"] as const) {
		const inst = new ApexServerInstance(root, spec, {
			initializationOptions: apexInitOptions(extDir),
			minimalCapabilities: startup === "bare",
			workspaceLoad: "none",
		});
		await inst.start();
		const init =
			startup === "official"
				? await inst.initializeWorkspace(settings)
				: undefined;
		if (open === "bulk") inst.openOwnedFiles();
		else inst.openFile(file);
		if (!inst.docs.has(uri)) inst.openFile(file);
		await sleep(1500);
		const lines = (inst.docs.get(uri)?.text ?? "").split("\n");
		const li = lines.findIndex((l) => l.includes("AccountService."));
		const position = {
			line: li,
			character: li >= 0 ? lines[li].indexOf("AccountService.") + 15 : 0,
		};
		const counts: number[] = [];
		for (let i = 0; i < 4; i++) {
			const r = (await inst.connection.sendRequest("textDocument/completion", {
				textDocument: { uri },
				position,
			})) as { items?: unknown[] } | null;
			counts.push(r?.items?.length ?? -1);
			await sleep(300);
		}
		rows.push({ startup, open, counts, init });
		console.log(JSON.stringify(rows[rows.length - 1]));
		await inst.stop();
	}
}
mkdirSync(path.join(import.meta.dirname, "..", ".cache"), { recursive: true });
writeFileSync(
	path.join(import.meta.dirname, "..", ".cache", "protocol-matrix.json"),
	JSON.stringify(rows, null, 2),
);
