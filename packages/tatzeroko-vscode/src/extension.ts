import path from "node:path";
import * as vscode from "vscode";

import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";

import { findTsProbeFile } from "./transport";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;

type ApexUpdateRequest = {
	readonly workspace?: string;
	readonly files?: ReadonlyArray<{
		readonly path: string;
		readonly content: string;
		readonly moduleName: string;
	}>;
};

function resolveServerModule(context: vscode.ExtensionContext) {
	try {
		return require.resolve("@tatzeroko/language-server/server");
	} catch {
		/** ignore */
	}

	const bundled = path.join(
		context.extensionUri.fsPath,
		"language-server",
		"dist",
		"index.js",
	);

	try {
		return require.resolve(bundled);
	} catch {
		/** ignore */
	}

	throw new Error("Could not resolve language server module");
}

export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("Tatzeroko");
	console.log("[tatzeroko] activating extension");
	outputChannel.appendLine("[tatzeroko] activating extension");
	outputChannel.appendLine(
		`[tatzeroko] extensionUri=${context.extensionUri.fsPath} workspaceFolders=${vscode.workspace.workspaceFolders?.length ?? 0}`,
	);
	const serverModule = resolveServerModule(context);
	outputChannel.appendLine(`[tatzeroko] serverModule=${serverModule}`);
	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc,
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		},
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: "file", language: "javascript" },
			{ scheme: "file", language: "typescript" },
		],
	};

	client = new LanguageClient(
		"tatzeroko-language-client",
		"Tatzeroko Language Client",
		serverOptions,
		clientOptions,
	);
	outputChannel.appendLine("[tatzeroko] language client created");

	client.onNotification("tsserver/request", ([seq, command, args]) => {
		console.log("[tatzeroko] tsserver request", seq, command);
		outputChannel?.appendLine(
			`[tatzeroko] tsserver request seq=${seq} command=${command}`,
		);
		if (command === "_tatzeroko/updateApexTypes") {
			const payload = Array.isArray(args) ? args[0] : args;
			const fileCount =
				payload &&
				typeof payload === "object" &&
				"files" in payload &&
				Array.isArray((payload as { files?: unknown[] }).files)
					? (payload as { files: unknown[] }).files.length
					: 0;
			console.log("[tatzeroko] updateApexTypes payload", fileCount, payload);
			outputChannel?.appendLine(
				`[tatzeroko] updateApexTypes payload files=${fileCount} workspace=${(payload as { workspace?: string } | undefined)?.workspace ?? "undefined"}`,
			);
		}
		const forward = async (attempt = 0): Promise<void> => {
			try {
				outputChannel?.appendLine(
					`[tatzeroko] forwarding command=${command} attempt=${attempt}`,
				);
				if (command === "_tatzeroko/updateApexTypes") {
					const payload = Array.isArray(args) ? args[0] : args;
					if (
						payload &&
						typeof payload === "object" &&
						"workspace" in payload &&
						typeof (payload as { workspace?: unknown }).workspace === "string"
					) {
						const probeFile = await findTsProbeFile(
							(payload as { workspace: string }).workspace,
						);
						console.log("[tatzeroko] ts probe file", probeFile ?? "undefined");
						outputChannel?.appendLine(
							`[tatzeroko] ts probe file ${probeFile ?? "undefined"}`,
						);
					} else {
						outputChannel?.appendLine(
							"[tatzeroko] updateApexTypes payload missing workspace",
						);
					}
				}
				if (command === "_tatzeroko/updateApexTypes") {
					void Promise.resolve(
						vscode.commands.executeCommand<{ body?: unknown } | undefined>(
							"typescript.tsserverRequest",
							command,
							args,
							{ isAsync: true, lowPriority: true },
						),
					)
						.then((res) => {
							outputChannel?.appendLine(
								`[tatzeroko] tsserver raw response command=${command} hasBody=${res?.body !== undefined}`,
							);
							if (res?.body !== undefined) {
								outputChannel?.appendLine(
									`[tatzeroko] updateApexTypes response=${JSON.stringify(res.body)}`,
								);
							}
						})
						.catch((error: unknown) => {
							outputChannel?.appendLine(
								`[tatzeroko] tsserver request error ${String(error)}`,
							);
						});
					console.log("[tatzeroko] tsserver response", command, false);
					outputChannel?.appendLine(
						`[tatzeroko] tsserver response ${command} empty`,
					);
					client?.sendNotification("tsserver/response", [seq, undefined]);
					return;
				}

				const res = (
					await withTimeout(
						vscode.commands.executeCommand<{ body?: unknown } | undefined>(
							"typescript.tsserverRequest",
							command,
							args,
							{ isAsync: true, lowPriority: true },
						),
						5000,
					)
				)?.body;
				outputChannel?.appendLine(
					`[tatzeroko] tsserver raw response command=${command} hasBody=${res !== undefined}`,
				);
				if (command === "_tatzeroko/updateApexTypes" && res !== undefined) {
					outputChannel?.appendLine(
						`[tatzeroko] updateApexTypes response=${JSON.stringify(res)}`,
					);
				}
				console.log("[tatzeroko] tsserver response", command, !!res);
				outputChannel?.appendLine(
					`[tatzeroko] tsserver response ${command} ${res ? "ok" : "empty"}`,
				);
				client?.sendNotification("tsserver/response", [seq, res]);
			} catch (error) {
				console.log(
					"[tatzeroko] tsserver request failed",
					command,
					attempt,
					error,
				);
				outputChannel?.appendLine(
					`[tatzeroko] tsserver request failed ${command} attempt=${attempt}`,
				);
				outputChannel?.appendLine(
					`[tatzeroko] tsserver request error ${String(error)}`,
				);
				client?.sendNotification("tsserver/response", [seq, undefined]);
			}
		};

		void forward();
	});

	client.onNotification("tatzeroko/log", ({ message }) => {
		outputChannel?.appendLine(`[tatzeroko] ls ${message}`);
		outputChannel?.appendLine(message);
	});

	await vscode.extensions
		.getExtension("vscode.typescript-language-features")
		?.activate();
	console.log("[tatzeroko] typescript-language-features activated");
	outputChannel?.appendLine(
		"[tatzeroko] typescript-language-features activated",
	);

	client.start();
}

export function deactivate() {
	client?.stop();
	outputChannel?.dispose();
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number) {
	return await Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error(`timeout after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]);
}
