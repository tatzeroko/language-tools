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
		if (!this.hasWorkerScript()) {
			return generateApexVirtualFiles(this.workspaceRoot, sources);
		}
		const worker = this.ensureWorker();
		return await new Promise<ReadonlyArray<ApexVirtualFile>>(
			(resolve, reject) => {
				const requestId = ++this.requestSeq;
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
		this.worker?.terminate();
		this.worker = undefined;
		for (const { reject } of this.pending.values()) {
			reject(new Error("Apex generation worker disposed"));
		}
		this.pending.clear();
	}

	private ensureWorker() {
		if (this.worker) {
			return this.worker;
		}

		this.worker = new Worker(path.join(__dirname, "apex-generator.worker.js"), {
			workerData: { workspaceRoot: this.workspaceRoot },
		});
		this.worker.on("message", (message: GenerateResponse) => {
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
			for (const { reject } of this.pending.values()) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.pending.clear();
			this.worker = undefined;
		});
		this.worker.on("exit", () => {
			this.worker = undefined;
		});
		return this.worker;
	}

	private hasWorkerScript() {
		return fs.existsSync(path.join(__dirname, "apex-generator.worker.js"));
	}
}
