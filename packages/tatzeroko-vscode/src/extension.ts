import path from "node:path";
import * as vscode from "vscode";

import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

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
		const forward = async (attempt = 0): Promise<void> => {
			try {
				const res = (
					await vscode.commands.executeCommand<{ body?: unknown } | undefined>(
						"typescript.tsserverRequest",
						command,
						args,
						{ isAsync: true, lowPriority: true },
					)
				)?.body;
				if (
					res === undefined &&
					command === "_tatzeroko/updateApexTypes" &&
					attempt < 4
				) {
					setTimeout(() => void forward(attempt + 1), 250 * (attempt + 1));
				}
				client?.sendNotification("tsserver/response", [seq, res]);
				if (command === "_tatzeroko/updateApexTypes") {
					setTimeout(() => {
						void vscode.commands.executeCommand("typescript.reloadProjects");
					}, 0);
				}
			} catch {
				if (command === "_tatzeroko/updateApexTypes" && attempt < 4) {
					setTimeout(() => void forward(attempt + 1), 250 * (attempt + 1));
				}
				client?.sendNotification("tsserver/response", [seq, undefined]);
			}
		};

		void forward();
	});

	await vscode.extensions
		.getExtension("vscode.typescript-language-features")
		?.activate();

	client.start();
}

export function deactivate() {
	client?.stop();
}
