// Strict regression for the upstream repeated-completion defect. Exits non-zero on the pinned server
// (expected: known upstream blocker) and 0 on a patched disposable copy (APEX_LS_DIST=...).
// Official startup sequence, one genuine document, NO artificial edits, no result caching.
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
const inst = new ApexServerInstance(
	root,
	tsServerSpec(path.join(extDir, "dist", "server.node.js")),
	{
		initializationOptions: apexInitOptions(extDir),
		workspaceLoad: "none",
	},
);
const file = path.join(ws, "force-app/main/default/classes/RootCaller.cls");
const uri = pathToFileURL(file).toString();
const counts: number[] = [];
try {
	await inst.start();
	await inst.initializeWorkspace({
		apex: {
			environment: { runtimePlatform: "desktop", serverMode: "development" },
		},
	});
	inst.openFile(file);
	const lines = (inst.docs.get(uri)?.text ?? "").split("\n");
	const li = lines.findIndex((l) => l.includes("AccountService."));
	const position = {
		line: li,
		character: lines[li].indexOf("AccountService.") + 15,
	};
	for (let i = 0; i < 5; i++) {
		const r = (await inst.connection.sendRequest("textDocument/completion", {
			textDocument: { uri },
			position,
		})) as { items?: unknown[] } | null;
		counts.push(r?.items?.length ?? -1);
	}
} finally {
	await inst.stop(2000);
}
const ok =
	counts.length === 5 && counts[0] > 0 && counts.every((c) => c === counts[0]);
console.log(
	`${ok ? "PASS" : "FAIL"} repeated completion at one position, unchanged document: counts=${JSON.stringify(counts)}`,
);
process.exit(ok ? 0 : 1);
