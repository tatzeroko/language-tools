import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
	Connection,
	DidChangeWatchedFilesParams,
} from "vscode-languageserver/node";

// Native Tree-sitter bindings loaded via CommonJS so pnpm can build them locally.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Parser = require("tree-sitter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TsSfApex = require("tree-sitter-sfapex");

export type ApexVirtualFile = {
	readonly path: string;
	readonly content: string;
	readonly moduleName: string;
};

export type ApexTypesPayload = {
	readonly workspace: string;
	readonly files: ReadonlyArray<ApexVirtualFile>;
};

type ApexMethod = {
	name: string;
	returnType: string;
	params: Array<{ name: string; type: string }>;
	docComment?: string;
};

type ApexClass = {
	name: string;
	methods: ApexMethod[];
};

const PRIMITIVE_TYPE_MAP: Record<string, string> = {
	String: "string",
	Integer: "number",
	Long: "number",
	Double: "number",
	Decimal: "number",
	Boolean: "boolean",
	Id: "string",
	Date: "string",
	Datetime: "string",
	Time: "string",
	Blob: "string",
	Object: "unknown",
	void: "void",
};

export class ApexVirtualTypeService {
	private parser: any;
	private readonly apexSources = new Map<string, string>();
	private readonly definitions = new Map<string, ApexVirtualFile>();
	private readonly presetSource = `global with sharing class ContactController {
    /**
     * @description Executes a search using either SOQL or SOSL based on search criteria.
     *
     * @param searchCriteria The search criteria in JSON format.
     * @param offset The number of records to skip.
     * @param pageSize The number of records to return.
     * @param sortField The field to sort the records by.
     * @param sortDirection The direction to sort the records in (asc or desc).
     *
     * @return A DTO containing the search results and the total number of records.
     */
    @AuraEnabled(cacheable=true)
    public static SearchResultsDTO search(
        String objApiName,
        String searchCriteria,
        Integer offset,
        Integer pageSize,
        String sortField,
        String sortDirection
    ) {
        return null;
    }
}`;

	constructor(
		private readonly connection: Connection,
		private readonly workspaceRoot: string,
		private readonly notifyTsServer: (
			payload: ApexTypesPayload,
		) => Promise<unknown>,
	) {}

	async initialize() {
		this.parser = new Parser();
		this.parser.setLanguage(TsSfApex.apex);
		this.apexSources.set(
			path.join(
				this.workspaceRoot,
				".tatzeroko",
				"preset",
				"ContactController.cls",
			),
			this.presetSource,
		);
		await this.generateDefinitions();
		void this.scheduleStartupSync();
	}

	async handleWatchedFiles(params: DidChangeWatchedFilesParams) {
		if (params.changes.some((change) => change.uri.endsWith(".cls"))) {
			await this.refreshFromWorkspace();
		}
	}

	handleDocumentChanged(uri: string, text: string) {
		const filePath = this.uriToPath(uri);
		if (!filePath || !filePath.endsWith(".cls")) {
			return;
		}
		this.apexSources.set(filePath, text);
		void this.generateDefinitions();
	}

	handleDocumentSaved(uri: string, text: string) {
		const filePath = this.uriToPath(uri);
		if (!filePath || !filePath.endsWith(".cls")) {
			return;
		}
		this.apexSources.set(filePath, text);
		void this.generateDefinitions();
	}

	private async refreshFromWorkspace() {
		const apexFiles = await this.collectApexFiles(this.workspaceRoot);
		const nextSources = new Map<string, string>();
		for (const filePath of apexFiles) {
			try {
				nextSources.set(filePath, await fs.readFile(filePath, "utf8"));
			} catch {
				/** ignore unreadable files */
			}
		}
		this.apexSources.clear();
		for (const [filePath, content] of nextSources) {
			this.apexSources.set(filePath, content);
		}
		await this.generateDefinitions();
	}

	private async generateDefinitions() {
		const nextDefinitions = new Map<string, ApexVirtualFile>();

		for (const [filePath, content] of this.apexSources) {
			void filePath;
			for (const apexClass of this.parseApexFile(content)) {
				for (const method of apexClass.methods) {
					const moduleName = `@salesforce/apex/${apexClass.name}.${method.name}`;
					const virtualPath = this.getVirtualFilePath(
						apexClass.name,
						method.name,
					);
					nextDefinitions.set(virtualPath, {
						path: virtualPath,
						content: this.renderModule(apexClass.name, method),
						moduleName,
					});
				}
			}
		}

		if (this.definitionsAreEqual(this.definitions, nextDefinitions)) {
			return;
		}

		this.definitions.clear();
		for (const [filePath, definition] of nextDefinitions) {
			this.definitions.set(filePath, definition);
		}

		const payload: ApexTypesPayload = {
			workspace: this.workspaceRoot,
			files: Array.from(this.definitions.values()),
		};
		await this.publishDefinitions(payload);
	}

	private async publishDefinitions(payload: ApexTypesPayload) {
		await this.notifyTsServer(payload);
		this.connection.sendNotification("tatzeroko/apexTypesUpdated", payload);
	}

	private async scheduleStartupSync() {
		const delays = [250, 1000, 2500];
		for (const delay of delays) {
			setTimeout(() => {
				const payload: ApexTypesPayload = {
					workspace: this.workspaceRoot,
					files: Array.from(this.definitions.values()),
				};
				void this.publishDefinitions(payload);
			}, delay);
		}
	}

	private definitionsAreEqual(
		current: Map<string, ApexVirtualFile>,
		next: Map<string, ApexVirtualFile>,
	) {
		if (current.size !== next.size) {
			return false;
		}
		for (const [key, value] of current) {
			const other = next.get(key);
			if (
				!other ||
				other.content !== value.content ||
				other.moduleName !== value.moduleName
			) {
				return false;
			}
		}
		return true;
	}

	private async collectApexFiles(root: string): Promise<string[]> {
		const result: string[] = [];
		const stack = [root];
		while (stack.length) {
			const dir = stack.pop();
			if (!dir) continue;
			let entries: Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name.startsWith(".")) {
						continue;
					}
					stack.push(fullPath);
					continue;
				}
				if (entry.isFile() && fullPath.endsWith(".cls")) {
					result.push(fullPath);
				}
			}
		}
		return result;
	}

	private parseApexFile(content: string) {
		if (!this.parser) {
			return [];
		}
		const tree = this.parser.parse(content);
		const classes: ApexClass[] = [];

		for (const classNode of tree.rootNode.descendantsOfType(
			"class_declaration",
		)) {
			const className = this.extractClassName(classNode);
			if (!className) continue;

			const methods: ApexMethod[] = [];
			for (const methodNode of classNode.descendantsOfType(
				"method_declaration",
			)) {
				if (!this.hasAuraEnabledAnnotation(methodNode)) continue;
				const methodName = this.extractMethodName(methodNode);
				if (!methodName) continue;
				const returnType = this.extractReturnType(methodNode);
				const params = this.extractParameters(methodNode);
				const docComment = this.extractDocComment(methodNode);
				methods.push({ name: methodName, params, returnType, docComment });
			}

			if (methods.length > 0) {
				classes.push({ name: className, methods });
			}
		}

		return classes;
	}

	private extractClassName(classNode: {
		namedChildren: Array<{ type: string; text: string }>;
	}) {
		const identifier = classNode.namedChildren.find(
			(child) => child.type === "identifier",
		);
		return identifier?.text?.trim();
	}

	private hasAuraEnabledAnnotation(methodNode: { namedChildren: Array<any> }) {
		const modifiers = methodNode.namedChildren.find(
			(child) => child.type === "modifiers",
		);
		if (!modifiers) return false;
		return modifiers.namedChildren?.some((child: any) => {
			if (child.type !== "annotation") return false;
			const identifier = child.namedChildren?.find(
				(grand: any) => grand.type === "identifier",
			);
			return identifier?.text === "AuraEnabled";
		});
	}

	private extractMethodName(methodNode: {
		namedChildren: Array<{ type: string; text: string }>;
	}) {
		const identifier = methodNode.namedChildren.find(
			(child) => child.type === "identifier",
		);
		return identifier?.text;
	}

	private extractReturnType(methodNode: {
		namedChildren: Array<{ type: string; text: string }>;
	}) {
		const candidate = methodNode.namedChildren.find((child) => {
			return (
				child.type !== "modifiers" &&
				child.type !== "identifier" &&
				child.type !== "formal_parameters" &&
				child.type !== "block"
			);
		});
		return candidate?.text?.trim() ?? "void";
	}

	private extractParameters(methodNode: { namedChildren: Array<any> }) {
		const paramsNode = methodNode.namedChildren.find(
			(child) => child.type === "formal_parameters",
		);
		if (!paramsNode) return [];

		return paramsNode.namedChildren
			.filter((child: any) => child.type === "formal_parameter")
			.map((param: any, index: number) => {
				const nameNode = param.namedChildren.find(
					(child: any) => child.type === "identifier",
				);
				const typeNode = param.namedChildren.find((child: any) => {
					return child.type !== "modifiers" && child.type !== "identifier";
				});
				return {
					name: nameNode?.text?.trim() ?? `arg${index}`,
					type: typeNode?.text?.trim() ?? "unknown",
				};
			});
	}

	private extractDocComment(methodNode: { previousNamedSibling?: any }) {
		const sibling = methodNode.previousNamedSibling;
		if (sibling?.type === "block_comment") {
			return sibling.text;
		}
		return undefined;
	}

	private renderModule(className: string, method: ApexMethod) {
		const paramTypeName = `${this.capitalize(this.sanitizeIdentifier(className))}${this.capitalize(this.sanitizeIdentifier(method.name))}Params`;
		const typeDef = this.buildParamType(paramTypeName, method.params);
		const docBlock = this.buildDocBlock(method.docComment);
		const returnType = this.mapApexType(method.returnType);
		return `${typeDef}${docBlock}export default function ${method.name}(params: ${paramTypeName}): Promise<${returnType}>;`;
	}

	private buildParamType(typeName: string, params: ApexMethod["params"]) {
		if (!params.length) {
			return `type ${typeName} = Record<string, unknown>;\n\n`;
		}
		const fields = params
			.map((param) => `\t${param.name}: ${this.mapApexType(param.type)};`)
			.join("\n");
		return `type ${typeName} = {\n${fields}\n};\n\n`;
	}

	private buildDocBlock(docComment?: string) {
		if (!docComment) {
			return "";
		}
		const info = this.parseDocComment(docComment);
		const lines = ["/**"];
		if (info.description) {
			for (const line of info.description.split(/\n+/)) {
				lines.push(` * ${line}`);
			}
		}
		lines.push(
			` * @param params - ${info.paramSummary ?? "The parameters for this call."}`,
		);
		if (info.returns) {
			lines.push(` * @return ${info.returns}`);
		}
		lines.push(" */\n");
		return `${lines.join("\n")}`;
	}

	private parseDocComment(comment: string) {
		const raw = comment
			.replace(/^\/\*\*/, "")
			.replace(/\*\/$/, "")
			.split(/\r?\n/)
			.map((line) => line.replace(/^\s*\*\s?/, "").trim())
			.filter(Boolean);
		const info: {
			description?: string;
			paramSummary?: string;
			returns?: string;
		} = {};
		let mode: "description" | "param" | "return" = "description";
		for (const line of raw) {
			const tagMatch = line.match(/^@(param|return)\s+(.*)$/);
			if (tagMatch) {
				mode = tagMatch[1] === "param" ? "param" : "return";
				if (mode === "param") {
					const paramMatch = tagMatch[2].match(/^(\w+)\s*-?\s*(.*)$/);
					if (paramMatch && paramMatch[1] === "params") {
						info.paramSummary = paramMatch[2].trim();
					}
				} else {
					info.returns = tagMatch[2].trim();
				}
				continue;
			}
			if (mode === "description") {
				info.description = info.description
					? `${info.description} ${line}`
					: line;
			} else if (mode === "return") {
				info.returns = info.returns ? `${info.returns} ${line}`.trim() : line;
			}
		}
		return info;
	}

	private mapApexType(type: string): string {
		const trimmed = type.trim();
		if (!trimmed) return "unknown";
		if (PRIMITIVE_TYPE_MAP[trimmed]) {
			return PRIMITIVE_TYPE_MAP[trimmed];
		}
		const arrayMatch = trimmed.match(/^(?:List|Set)<(.+)>$/);
		if (arrayMatch) {
			return `${this.mapApexType(arrayMatch[1])}[]`;
		}
		const mapMatch = trimmed.match(/^Map<(.+),\s*(.+)>$/);
		if (mapMatch) {
			return `Record<string, ${this.mapApexType(mapMatch[2])}>`;
		}
		if (trimmed.endsWith("[]")) {
			return `${this.mapApexType(trimmed.slice(0, -2))}[]`;
		}
		return "unknown";
	}

	private getVirtualFilePath(className: string, methodName: string) {
		return path.join(
			this.workspaceRoot,
			"node_modules",
			"@salesforce",
			"apex",
			`${className}.${methodName}.d.ts`,
		);
	}

	private sanitizeIdentifier(value: string) {
		return value.replace(/[^A-Za-z0-9_]/g, "");
	}

	private capitalize(value: string) {
		if (!value) return "";
		return value.charAt(0).toUpperCase() + value.slice(1);
	}

	private uriToPath(uri: string) {
		try {
			return uri.startsWith("file://")
				? decodeURIComponent(new URL(uri).pathname)
				: uri;
		} catch {
			return undefined;
		}
	}
}
