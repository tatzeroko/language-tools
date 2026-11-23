// Empirically records which server capabilities each mode-selection mechanism yields.
import path from "node:path";
import { discoverProjects } from "../src/discovery.ts";
import {
	ApexServerInstance,
	developmentModeOptions,
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
const project = discoverProjects(fixture).at(-1);
if (!project) throw new Error("fixture missing");
const spec = tsServerSpec(path.join(fetchServer(), "dist", "server.node.js"));

const customCaps = {
	completionProvider: { resolveProvider: false, triggerCharacters: ["."] },
	definitionProvider: true,
	diagnosticProvider: {
		identifier: "apex-ls-ts",
		interFileDependencies: true,
		workspaceDiagnostics: false,
	},
};

const variants: Record<string, ServerOptions> = {
	"none (default)": {},
	"env APEX_LS_MODE=development": { env: { APEX_LS_MODE: "development" } },
	"initOptions apex.environment.serverMode=development": {
		initializationOptions: developmentModeOptions,
	},
	"env=production + initOptions=development": {
		env: { APEX_LS_MODE: "production" },
		initializationOptions: developmentModeOptions,
	},
	"env=development + initOptions=production": {
		env: { APEX_LS_MODE: "development" },
		initializationOptions: {
			apex: { environment: { serverMode: "production" } },
		},
	},
	"production + apex.custom enabling 3 capabilities": {
		initializationOptions: { apex: { custom: customCaps } },
	},
	"initOptions top-level environment.serverMode=development": {
		initializationOptions: { environment: { serverMode: "development" } },
	},
};

const rows: Array<Record<string, unknown>> = [];
for (const [name, options] of Object.entries(variants)) {
	const s = new ApexServerInstance(project, spec, options);
	await s.start();
	const c = s.capabilities ?? {};
	rows.push({
		variant: name,
		completion: Boolean(c.completionProvider),
		definition: Boolean(c.definitionProvider),
		diagnostic: Boolean(c.diagnosticProvider),
		hover: Boolean(c.hoverProvider),
		references: Boolean(c.referencesProvider),
		documentSymbol: Boolean(c.documentSymbolProvider),
		semanticTokens: Boolean(c.semanticTokensProvider),
	});
	await s.stop();
}
console.table(rows);
