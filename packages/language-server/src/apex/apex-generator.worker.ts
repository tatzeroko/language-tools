import { parentPort, workerData } from "node:worker_threads";

import { generateApexVirtualFiles } from "./apex-generator";

type GenerateRequest = {
	kind: "generate";
	requestId: number;
	sources: ReadonlyArray<readonly [string, string]>;
};

type GenerateResponse = {
	requestId: number;
	files: ReturnType<typeof generateApexVirtualFiles>;
};

type WorkerData = {
	workspaceRoot: string;
};

const { workspaceRoot } = workerData as WorkerData;

parentPort?.on("message", (message: GenerateRequest) => {
	if (message.kind !== "generate") {
		return;
	}

	try {
		const files = generateApexVirtualFiles(workspaceRoot, message.sources);
		const response: GenerateResponse = {
			requestId: message.requestId,
			files,
		};
		parentPort?.postMessage(response);
	} catch (error) {
		parentPort?.postMessage({
			requestId: message.requestId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});
