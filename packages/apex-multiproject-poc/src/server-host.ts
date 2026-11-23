import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ConfigurationParams,
	createProtocolConnection,
	type Diagnostic,
	type InitializeParams,
	InitializeRequest,
	type ProtocolConnection,
	type PublishDiagnosticsParams,
	type ServerCapabilities,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import { apexClientCapabilities } from "./client-capabilities.ts";
import type { DxProject } from "./discovery.ts";
import { loadWorkspace, readOwnedWorkspaceFiles } from "./workspace-load.ts";

export type LaunchSpec = { command: string; args: string[] };

/** Spawn spec for the Salesforce TypeScript Apex language server (stdio). */
export function tsServerSpec(serverModule: string): LaunchSpec {
	// Inside VS Code process.execPath may be the Electron binary; ELECTRON_RUN_AS_NODE (set at spawn) makes it behave as node.
	return { command: process.execPath, args: [serverModule, "--stdio"] };
}

/** Spawn spec for legacy Jorje; `jar` points at an installed apex-jorje-lsp.jar. */
export function jorjeSpec(
	jar: string,
	java = "java",
	opts: { dbPath?: string; projectRoot?: string; maxHeapMB?: number } = {},
): LaunchSpec {
	// Flags mirror the official Salesforce client plus the two the standalone launcher needs:
	// without apex.jorje.db.path the index provider throws an NPE and `indexer/done` never fires.
	return {
		command: java,
		args: [
			"-cp",
			jar,
			`-Xmx${opts.maxHeapMB ?? 512}M`,
			"-Ddebug.internal.errors=true",
			"-Ddebug.semantic.errors=true",
			"-Ddebug.completion.statistics=false",
			"-Dlwc.typegeneration.disabled=true",
			...(opts.dbPath ? [`-Dapex.jorje.db.path=${opts.dbPath}`] : []),
			...(opts.projectRoot ? [`-Dsfdx.project.root=${opts.projectRoot}`] : []),
			"apex.jorje.lsp.ApexLanguageServerLauncher",
		],
	};
}

/** The capabilities the first PoC sent; kept only so the difference can be measured. */
const legacyMinimalCapabilities = {
	workspace: { workspaceFolders: true, configuration: true },
	textDocument: {
		synchronization: { didSave: true },
		completion: { completionItem: { snippetSupport: false } },
		definition: { linkSupport: false },
		publishDiagnostics: {},
	},
};

export type ServerOptions = {
	/** Send the first PoC's minimal client capabilities instead of the official set (for A/B runs). */
	minimalCapabilities?: boolean;
	/**
	 * "protocol" answers the server's `apex/requestWorkspaceLoad` with batched ingestion of the
	 * files this project owns (official behaviour). "none" ignores it (the first PoC's behaviour).
	 */
	workspaceLoad?: "protocol" | "none";
	/** Extra environment variables for the server process. */
	env?: NodeJS.ProcessEnv;
	/** Replaces the client capabilities sent in `initialize` (engine-specific; Jorje wants a small set). */
	capabilities?: InitializeParams["capabilities"];
	/** Lets an engine register extra notification/request handlers before the connection listens. */
	configure?: (conn: ProtocolConnection) => void;
	/** Merged into initializationOptions (after workspaceRoot). */
	initializationOptions?: Record<string, unknown>;
};

/**
 * Initialization options that select the TS Apex server's "development" mode,
 * the same value as the documented `apex.environment.serverMode` setting.
 */
export const developmentModeOptions = {
	apex: { environment: { serverMode: "development" } },
};

/**
 * The initialization options the official VS Code client sends (`createEnhancedInitializationOptions`
 * in apex-lsp-vscode-extension): mode, runtime platform and the bundled StandardApexLibrary.zip.
 * Without `resources.standardApexLibraryPath` the server cannot resolve System/Schema types.
 */
export function apexInitOptions(
	extensionDir: string,
	serverMode: "development" | "production" = "development",
) {
	return {
		apex: {
			environment: { runtimePlatform: "desktop", serverMode },
			resources: {
				standardApexLibraryPath: pathToFileURL(
					path.join(extensionDir, "resources", "StandardApexLibrary.zip"),
				).toString(),
			},
		},
	};
}

/** One language-server process bound to exactly one DX project. */
export class ApexServerInstance {
	readonly diagnostics = new Map<string, Diagnostic[]>();
	readonly openedUris = new Set<string>();
	readonly log: string[] = [];
	private proc?: ChildProcess;
	private conn?: ProtocolConnection;
	startupMs = 0;
	/** Set when the process exits; `requested` is true only for a stop() we initiated. */
	exitInfo?: {
		code: number | null;
		signal: NodeJS.Signals | null;
		requested: boolean;
	};
	private stopping = false;
	/** Client-side truth about open documents, replayed after a restart. */
	readonly docs = new Map<string, { version: number; text: string }>();
	readonly load = {
		requested: 0,
		completed: 0,
		failed: 0,
		files: 0,
		ingestionComplete: false,
		lastError: undefined as string | undefined,
	};
	private ingestionWaiters: Array<() => void> = [];
	readonly restarts: number[] = [];
	private readonly exitListeners: Array<() => void> = [];
	capabilities: ServerCapabilities | undefined;

	readonly project: DxProject;
	private readonly spec: LaunchSpec;
	private readonly options: ServerOptions;

	constructor(
		project: DxProject,
		spec: LaunchSpec,
		options: ServerOptions = { initializationOptions: developmentModeOptions },
	) {
		this.project = project;
		this.spec = spec;
		this.options = options;
	}

	get pid() {
		return this.proc?.pid;
	}

	get alive() {
		return this.proc !== undefined && this.exitInfo === undefined;
	}

	/** True when the process died without a stop() request. */
	get crashed() {
		return this.exitInfo !== undefined && !this.exitInfo.requested;
	}

	onExit(listener: () => void) {
		this.exitListeners.push(listener);
	}

	get connection() {
		if (!this.conn) throw new Error("server not started");
		return this.conn;
	}

	async start() {
		const t0 = performance.now();
		this.exitInfo = undefined;
		this.stopping = false;
		this.diagnostics.clear();
		this.openedUris.clear();
		this.load.requested = this.load.completed = this.load.failed = 0;
		this.load.files = 0;
		this.load.ingestionComplete = false;
		this.load.lastError = undefined;
		const proc = spawn(this.spec.command, this.spec.args, {
			cwd: this.project.root,
			env: {
				...process.env,
				...(this.spec.command === process.execPath
					? { ELECTRON_RUN_AS_NODE: "1" }
					: {}),
				...this.options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		proc.once("exit", (code, signal) => {
			this.exitInfo = { code, signal, requested: this.stopping };
			// Rejects any in-flight requests; otherwise they hang forever after a crash.
			this.conn?.dispose();
			for (const l of this.exitListeners) l();
		});
		proc.stderr?.on("data", (d: Buffer) => this.log.push(d.toString()));
		const conn = createProtocolConnection(
			new StreamMessageReader(proc.stdout as NodeJS.ReadableStream),
			new StreamMessageWriter(proc.stdin as NodeJS.WritableStream),
		);
		this.conn = conn;

		conn.onNotification(
			"textDocument/publishDiagnostics",
			(p: PublishDiagnosticsParams) => {
				this.diagnostics.set(p.uri, p.diagnostics);
			},
		);
		conn.onNotification(
			"window/logMessage",
			(p: { type: number; message: string }) => {
				this.log.push(`[lsp-log ${p.type}] ${p.message}\n`);
			},
		);
		// The server may call back into the client; answer permissively.
		conn.onRequest("workspace/configuration", (p: ConfigurationParams) =>
			p.items.map(() => null),
		);
		conn.onRequest("workspace/workspaceFolders", () => [this.folder]);
		conn.onRequest("client/registerCapability", () => null);
		conn.onRequest("apex/findMissingArtifact", () => ({ notFound: true }));
		conn.onNotification("$/progress", () => {});
		conn.onNotification("apex/queueStateChanged", () => {});
		conn.onNotification("apex/workspaceIngestionComplete", () => {
			this.load.ingestionComplete = true;
			for (const w of this.ingestionWaiters.splice(0)) w();
		});
		conn.onNotification("apex/requestWorkspaceLoad", () => {
			this.load.requested++;
			if ((this.options.workspaceLoad ?? "protocol") === "none") return;
			void loadWorkspace(conn, readOwnedWorkspaceFiles(this.project))
				.then((r) => {
					this.load.completed++;
					this.load.files = r.files;
				})
				.catch((e) => {
					this.load.failed++;
					this.load.lastError = String(e);
				});
		});
		conn.onRequest("window/workDoneProgress/create", () => null);
		this.options.configure?.(conn);
		conn.listen();

		const rootUri = pathToFileURL(this.project.root).toString();
		const params: InitializeParams = {
			processId: process.pid,
			// vscode-languageclient also sends the deprecated rootPath; Jorje builds its index path from it
			rootPath: this.project.root,
			rootUri,
			workspaceFolders: [this.folder],
			capabilities:
				this.options.capabilities ??
				(this.options.minimalCapabilities
					? legacyMinimalCapabilities
					: apexClientCapabilities),
			initializationOptions: {
				workspaceRoot: this.project.root,
				...this.options.initializationOptions,
			},
		};
		this.capabilities = (
			await conn.sendRequest(InitializeRequest.type, params)
		).capabilities;
		conn.sendNotification("initialized", {});
		this.startupMs = performance.now() - t0;
	}

	private get folder() {
		return {
			uri: pathToFileURL(this.project.root).toString(),
			name: this.project.root.split("/").pop() ?? "project",
		};
	}

	/**
	 * The official client's post-`initialized` sequence: push settings via
	 * `workspace/didChangeConfiguration`, run a client-initiated workspace load, then wait for the
	 * server's `apex/workspaceIngestionComplete`. Resolves with timings; `ingested` is false on timeout.
	 */
	async initializeWorkspace(
		settings: Record<string, unknown>,
		ingestionTimeoutMs = 60_000,
	) {
		const t0 = performance.now();
		this.connection.sendNotification("workspace/didChangeConfiguration", {
			settings,
		});
		const r = await loadWorkspace(
			this.connection,
			readOwnedWorkspaceFiles(this.project),
		);
		this.load.requested++;
		this.load.completed++;
		this.load.files = r.files;
		const tSent = performance.now() - t0;
		const ingested = await this.waitForIngestion(ingestionTimeoutMs);
		return {
			files: r.files,
			batches: r.batches,
			sentMs: Math.round(tSent),
			readyMs: Math.round(performance.now() - t0),
			ingested,
		};
	}

	/** Opens every file this project owns (bulk didOpen; the alternative to the ingestion protocol). */
	openOwnedFiles() {
		for (const f of readOwnedWorkspaceFiles(this.project))
			this.openDocument(f.uri, f.content);
	}

	openFile(file: string, version = 1) {
		return this.openDocument(
			pathToFileURL(file).toString(),
			readFileSync(file, "utf8"),
			version,
		);
	}

	openDocument(uri: string, text: string, version = 1) {
		this.docs.set(uri, { version, text });
		this.sendOpen(uri);
		return uri;
	}

	private sendOpen(uri: string) {
		const d = this.docs.get(uri);
		if (!d) return;
		this.openedUris.add(uri);
		this.connection.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: "apex",
				version: d.version,
				text: d.text,
			},
		});
	}

	/** Full-document sync; the version is always strictly increasing. */
	changeDocument(uri: string, text: string) {
		const d = this.docs.get(uri);
		if (!d) throw new Error(`document not open: ${uri}`);
		d.version++;
		d.text = text;
		this.connection.sendNotification("textDocument/didChange", {
			textDocument: { uri, version: d.version },
			contentChanges: [{ text }],
		});
		return d.version;
	}

	/**
	 * What VS Code does by itself after every open/change: ask for CodeLens (the Apex client
	 * registers a CodeLens provider). Against this server a textDocument/codeLens request makes the
	 * document's body-level diagnostics available; documentSymbol, semanticTokens, folding and
	 * completion do not (scripts/prime-probe.ts). It is not a diagnostics trigger of our own.
	 */
	async editorRefresh(uri: string, afterMs = 0) {
		// the server debounces didChange by 300 ms; a request sent sooner sees the previous text
		await new Promise((r) => setTimeout(r, afterMs));
		return this.connection
			.sendRequest("textDocument/codeLens", { textDocument: { uri } })
			.catch(() => undefined);
	}

	saveDocument(uri: string) {
		const d = this.docs.get(uri);
		if (!d) return;
		this.connection.sendNotification("textDocument/didSave", {
			textDocument: { uri },
			text: d.text,
		});
	}

	closeDocument(uri: string) {
		if (!this.docs.delete(uri)) return;
		this.openedUris.delete(uri);
		this.diagnostics.delete(uri);
		this.connection.sendNotification("textDocument/didClose", {
			textDocument: { uri },
		});
	}

	/** Resolves true once the server reports ingestion complete, false on timeout. */
	waitForIngestion(timeoutMs: number): Promise<boolean> {
		if (this.load.ingestionComplete) return Promise.resolve(true);
		return new Promise((resolve) => {
			const t = setTimeout(() => resolve(false), timeoutMs);
			this.ingestionWaiters.push(() => {
				clearTimeout(t);
				resolve(true);
			});
		});
	}

	/**
	 * Restarts this project's server in place and replays its open documents, including
	 * unsaved text, so the new process sees exactly what the editor shows. Only this
	 * instance's own documents are ever replayed.
	 */
	async restart(settings?: Record<string, unknown>): Promise<number> {
		const t0 = performance.now();
		if (this.alive) await this.stop();
		this.proc = undefined;
		this.conn = undefined;
		await this.start();
		// same order as a first start: workspace ingestion before documents are (re)opened
		if (settings) await this.initializeWorkspace(settings);
		for (const uri of this.docs.keys()) this.sendOpen(uri);
		const ms = performance.now() - t0;
		this.restarts.push(Math.round(ms));
		return ms;
	}

	/** Graceful shutdown, escalating to SIGKILL. Resolves when the process has exited. */
	async stop(timeoutMs = 5000) {
		const proc = this.proc;
		if (!proc) return;
		this.stopping = true;
		const exited = new Promise<void>((resolve) => {
			if (proc.exitCode !== null || proc.signalCode !== null) resolve();
			else proc.once("exit", () => resolve());
		});
		try {
			await Promise.race([
				this.conn?.sendRequest("shutdown"),
				new Promise((_, rej) =>
					setTimeout(() => rej(new Error("shutdown timeout")), timeoutMs),
				),
			]);
			this.conn?.sendNotification("exit");
		} catch {}
		const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
		await exited;
		clearTimeout(timer);
		this.conn?.dispose();
	}
}
