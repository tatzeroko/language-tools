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

export function activate(context: vscode.ExtensionContext) {
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
		vscode.commands
			.executeCommand<{ body?: unknown } | undefined>(
				"typescript.tsserverRequest",
				command,
				args,
				{ isAsync: true, lowPriority: true },
			)
			.then(
				(res) =>
					client?.sendNotification("tsserver/response", [seq, res?.body]),
				() => client?.sendNotification("tsserver/response", [seq, undefined]),
			);
	});

	client.start();
}

export function deactivate() {
	client?.stop();
}
