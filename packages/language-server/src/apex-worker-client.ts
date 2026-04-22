import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import type { ApexVirtualFile } from "./apex-generator";
import { generateApexVirtualFiles } from "./apex-generator";

type GenerateRequest = {
	kind: "generate";
	requestId: number;
	sources: ReadonlyArray<readonly [string, string]>;
};

type GenerateResponse = {
	requestId: number;
	files?: ReadonlyArray<ApexVirtualFile>;
	error?: string;
};

export class ApexWorkerClient {
	private worker?: Worker;
	private readonly pending = new Map<
		number,
		{
			resolve: (files: ReadonlyArray<ApexVirtualFile>) => void;
			reject: (error: Error) => void;
		}
	>();
	private requestSeq = 0;

	constructor(private readonly workspaceRoot: string) {}

	async generate(
		sources: ReadonlyArray<readonly [string, string]>,
	): Promise<ReadonlyArray<ApexVirtualFile>> {
		console.log(
			`[tatzeroko-language-server] apex worker generate sources=${sources.length} workspace=${this.workspaceRoot}`,
		);
		if (!this.hasWorkerScript()) {
			console.log("[tatzeroko-language-server] apex worker fallback=direct");
			return generateApexVirtualFiles(this.workspaceRoot, sources);
		}
		const worker = this.ensureWorker();
		console.log("[tatzeroko-language-server] apex worker fallback=worker");
		return await new Promise<ReadonlyArray<ApexVirtualFile>>(
			(resolve, reject) => {
				const requestId = ++this.requestSeq;
				console.log(
					`[tatzeroko-language-server] apex worker request id=${requestId} sources=${sources.length}`,
				);
				this.pending.set(requestId, { resolve, reject });
				const message: GenerateRequest = {
					kind: "generate",
					requestId,
					sources,
				};
				worker.postMessage(message);
			},
		);
	}

	dispose() {
		console.log("[tatzeroko-language-server] apex worker dispose");
		this.worker?.terminate();
		this.worker = undefined;
		for (const { reject } of this.pending.values()) {
			reject(new Error("Apex generation worker disposed"));
		}
		this.pending.clear();
	}

	private ensureWorker() {
		if (this.worker) {
			console.log("[tatzeroko-language-server] apex worker reuse");
			return this.worker;
		}

		console.log(
			"[tatzeroko-language-server] apex worker create",
			this.workspaceRoot,
		);
		this.worker = new Worker(path.join(__dirname, "apex-generator.worker.js"), {
			workerData: { workspaceRoot: this.workspaceRoot },
		});
		this.worker.on("message", (message: GenerateResponse) => {
			console.log(
				`[tatzeroko-language-server] apex worker message requestId=${message.requestId} files=${message.files?.length ?? 0} error=${message.error ?? "none"}`,
			);
			const pending = this.pending.get(message.requestId);
			if (!pending) return;
			this.pending.delete(message.requestId);
			if (message.error) {
				pending.reject(new Error(message.error));
				return;
			}
			pending.resolve(message.files ?? []);
		});
		this.worker.on("error", (error) => {
			console.log("[tatzeroko-language-server] apex worker error", error);
			for (const { reject } of this.pending.values()) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.pending.clear();
			this.worker = undefined;
		});
		this.worker.on("exit", () => {
			console.log("[tatzeroko-language-server] apex worker exit");
			this.worker = undefined;
		});
		return this.worker;
	}

	private hasWorkerScript() {
		const exists = fs.existsSync(
			path.join(__dirname, "apex-generator.worker.js"),
		);
		console.log(
			`[tatzeroko-language-server] apex worker script exists=${exists}`,
		);
		return exists;
	}
}
