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
import type { DxProject } from "./discovery.ts";
import { listOwnedFiles } from "./discovery.ts";

export type LaunchSpec = { command: string; args: string[] };

/** Spawn spec for the Salesforce TypeScript Apex language server (stdio). */
export function tsServerSpec(serverModule: string): LaunchSpec {
	return { command: process.execPath, args: [serverModule, "--stdio"] };
}

/** Spawn spec for legacy Jorje; `jar` points at an installed apex-jorje-lsp.jar. */
export function jorjeSpec(jar: string, java = "java"): LaunchSpec {
	return {
		command: java,
		args: ["-cp", jar, "-Xmx512M", "apex.jorje.lsp.ApexLanguageServerLauncher"],
	};
}

export type ServerOptions = {
	/** Extra environment variables for the server process. */
	env?: NodeJS.ProcessEnv;
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
		const proc = spawn(this.spec.command, this.spec.args, {
			cwd: this.project.root,
			env: { ...process.env, ...this.options.env },
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
		conn.onRequest("window/workDoneProgress/create", () => null);
		conn.listen();

		const rootUri = pathToFileURL(this.project.root).toString();
		const params: InitializeParams = {
			processId: process.pid,
			rootUri,
			workspaceFolders: [this.folder],
			capabilities: {
				workspace: { workspaceFolders: true, configuration: true },
				textDocument: {
					synchronization: { didSave: true },
					completion: { completionItem: { snippetSupport: false } },
					definition: { linkSupport: false },
					publishDiagnostics: {},
				},
			},
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

	/** Opens every file this project owns so the server builds its own symbol graph. */
	openOwnedFiles() {
		for (const file of listOwnedFiles(this.project)) this.openFile(file);
	}

	openFile(file: string, version = 1) {
		const uri = pathToFileURL(file).toString();
		this.openedUris.add(uri);
		this.connection.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: "apex",
				version,
				text: readFileSync(file, "utf8"),
			},
		});
		return uri;
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
