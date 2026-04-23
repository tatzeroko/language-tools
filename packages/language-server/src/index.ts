import {
	createConnection,
	type DidChangeWatchedFilesParams,
	type InitializeParams,
	type InitializeResult,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { type ApexTypesPayload, ApexVirtualTypeService } from "./apex";

export const startServer = () => {
	console.log("[tatzeroko-language-server] starting");
	const connection = createConnection(ProposedFeatures.all);
	const documents: TextDocuments<TextDocument> = new TextDocuments(
		TextDocument,
	);

	let seq = 0;
	// biome-ignore lint/suspicious/noExplicitAny: Needed for dynamic handlers
	const tsserverRequestHandlers = new Map<number, (res: any) => void>();
	let apexService: ApexVirtualTypeService | undefined;

	/** Not in use at the moment */
	async function _sendTsServerRequest<T>(command: string, args: unknown[]) {
		return await new Promise<T | null>((resolve) => {
			const id = ++seq;
			tsserverRequestHandlers.set(id, resolve);
			connection.sendNotification("tsserver/request", [id, command, args]);
		});
	}

	const dispatchToTsserver = (payload: ApexTypesPayload) => {
		console.log(
			"[tatzeroko-language-server] dispatching Apex types",
			payload.files.length,
			payload.workspace,
		);
		connection.sendNotification("tatzeroko/log", {
			message: `[tatzeroko] language-server dispatch workspace=${payload.workspace} files=${payload.files.length}`,
		});
		for (const file of payload.files) {
			console.log(
				`[tatzeroko-language-server] apex file path=${file.path} module=${file.moduleName} length=${file.content.length}`,
			);
		}
		connection.sendNotification("tatzeroko/log", {
			message: `[tatzeroko] dispatching Apex types ${payload.files.length} ${payload.workspace}`,
		});
		const id = ++seq;
		connection.sendNotification("tsserver/request", [
			id,
			"_tatzeroko/updateApexTypes",
			[payload],
		]);
		return Promise.resolve(null);
	};

	connection.onInitialize((params: InitializeParams): InitializeResult => {
		const workspaceRoot = resolveWorkspaceRoot(params);
		console.log("[tatzeroko-language-server] initialize", workspaceRoot);
		console.log(
			"[tatzeroko-language-server] initialize params",
			JSON.stringify({
				rootUri: params.rootUri,
				rootPath: params.rootPath,
				workspaceFolders: params.workspaceFolders?.map((folder) => folder.uri),
			}),
		);
		connection.sendNotification("tatzeroko/log", {
			message: `[tatzeroko] initialize ${workspaceRoot}`,
		});
		apexService = new ApexVirtualTypeService(
			connection,
			workspaceRoot,
			dispatchToTsserver,
		);
		void apexService.initialize().catch(() => {
			/** ignore startup scan errors */
		});

		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
			},
		};
	});

	connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
		console.log(
			"[tatzeroko-language-server] watched files",
			params.changes.map((change) => `${change.type}:${change.uri}`).join(","),
		);
		void apexService?.handleWatchedFiles(params);
	});

	connection.onShutdown(() => {
		apexService?.dispose();
		apexService = undefined;
	});

	documents.onDidChangeContent((event) => {
		console.log(
			"[tatzeroko-language-server] document changed",
			event.document.uri,
			event.document.getText().length,
		);
		apexService?.handleDocumentChanged(
			event.document.uri,
			event.document.getText(),
		);
	});

	documents.onDidSave((event) => {
		console.log(
			"[tatzeroko-language-server] document saved",
			event.document.uri,
			event.document.getText().length,
		);
		apexService?.handleDocumentSaved(
			event.document.uri,
			event.document.getText(),
		);
	});

	connection.onNotification("tsserver/response", ([id, res]) => {
		console.log("[tatzeroko-language-server] tsserver response", id, !!res);
		tsserverRequestHandlers.get(id)?.(res);
		tsserverRequestHandlers.delete(id);
	});

	connection.onNotification("tatzeroko/log", ({ message }) => {
		console.log("[tatzeroko-language-server] log relay", message);
		console.log(message);
	});

	documents.listen(connection);
	connection.listen();
};

function resolveWorkspaceRoot(params?: Partial<InitializeParams>) {
	const initializationOptions = params?.initializationOptions as
		| { workspaceRoot?: string }
		| undefined;
	if (typeof initializationOptions?.workspaceRoot === "string") {
		return initializationOptions.workspaceRoot;
	}
	if (params?.workspaceFolders?.length) {
		return params.workspaceFolders[0].uri.replace(/^file:\/\//, "");
	}
	if (params?.rootUri) {
		return params.rootUri.replace(/^file:\/\//, "");
	}
	return params?.rootPath ?? process.cwd();
}
