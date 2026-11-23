import type {
	ClientCapabilities,
	SymbolKind,
} from "vscode-languageserver-protocol/node";

const symbolKinds = Array.from({ length: 26 }, (_, i) => i + 1) as SymbolKind[];

/**
 * Subset of the official client's DEVELOPMENT_CLIENT_CAPABILITIES
 * (apex-lsp-shared/src/client/ApexClientCapabilities.ts). The server gates behaviour on these:
 * the `experimental.*Provider` flags decide whether it asks for a workspace load / ingestion
 * notifications, and `textDocument.diagnostic` selects pull diagnostics.
 * Semantic-token legend, work-done progress UI and file-operation edits are not needed headless.
 */
export const apexClientCapabilities: ClientCapabilities = {
	workspace: {
		applyEdit: true,
		didChangeConfiguration: { dynamicRegistration: true },
		didChangeWatchedFiles: { dynamicRegistration: true },
		configuration: true,
		workspaceFolders: true,
	},
	textDocument: {
		synchronization: {
			dynamicRegistration: true,
			willSave: true,
			willSaveWaitUntil: true,
			didSave: true,
		},
		publishDiagnostics: { relatedInformation: true, versionSupport: false },
		documentSymbol: {
			dynamicRegistration: true,
			symbolKind: { valueSet: symbolKinds },
			hierarchicalDocumentSymbolSupport: true,
		},
		diagnostic: { dynamicRegistration: true },
		semanticTokens: {
			requests: { full: true },
			tokenTypes: [
				"namespace",
				"class",
				"interface",
				"enum",
				"enumMember",
				"type",
				"parameter",
				"variable",
				"property",
				"method",
				"decorator",
				"keyword",
				"string",
				"number",
			],
			tokenModifiers: [
				"declaration",
				"readonly",
				"static",
				"abstract",
				"deprecated",
				"modification",
				"defaultLibrary",
			],
			formats: ["relative"],
		},
		foldingRange: {
			dynamicRegistration: true,
			rangeLimit: 5000,
			lineFoldingOnly: true,
		},
		codeLens: { dynamicRegistration: true },
		hover: {
			dynamicRegistration: true,
			contentFormat: ["markdown", "plaintext"],
		},
		references: { dynamicRegistration: true },
		completion: {
			dynamicRegistration: true,
			contextSupport: true,
			completionItem: {
				snippetSupport: true,
				commitCharactersSupport: true,
				documentationFormat: ["markdown", "plaintext"],
				deprecatedSupport: true,
				preselectSupport: true,
			},
		},
		definition: { dynamicRegistration: true },
	},
	window: { workDoneProgress: true },
	experimental: {
		findMissingArtifactProvider: {
			enabled: true,
			supportedModes: ["blocking", "background"],
		},
		workspaceIngestionProvider: { enabled: true },
		requestWorkspaceLoadProvider: { enabled: true },
	},
};
