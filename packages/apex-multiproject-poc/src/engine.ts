import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DxProject } from "./discovery.ts";
import {
	ApexServerInstance,
	apexInitOptions,
	jorjeSpec,
	type LaunchSpec,
	tsServerSpec,
} from "./server-host.ts";

export type EnginePosition = { line: number; character: number };
export type EngineRange = { start: EnginePosition; end: EnginePosition };
export type EngineCompletion = {
	label: string;
	kind?: number;
	detail?: string;
	insertText?: string;
};
export type EngineLocation = { uri: string; range: EngineRange };

/** The only surface the editor integration depends on; one engine instance serves one DX project. */
export interface ApexEngine {
	readonly kind: "typescript" | "jorje";
	readonly project: DxProject;
	readonly pid: number | undefined;
	readonly alive: boolean;
	readonly startupMs: number;
	/** Spawns the process and runs the engine's official handshake. */
	start(): Promise<void>;
	/** Resolves with ms until the engine reports the project index ready (false: timed out). */
	waitReady(): Promise<{ ms: number; ready: boolean }>;
	openDocument(uri: string, text: string, version?: number): void;
	changeDocument(uri: string, text: string): void;
	saveDocument(uri: string): void;
	closeDocument(uri: string): void;
	completion(uri: string, p: EnginePosition): Promise<EngineCompletion[]>;
	definition(uri: string, p: EnginePosition): Promise<EngineLocation[]>;
	/** Messages currently reported for the document. */
	diagnostics(uri: string): Promise<string[]>;
	/** Restart in place; replays this engine's open documents including unsaved text. */
	restart(): Promise<number>;
	stop(): Promise<void>;
	onExit(listener: () => void): void;
}

export type EngineConfig = {
	typescript?: { extensionDir: string };
	jorje?: { jar: string; java?: string };
};

const tsSettings = {
	apex: {
		environment: { runtimePlatform: "desktop", serverMode: "development" },
	},
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pulled = { items?: Array<{ message: string }> };

class HostEngine implements ApexEngine {
	readonly kind: "typescript" | "jorje";
	readonly project: DxProject;
	private readonly host: ApexServerInstance;
	private indexed = false;
	private indexWaiters: Array<() => void> = [];

	constructor(
		kind: "typescript" | "jorje",
		project: DxProject,
		spec: LaunchSpec,
		extensionDir?: string,
	) {
		this.kind = kind;
		this.project = project;
		this.host =
			kind === "typescript"
				? new ApexServerInstance(project, spec, {
						initializationOptions: apexInitOptions(extensionDir as string),
						workspaceLoad: "none",
					})
				: new ApexServerInstance(project, spec, {
						// Official Jorje client: initializationOptions only carry semantic-error and SOQL flags;
						// there is no client-driven workspace load, the server indexes from rootUri and says `indexer/done`.
						initializationOptions: {
							enableSemanticErrors: true,
							enableCompletionStatistics: false,
							enableEmbeddedSoqlCompletion: false,
						},
						capabilities: {
							workspace: {
								workspaceFolders: true,
								configuration: true,
								didChangeWatchedFiles: { dynamicRegistration: true },
							},
							textDocument: {
								synchronization: { didSave: true },
								completion: { completionItem: { snippetSupport: false } },
								definition: { linkSupport: false },
								publishDiagnostics: {},
							},
						},
						configure: (conn) => {
							conn.onNotification("indexer/done", () => {
								this.indexed = true;
								for (const w of this.indexWaiters.splice(0)) w();
							});
						},
					});
	}

	get pid() {
		return this.host.pid;
	}
	get alive() {
		return this.host.alive;
	}
	get startupMs() {
		return this.host.startupMs;
	}
	onExit(l: () => void) {
		this.host.onExit(l);
	}

	async start() {
		this.indexed = false;
		await this.host.start();
	}

	async waitReady() {
		const t0 = performance.now();
		if (this.kind === "typescript") {
			const r = await this.host.initializeWorkspace(tsSettings);
			return { ms: r.readyMs, ready: r.ingested };
		}
		if (!this.indexed)
			await Promise.race([
				new Promise<void>((r) => this.indexWaiters.push(r)),
				sleep(60_000),
			]);
		return { ms: Math.round(performance.now() - t0), ready: this.indexed };
	}

	openDocument(uri: string, text: string, version = 1) {
		this.host.openDocument(uri, text, version);
	}
	changeDocument(uri: string, text: string) {
		this.host.changeDocument(uri, text);
	}
	saveDocument(uri: string) {
		this.host.saveDocument(uri);
	}
	closeDocument(uri: string) {
		this.host.closeDocument(uri);
	}

	async completion(uri: string, textDocPos: EnginePosition) {
		const r = (await this.host.connection.sendRequest(
			"textDocument/completion",
			{
				textDocument: { uri },
				position: textDocPos,
			},
		)) as { items?: EngineCompletion[] } | EngineCompletion[] | null;
		return Array.isArray(r) ? r : (r?.items ?? []);
	}

	async definition(uri: string, textDocPos: EnginePosition) {
		const r = (await this.host.connection.sendRequest(
			"textDocument/definition",
			{
				textDocument: { uri },
				position: textDocPos,
			},
		)) as
			| Array<
					Partial<EngineLocation> & {
						targetUri?: string;
						targetRange?: EngineRange;
					}
			  >
			| (Partial<EngineLocation> & {
					targetUri?: string;
					targetRange?: EngineRange;
			  })
			| null;
		const list = r ? (Array.isArray(r) ? r : [r]) : [];
		return list.map((l) => ({
			uri: l.uri ?? l.targetUri ?? "",
			range: l.range ?? l.targetRange ?? { start: textDocPos, end: textDocPos },
		}));
	}

	async diagnostics(uri: string) {
		if (this.kind === "jorje")
			return (this.host.diagnostics.get(uri) ?? []).map((d) =>
				String(d.message),
			);
		// editor-style trigger (see ApexServerInstance.editorRefresh), then a plain pull
		await this.host.editorRefresh(uri);
		const r = (await this.host.connection
			.sendRequest("textDocument/diagnostic", { textDocument: { uri } })
			.catch(() => null)) as Pulled | null;
		return r?.items?.map((i) => i.message) ?? [];
	}

	async restart() {
		const ms = await this.host.restart(
			this.kind === "typescript" ? tsSettings : undefined,
		);
		if (this.kind === "jorje") await this.waitReady();
		return ms;
	}

	async stop() {
		await this.host.stop(2000);
	}
}

export function createEngine(
	kind: "typescript" | "jorje",
	project: DxProject,
	cfg: EngineConfig,
): ApexEngine {
	if (kind === "typescript") {
		const dir = cfg.typescript?.extensionDir;
		if (!dir) throw new Error("typescript engine needs extensionDir");
		return new HostEngine(
			kind,
			project,
			tsServerSpec(`${dir}/dist/server.node.js`),
			dir,
		);
	}
	const jar = cfg.jorje?.jar;
	if (!jar)
		throw new Error(
			"jorje engine needs a locally installed apex-jorje-lsp.jar path",
		);
	// index database lives in a per-project temp dir so Jorje never writes into the project (.sfdx/)
	const dbPath = mkdtempSync(path.join(tmpdir(), "jorje-db-"));
	return new HostEngine(
		kind,
		project,
		jorjeSpec(jar, cfg.jorje?.java, { dbPath, projectRoot: project.root }),
		undefined,
	);
}

export const readText = (file: string) => readFileSync(file, "utf8");
