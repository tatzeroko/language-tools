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

/** Starts the Tatzeroko language server. */
export const startServer = () => {
	const connection = createConnection(ProposedFeatures.all);
	const documents: TextDocuments<TextDocument> = new TextDocuments(
		TextDocument,
	);

	let seq = 0;
	const tsserverRequestHandlers = new Map<number, (res: unknown) => void>();
	let apexService: ApexVirtualTypeService | undefined;

	const dispatchToTsserver = (payload: ApexTypesPayload) => {
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
		apexService = new ApexVirtualTypeService(
			connection,
			workspaceRoot,
			dispatchToTsserver,
		);
		void apexService.initialize().catch(() => {});

		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
			},
		};
	});

	connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
		void apexService?.handleWatchedFiles(params);
	});

	connection.onShutdown(() => {
		apexService?.dispose();
		apexService = undefined;
	});

	documents.onDidChangeContent((event) => {
		apexService?.handleDocumentChanged(
			event.document.uri,
			event.document.getText(),
		);
	});

	documents.onDidSave((event) => {
		apexService?.handleDocumentSaved(
			event.document.uri,
			event.document.getText(),
		);
	});

	connection.onNotification(
		"tsserver/response",
		([id, res]: [number, unknown]) => {
			tsserverRequestHandlers.get(id)?.(res);
			tsserverRequestHandlers.delete(id);
		},
	);

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
