import { pathToFileURL } from "node:url";
import type { Position } from "vscode-languageserver-protocol";
import { type DxProject, ownerOf } from "./discovery.ts";
import type { ApexServerInstance } from "./server-host.ts";

/** Thrown instead of answering from another project when the owning server is down. */
export class ServerUnavailableError extends Error {
	readonly projectRoot: string;
	constructor(projectRoot: string, detail: string) {
		super(`Apex server for ${projectRoot} is unavailable: ${detail}`);
		this.name = "ServerUnavailableError";
		this.projectRoot = projectRoot;
	}
}

/** Routes LSP requests to the server instance owning the target file's DX project. */
export class ApexRouter {
	private readonly byRoot = new Map<string, ApexServerInstance>();
	private readonly projects: DxProject[];

	constructor(instances: ReadonlyArray<ApexServerInstance>) {
		this.projects = instances.map((i) => i.project);
		for (const i of instances) this.byRoot.set(i.project.root, i);
	}

	instanceFor(file: string) {
		const owner = ownerOf(file, this.projects);
		const instance = owner && this.byRoot.get(owner.root);
		if (!instance) throw new Error(`No Apex project owns ${file}`);
		if (!instance.alive) {
			const e = instance.exitInfo;
			throw new ServerUnavailableError(
				instance.project.root,
				e ? `exited (code=${e.code}, signal=${e.signal})` : "not started",
			);
		}
		return instance;
	}

	/** Swaps in a fresh instance for one project only; every other project is untouched. */
	replace(instance: ApexServerInstance) {
		if (!this.byRoot.has(instance.project.root))
			throw new Error(`Unknown project ${instance.project.root}`);
		this.byRoot.set(instance.project.root, instance);
	}

	completion(file: string, position: Position) {
		return this.instanceFor(file).connection.sendRequest(
			"textDocument/completion",
			{ textDocument: { uri: pathToFileURL(file).toString() }, position },
		) as Promise<{ items: Array<{ label: string }> } | null>;
	}

	definition(file: string, position: Position) {
		return this.instanceFor(file).connection.sendRequest(
			"textDocument/definition",
			{ textDocument: { uri: pathToFileURL(file).toString() }, position },
		) as Promise<Array<{ uri: string }> | null>;
	}

	/** Raw textDocument/diagnostic report (the TS Apex server pulls; it never pushes). */
	diagnosticReport(file: string) {
		return this.instanceFor(file).connection.sendRequest(
			"textDocument/diagnostic",
			{ textDocument: { uri: pathToFileURL(file).toString() } },
		) as Promise<DiagnosticReport>;
	}

	/**
	 * Workaround for a server limitation: semantic diagnostics are only produced for a document
	 * version after a hover/definition/completion has enriched it (a bare pull returns a
	 * "full" report with no items). A hover at (0,0) triggers that enrichment.
	 */
	async enrichedDiagnosticReport(file: string) {
		await this.instanceFor(file).connection.sendRequest("textDocument/hover", {
			textDocument: { uri: pathToFileURL(file).toString() },
			position: { line: 0, character: 0 },
		});
		return this.diagnosticReport(file);
	}

	async diagnostics(file: string) {
		return (await this.diagnosticReport(file)).items ?? [];
	}
}

export type DiagnosticReport = {
	kind: string;
	items?: Array<{ message: string; severity?: number; code?: string | number }>;
	relatedDocuments?: Record<string, { items?: Array<{ message: string }> }>;
};
