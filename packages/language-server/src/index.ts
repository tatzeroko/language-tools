import {
	createConnection,
	type DidChangeWatchedFilesParams,
	type Hover,
	type HoverParams,
	type InitializeParams,
	type InitializeResult,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { type ApexTypesPayload, ApexVirtualTypeService } from "./apex";

export const startServer = () => {
	const connection = createConnection(ProposedFeatures.all);
	const documents: TextDocuments<TextDocument> = new TextDocuments(
		TextDocument,
	);

	let seq = 0;
	// biome-ignore lint/suspicious/noExplicitAny: Needed for dynamic handlers
	const tsserverRequestHandlers = new Map<number, (res: any) => void>();
	let apexService: ApexVirtualTypeService | undefined;
	let latestApexTypes: ApexTypesPayload | undefined;

	/** Not in use at the moment */
	async function _sendTsServerRequest<T>(command: string, args: unknown[]) {
		return await new Promise<T | null>((resolve) => {
			const id = ++seq;
			tsserverRequestHandlers.set(id, resolve);
			connection.sendNotification("tsserver/request", [id, command, args]);
		});
	}

	const dispatchToTsserver = (payload: ApexTypesPayload) => {
		latestApexTypes = payload;
		return _sendTsServerRequest("_tatzeroko/updateApexTypes", [payload]).catch(
			() => {
				/** ignore */
			},
		);
	};

	connection.onInitialize((params: InitializeParams): InitializeResult => {
		const workspaceRoot = resolveWorkspaceRoot(params);
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
				hoverProvider: true,
				textDocumentSync: TextDocumentSyncKind.Incremental,
			},
		};
	});

	connection.onHover((params: HoverParams): Hover | undefined => {
		const document = documents.get(params.textDocument.uri);
		if (!document || !latestApexTypes?.files.length) {
			return undefined;
		}

		const moduleName = findApexModuleAtPosition(document, params.position);
		if (!moduleName) {
			return undefined;
		}

		const definition = latestApexTypes.files.find(
			(file) => file.moduleName === moduleName,
		);
		if (!definition) {
			return undefined;
		}

		return {
			contents: {
				kind: "markdown",
				value: `\`\`\`ts\n${definition.content}\n\`\`\``,
			},
		};
	});

	connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
		void apexService?.handleWatchedFiles(params);
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

	connection.onNotification("tsserver/response", ([id, res]) => {
		tsserverRequestHandlers.get(id)?.(res);
		tsserverRequestHandlers.delete(id);
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

function findApexModuleAtPosition(
	document: TextDocument,
	position: { line: number; character: number },
) {
	const text = document.getText();
	const offset = document.offsetAt(position);
	let start = offset;
	let end = offset;
	while (start > 0 && /[A-Za-z0-9_$]/.test(text.charAt(start - 1))) {
		start -= 1;
	}
	while (end < text.length && /[A-Za-z0-9_$]/.test(text.charAt(end))) {
		end += 1;
	}
	const localName = text.slice(start, end);
	if (!localName) {
		return undefined;
	}

	const importPattern =
		/import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](@salesforce\/apex\/[^"']+)["'];?/g;
	for (const match of text.matchAll(importPattern)) {
		if (match[1] === localName) {
			return match[2];
		}
	}

	return undefined;
}
