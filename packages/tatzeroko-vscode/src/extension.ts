import path from "node:path";
import * as vscode from "vscode";

import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;

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
	outputChannel.appendLine("[tatzeroko] activating extension");

	const serverModule = resolveServerModule(context);
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

	client.onNotification("tsserver/request", ([seq, command, args]) => {
		void (async () => {
			try {
				const isInternal = command.startsWith("_tatzeroko/");
				if (isInternal) {
					void Promise.resolve(
						vscode.commands.executeCommand<{ body?: unknown } | undefined>(
							"typescript.tsserverRequest",
							command,
							args,
							{ isAsync: true, lowPriority: true },
						),
					).catch((error: unknown) => {
						outputChannel?.appendLine(
							`[tatzeroko] tsserver request error ${String(error)}`,
						);
					});
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
				client?.sendNotification("tsserver/response", [seq, res]);
			} catch (error) {
				outputChannel?.appendLine(
					`[tatzeroko] tsserver request failed ${command}: ${String(error)}`,
				);
				client?.sendNotification("tsserver/response", [seq, undefined]);
			}
		})();
	});

	await vscode.extensions
		.getExtension("vscode.typescript-language-features")
		?.activate();
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
