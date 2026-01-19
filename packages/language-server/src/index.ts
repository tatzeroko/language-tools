import {
	createConnection,
	type InitializeParams,
	type InitializeResult,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

export const startServer = () => {
	const connection = createConnection(ProposedFeatures.all);
	const documents: TextDocuments<TextDocument> = new TextDocuments(
		TextDocument,
	);

	let seq = 0;
	// biome-ignore lint/suspicious/noExplicitAny: Needed for dynamic handlers
	const tsserverRequestHandlers = new Map<number, (res: any) => void>();

	/** Not in use at the moment */
	async function _sendTsServerRequest<T>(command: string, args: unknown[]) {
		return await new Promise<T | null>((resolve) => {
			const id = ++seq;
			tsserverRequestHandlers.set(id, resolve);
			connection.sendNotification("tsserver/request", [id, command, args]);
		});
	}

	connection.onInitialize((_params: InitializeParams): InitializeResult => {
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
			},
		};
	});

	connection.onNotification("tsserver/response", ([id, res]) => {
		tsserverRequestHandlers.get(id)?.(res);
		tsserverRequestHandlers.delete(id);
	});

	documents.listen(connection);
	connection.listen();
};
