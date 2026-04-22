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
	console.log("[tatzeroko-language-server] starting");
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
		return _sendTsServerRequest("_tatzeroko/updateApexTypes", [payload]).catch(
			() => {
				/** ignore */
			},
		);
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
				hoverProvider: true,
				textDocumentSync: TextDocumentSyncKind.Incremental,
			},
		};
	});

	connection.onHover((params: HoverParams): Hover | undefined => {
		console.log(
			"[tatzeroko-language-server] hover request",
			params.textDocument.uri,
			params.position.line,
			params.position.character,
		);
		const document = documents.get(params.textDocument.uri);
		if (!document || !latestApexTypes?.files.length) {
			console.log(
				"[tatzeroko-language-server] hover missing document-or-types",
				document ? "document" : "no-document",
				latestApexTypes?.files.length ?? 0,
			);
			return undefined;
		}

		const moduleName = findApexModuleAtPosition(document, params.position);
		if (!moduleName) {
			console.log("[tatzeroko-language-server] hover module not found");
			return undefined;
		}
		console.log("[tatzeroko-language-server] hover module", moduleName);

		const definition = latestApexTypes.files.find(
			(file) => file.moduleName === moduleName,
		);
		if (!definition) {
			console.log(
				"[tatzeroko-language-server] hover definition missing",
				moduleName,
			);
			return undefined;
		}
		console.log(
			"[tatzeroko-language-server] hover definition hit",
			definition.path,
			definition.content.length,
		);

		return {
			contents: {
				kind: "markdown",
				value: `\`\`\`ts\n${definition.content}\n\`\`\``,
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
