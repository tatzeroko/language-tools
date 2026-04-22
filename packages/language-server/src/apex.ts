import type { Dirent } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
	Connection,
	DidChangeWatchedFilesParams,
} from "vscode-languageserver/node";

import { generateApexVirtualFiles } from "./apex-generator";
import { ApexWorkerClient } from "./apex-worker-client";

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
	private workerClient?: ApexWorkerClient;
	private workspaceWatchers: fsSync.FSWatcher[] = [];
	private workspaceRefreshTimer?: ReturnType<typeof setTimeout>;
	private workspaceWatcherMode: "recursive" | "directories" | "none" = "none";
	private generationTimer?: ReturnType<typeof setTimeout>;
	private generationTicket = 0;
	private workspaceRevision = 0;

	constructor(
		private readonly connection: Connection,
		private readonly workspaceRoot: string,
		private readonly notifyTsServer: (
			payload: ApexTypesPayload,
		) => Promise<unknown>,
	) {}

	async initialize() {
		console.log("[tatzeroko-language-server] apex service initialize");
		this.log(`apex service initialize workspace=${this.workspaceRoot}`);
		this.workerClient = new ApexWorkerClient(this.workspaceRoot);
		await this.startWorkspaceWatcher();
		void this.refreshFromWorkspace();
	}

	async handleWatchedFiles(params: DidChangeWatchedFilesParams) {
		this.log(
			`watched files changes=${params.changes.length} ${params.changes.map((change) => `${change.type}:${change.uri}`).join(",")}`,
		);
		if (params.changes.some((change) => change.uri.endsWith(".cls"))) {
			this.log("watched files matched .cls, refreshing workspace");
			await this.refreshFromWorkspace();
		} else {
			this.log("watched files ignored, no .cls changes");
		}
	}

	handleDocumentChanged(uri: string, text: string) {
		const filePath = this.uriToPath(uri);
		if (!filePath || !filePath.endsWith(".cls")) {
			this.log(
				`document changed ignored uri=${uri} path=${filePath ?? "undefined"}`,
			);
			return;
		}
		this.workspaceRevision += 1;
		this.apexSources.set(filePath, text);
		this.log(
			`document changed path=${filePath} revision=${this.workspaceRevision} length=${text.length} sources=${this.apexSources.size}`,
		);
		void this.scheduleGeneration();
	}

	handleDocumentSaved(uri: string, text: string) {
		const filePath = this.uriToPath(uri);
		if (!filePath || !filePath.endsWith(".cls")) {
			this.log(
				`document saved ignored uri=${uri} path=${filePath ?? "undefined"}`,
			);
			return;
		}
		this.workspaceRevision += 1;
		this.apexSources.set(filePath, text);
		this.log(
			`document saved path=${filePath} revision=${this.workspaceRevision} length=${text.length} sources=${this.apexSources.size}`,
		);
		void this.scheduleGeneration();
	}

	private async refreshFromWorkspace() {
		const revision = this.workspaceRevision;
		this.log(
			`refreshFromWorkspace start revision=${revision} workspace=${this.workspaceRoot}`,
		);
		const apexFiles = await this.collectApexFiles(this.workspaceRoot);
		this.log(`refreshFromWorkspace collected=${apexFiles.length}`);
		const nextSources = new Map<string, string>();
		for (const filePath of apexFiles) {
			try {
				nextSources.set(filePath, await fs.readFile(filePath, "utf8"));
				this.log(`refreshFromWorkspace read file=${filePath}`);
			} catch {
				this.log(`refreshFromWorkspace unreadable file=${filePath}`);
			}
		}
		if (revision !== this.workspaceRevision) {
			this.log(
				`refreshFromWorkspace aborted stale revision expected=${revision} actual=${this.workspaceRevision}`,
			);
			return;
		}
		this.apexSources.clear();
		for (const [filePath, content] of nextSources) {
			this.apexSources.set(filePath, content);
		}
		this.log(
			`refreshFromWorkspace replaced sources count=${this.apexSources.size}`,
		);
		await this.scheduleGeneration();
		if (this.workspaceWatcherMode === "directories") {
			await this.refreshDirectoryWatchers();
		}
	}

	private async startWorkspaceWatcher() {
		if (this.workspaceWatchers.length || this.workspaceWatcherMode !== "none") {
			return;
		}

		try {
			const watcher = fsSync.watch(
				this.workspaceRoot,
				{ recursive: true },
				(eventType, filename) => {
					this.log(
						`workspace watcher event mode=recursive type=${eventType} file=${String(filename ?? "undefined")}`,
					);
					void this.scheduleWorkspaceRefresh();
				},
			);
			this.workspaceWatchers = [watcher];
			this.workspaceWatcherMode = "recursive";
			this.log(
				`workspace watcher started mode=recursive root=${this.workspaceRoot}`,
			);
			return;
		} catch (error) {
			this.log(
				`workspace watcher recursive failed root=${this.workspaceRoot} error=${String(error)}`,
			);
		}

		this.workspaceWatcherMode = "directories";
		await this.refreshDirectoryWatchers();
	}

	private async refreshDirectoryWatchers() {
		this.closeWorkspaceWatchers();
		this.log(
			`workspace watcher refreshing directories root=${this.workspaceRoot}`,
		);
		const directories = await this.collectApexDirectories(this.workspaceRoot);
		for (const directory of directories) {
			try {
				const watcher = fsSync.watch(directory, (eventType, filename) => {
					this.log(
						`workspace watcher event mode=directories dir=${directory} type=${eventType} file=${String(filename ?? "undefined")}`,
					);
					void this.scheduleWorkspaceRefresh();
				});
				watcher.on("error", (error) => {
					this.log(
						`workspace watcher error dir=${directory} error=${String(error)}`,
					);
				});
				this.workspaceWatchers.push(watcher);
			} catch (error) {
				this.log(
					`workspace watcher directory failed dir=${directory} error=${String(error)}`,
				);
			}
		}
	}

	private closeWorkspaceWatchers() {
		for (const watcher of this.workspaceWatchers) {
			try {
				watcher.close();
			} catch {
				// Ignore watcher shutdown errors.
			}
		}
		this.workspaceWatchers = [];
	}

	private scheduleWorkspaceRefresh() {
		if (this.workspaceRefreshTimer) {
			clearTimeout(this.workspaceRefreshTimer);
		}
		this.workspaceRefreshTimer = setTimeout(() => {
			void this.refreshFromWorkspace();
		}, 50);
	}

	private async collectApexDirectories(root: string): Promise<string[]> {
		this.log(`collectApexDirectories start root=${root}`);
		const result = new Set<string>([root]);
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
				if (!entry.isDirectory()) continue;
				if (entry.name === "node_modules" || entry.name.startsWith(".")) {
					continue;
				}
				const fullPath = path.join(dir, entry.name);
				result.add(fullPath);
				stack.push(fullPath);
			}
		}
		const directories = Array.from(result);
		this.log(
			`collectApexDirectories done root=${root} count=${directories.length}`,
		);
		return directories;
	}

	private async scheduleGeneration() {
		const ticket = ++this.generationTicket;
		this.log(
			`scheduleGeneration ticket=${ticket} revision=${this.workspaceRevision}`,
		);
		if (this.generationTimer) {
			this.log("scheduleGeneration clearing existing timer");
			clearTimeout(this.generationTimer);
		}
		this.generationTimer = setTimeout(() => {
			this.log(`scheduleGeneration firing ticket=${ticket}`);
			void this.generateDefinitions(ticket);
		}, 0);
	}

	private async generateDefinitions(ticket: number) {
		const workerClient = this.workerClient;
		if (!workerClient) {
			this.log(`generateDefinitions skipped ticket=${ticket} reason=no-worker`);
			return;
		}
		console.log(
			"[tatzeroko-language-server] generating Apex definitions",
			this.apexSources.size,
		);
		this.log(
			`generateDefinitions start ticket=${ticket} sources=${this.apexSources.size} existingDefinitions=${this.definitions.size}`,
		);
		const sources = Array.from(this.apexSources.entries());
		this.log(
			`generateDefinitions sourcePaths=${sources.map(([filePath]) => filePath).join(",")}`,
		);
		const placeholderDefinitions = generateApexVirtualFiles(
			this.workspaceRoot,
			sources,
			{ placeholder: true },
		);
		const placeholderMap = new Map(
			placeholderDefinitions.map((definition) => [definition.path, definition]),
		);
		if (!this.definitionsAreEqual(this.definitions, placeholderMap)) {
			this.log(
				`generateDefinitions publishing placeholder files=${placeholderDefinitions.length} workspace=${this.workspaceRoot}`,
			);
			this.definitions.clear();
			for (const [filePath, definition] of placeholderMap) {
				this.definitions.set(filePath, definition);
			}
			await this.publishDefinitions({
				workspace: this.workspaceRoot,
				files: placeholderDefinitions,
			});
		}
		const nextDefinitions = new Map<string, ApexVirtualFile>();
		for (const file of await workerClient.generate(sources)) {
			this.log(
				`generateDefinitions worker file path=${file.path} module=${file.moduleName} length=${file.content.length}`,
			);
			nextDefinitions.set(file.path, file);
		}

		if (ticket !== this.generationTicket) {
			this.log(
				`generateDefinitions skipped stale ticket=${ticket} current=${this.generationTicket}`,
			);
			return;
		}

		if (this.definitionsAreEqual(this.definitions, nextDefinitions)) {
			this.log(`generateDefinitions no changes ticket=${ticket}`);
			return;
		}

		this.log(
			`generateDefinitions changed ticket=${ticket} nextCount=${nextDefinitions.size}`,
		);
		this.definitions.clear();
		for (const [filePath, definition] of nextDefinitions) {
			this.definitions.set(filePath, definition);
		}

		const payload: ApexTypesPayload = {
			workspace: this.workspaceRoot,
			files: Array.from(this.definitions.values()),
		};
		this.log(
			`generateDefinitions publishing files=${payload.files.length} workspace=${payload.workspace}`,
		);
		await this.publishDefinitions(payload);
	}

	private async generateDefinitionsLegacy() {
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
		this.log(
			`publishDefinitions start workspace=${payload.workspace} files=${payload.files.length}`,
		);
		await this.notifyTsServer(payload);
		this.log(
			`publishDefinitions tsserver notified workspace=${payload.workspace}`,
		);
		this.connection.sendNotification("tatzeroko/apexTypesUpdated", payload);
		this.log(
			`publishDefinitions notification sent workspace=${payload.workspace}`,
		);
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
		this.log(`collectApexFiles start root=${root}`);
		const result: string[] = [];
		const stack = [root];
		while (stack.length) {
			const dir = stack.pop();
			if (!dir) continue;
			let entries: Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
				this.log(`collectApexFiles dir=${dir} entries=${entries.length}`);
			} catch {
				this.log(`collectApexFiles unreadable dir=${dir}`);
				continue;
			}
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name.startsWith(".")) {
						this.log(`collectApexFiles skipDir=${fullPath}`);
						continue;
					}
					stack.push(fullPath);
					continue;
				}
				if (entry.isFile() && fullPath.endsWith(".cls")) {
					this.log(`collectApexFiles hit=${fullPath}`);
					result.push(fullPath);
				}
			}
		}
		this.log(`collectApexFiles done root=${root} count=${result.length}`);
		return result;
	}

	private parseApexFile(content: string) {
		if (!this.parser) {
			this.log("parseApexFile skipped reason=no-parser");
			return [];
		}
		this.log(`parseApexFile start length=${content.length}`);
		const tree = this.parser.parse(content);
		const classes: ApexClass[] = [];

		for (const classNode of tree.rootNode.descendantsOfType(
			"class_declaration",
		)) {
			const className = this.extractClassName(classNode);
			if (!className) continue;
			this.log(`parseApexFile class=${className}`);

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
				this.log(
					`parseApexFile method=${className}.${methodName} return=${returnType} params=${params.length} doc=${docComment ? "yes" : "no"}`,
				);
				methods.push({ name: methodName, params, returnType, docComment });
			}

			if (methods.length > 0) {
				this.log(
					`parseApexFile classAccepted=${className} methods=${methods.length}`,
				);
				classes.push({ name: className, methods });
			} else {
				this.log(
					`parseApexFile classSkipped=${className} reason=no-aura-methods`,
				);
			}
		}

		this.log(`parseApexFile done classes=${classes.length}`);
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
		const docBlock = this.buildDocBlock(method.docComment);
		const returnType = this.mapApexType(method.returnType);
		const paramsType = !method.params.length
			? "Record<string, unknown>"
			: `{\n${method.params
					.map((param) => `\t${param.name}: ${this.mapApexType(param.type)};`)
					.join("\n")}\n}`;
		const rendered = `${docBlock}export default function ${method.name}(params: ${paramsType}): Promise<${returnType}>;`;
		this.log(
			`renderModule class=${className} method=${method.name} renderedLength=${rendered.length}`,
		);
		return rendered;
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
		for (const [name, description] of info.paramDocs) {
			lines.push(` * @param params.${name} - ${description}`);
		}
		if (info.returns) {
			lines.push(` * @return ${info.returns}`);
		}
		lines.push(" */\n");
		return `${lines.join("\n")}`;
	}

	private parseDocComment(comment: string) {
		this.log(`parseDocComment length=${comment.length}`);
		const raw = comment
			.replace(/^\/\*\*/, "")
			.replace(/\*\/$/, "")
			.split(/\r?\n/)
			.map((line) => line.replace(/^\s*\*\s?/, "").trim())
			.filter(Boolean);
		const info: {
			description?: string;
			paramSummary?: string;
			paramDocs: Map<string, string>;
			returns?: string;
		} = { paramDocs: new Map() };
		let mode: "description" | "param" | "return" = "description";
		let currentParamName: string | undefined;
		for (const line of raw) {
			const tagMatch = line.match(/^@(param|return)\s+(.*)$/);
			if (tagMatch) {
				mode = tagMatch[1] === "param" ? "param" : "return";
				if (mode === "param") {
					const paramMatch = tagMatch[2].match(/^(\w+)\s*-?\s*(.*)$/);
					currentParamName = paramMatch?.[1];
					const paramDescription = paramMatch?.[2].trim() ?? "";
					if (currentParamName === "params") {
						info.paramSummary = paramDescription;
					} else if (currentParamName) {
						info.paramDocs.set(currentParamName, paramDescription);
					}
				} else {
					info.returns = tagMatch[2].trim();
					currentParamName = undefined;
				}
				continue;
			}
			if (mode === "description") {
				info.description = info.description
					? `${info.description} ${line}`
					: line;
			} else if (
				mode === "param" &&
				currentParamName &&
				currentParamName !== "params"
			) {
				info.paramDocs.set(
					currentParamName,
					`${info.paramDocs.get(currentParamName) ?? ""} ${line}`.trim(),
				);
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
			this.log(
				`mapApexType primitive=${trimmed} mapped=${PRIMITIVE_TYPE_MAP[trimmed]}`,
			);
			return PRIMITIVE_TYPE_MAP[trimmed];
		}
		const arrayMatch = trimmed.match(/^(?:List|Set)<(.+)>$/);
		if (arrayMatch) {
			this.log(`mapApexType collection=${trimmed}`);
			return `${this.mapApexType(arrayMatch[1])}[]`;
		}
		const mapMatch = trimmed.match(/^Map<(.+),\s*(.+)>$/);
		if (mapMatch) {
			this.log(`mapApexType map=${trimmed}`);
			return `Record<string, ${this.mapApexType(mapMatch[2])}>`;
		}
		if (trimmed.endsWith("[]")) {
			this.log(`mapApexType array=${trimmed}`);
			return `${this.mapApexType(trimmed.slice(0, -2))}[]`;
		}
		this.log(`mapApexType fallback=${trimmed}`);
		return "unknown";
	}

	private getVirtualFilePath(className: string, methodName: string) {
		return path.join(
			this.workspaceRoot,
			".tatzeroko",
			"virtual",
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
			const result = uri.startsWith("file://")
				? decodeURIComponent(new URL(uri).pathname)
				: uri;
			this.log(`uriToPath uri=${uri} path=${result}`);
			return result;
		} catch {
			this.log(`uriToPath failed uri=${uri}`);
			return undefined;
		}
	}

	private log(message: string) {
		console.log(`[tatzeroko-language-server] ${message}`);
		this.connection.sendNotification("tatzeroko/log", {
			message: `[tatzeroko] ${message}`,
		});
	}
}
