import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import type { ProtocolConnection } from "vscode-languageserver-protocol/node";
import type { DxProject } from "./discovery.ts";
import { listOwnedFiles } from "./discovery.ts";

export type WorkspaceFile = {
	uri: string;
	version: number;
	content: string;
	namespace?: string;
};

/**
 * Reads the files a project owns, tagged with the project's namespace.
 * Differences from the official client (which globs every workspace folder for
 * `**\/*.cls|trigger|apex`): only this project's packageDirectories are read and nested DX
 * projects are skipped, so a root project can never ingest a nested managed package.
 */
export function readOwnedWorkspaceFiles(project: DxProject): WorkspaceFile[] {
	return listOwnedFiles(project).map((file) => ({
		uri: pathToFileURL(file).toString(),
		version: 1,
		content: readFileSync(file, "utf8"),
		namespace: project.namespace || undefined,
	}));
}

/** Same wire format as `compressWorkspaceFileBatch` + `encodeWorkspaceBatchForTransport` in apex-lsp-client. */
export function encodeBatch(
	batchIndex: number,
	totalBatches: number,
	files: WorkspaceFile[],
): { compressedData: string; fileMetadata: object[] } {
	const enc = new TextEncoder();
	const fileMetadata = files.map((f) => ({
		uri: f.uri,
		version: f.version,
		namespace: f.namespace,
	}));
	const entries: Record<string, Uint8Array> = {};
	for (const f of files) entries[f.uri] = enc.encode(f.content);
	entries["__metadata.json"] = enc.encode(
		JSON.stringify({
			batchIndex,
			totalBatches,
			isLastBatch: batchIndex === totalBatches - 1,
			fileMetadata,
		}),
	);
	return {
		compressedData: Buffer.from(zipSync(entries, { level: 6 })).toString(
			"base64",
		),
		fileMetadata,
	};
}

let sessionCounter = 0;

/**
 * Answers an `apex/requestWorkspaceLoad` notification the way the official client does:
 * `apex/sendWorkspaceBatch` for each batch, `apex/processWorkspaceBatches`, then
 * `apex/workspaceLoadComplete`. The server answers with `apex/workspaceIngestionComplete`
 * when background ingestion is finished.
 */
export async function loadWorkspace(
	conn: ProtocolConnection,
	files: WorkspaceFile[],
	batchSize = 100,
): Promise<{ batches: number; files: number }> {
	const sessionId = `poc-workspace-load-${Date.now()}-${++sessionCounter}`;
	const totalBatches = Math.max(1, Math.ceil(files.length / batchSize));
	try {
		for (let i = 0; i < totalBatches; i++) {
			const slice = files.slice(i * batchSize, (i + 1) * batchSize);
			const { compressedData, fileMetadata } = encodeBatch(
				i,
				totalBatches,
				slice,
			);
			const r = (await conn.sendRequest("apex/sendWorkspaceBatch", {
				sessionId,
				batchIndex: i,
				totalBatches,
				isLastBatch: i === totalBatches - 1,
				compressedData,
				fileMetadata,
			})) as { success?: boolean; error?: string };
			if (r && r.success === false)
				throw new Error(`batch ${i}: ${r.error ?? "rejected"}`);
		}
		const p = (await conn.sendRequest("apex/processWorkspaceBatches", {
			sessionId,
			totalBatches,
		})) as { success?: boolean; error?: string };
		if (p && p.success === false) throw new Error(p.error ?? "process failed");
		conn.sendNotification("apex/workspaceLoadComplete", { success: true });
		return { batches: totalBatches, files: files.length };
	} catch (e) {
		conn.sendNotification("apex/workspaceLoadFailed", {
			success: false,
			error: String(e),
		});
		throw e;
	}
}
