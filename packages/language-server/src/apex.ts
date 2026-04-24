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

/**
 * Tracks Apex source files and publishes generated virtual typings to tsserver.
 */
export class ApexVirtualTypeService {
	private readonly apexSources = new Map<string, string>();
	private readonly definitions = new Map<string, ApexVirtualFile>();
	private workerClient?: ApexWorkerClient;
	private workspaceWatchers: fsSync.FSWatcher[] = [];
	private workspaceRefreshTimer?: ReturnType<typeof setTimeout>;
	private generationTimer?: ReturnType<typeof setTimeout>;
	private generationTicket = 0;
	private workspaceRevision = 0;
	private workspaceWatcherMode: "recursive" | "directories" | "none" = "none";
	private disposed = false;

	constructor(
		private readonly connection: Pick<Connection, "sendNotification">,
		private readonly workspaceRoot: string,
		private readonly notifyTsServer: (
			payload: ApexTypesPayload,
		) => Promise<unknown>,
	) {}

	async initialize() {
		if (this.disposed) return;
		this.workerClient = new ApexWorkerClient(this.workspaceRoot);
		await this.startWorkspaceWatcher();
		void this.refreshFromWorkspace();
	}

	dispose() {
		this.disposed = true;
		if (this.workspaceRefreshTimer) {
			clearTimeout(this.workspaceRefreshTimer);
			this.workspaceRefreshTimer = undefined;
		}
		if (this.generationTimer) {
			clearTimeout(this.generationTimer);
			this.generationTimer = undefined;
		}
		this.closeWorkspaceWatchers();
		this.workerClient?.dispose();
		this.workerClient = undefined;
	}

	async handleWatchedFiles(params: DidChangeWatchedFilesParams) {
		if (params.changes.some((change) => change.uri.endsWith(".cls"))) {
			await this.refreshFromWorkspace();
			return;
		}
	}

	handleDocumentChanged(uri: string, text: string) {
		const filePath = this.uriToPath(uri);
		if (!filePath || !filePath.endsWith(".cls")) {
			return;
		}
		this.workspaceRevision += 1;
		this.apexSources.set(filePath, text);
		void this.scheduleGeneration();
	}

	handleDocumentSaved(uri: string, text: string) {
		const filePath = this.uriToPath(uri);
		if (!filePath || !filePath.endsWith(".cls")) {
			return;
		}
		this.workspaceRevision += 1;
		this.apexSources.set(filePath, text);
		void this.scheduleGeneration();
	}

	private async refreshFromWorkspace() {
		if (this.disposed) return;
		const revision = this.workspaceRevision;
		const apexFiles = await this.collectApexFiles(this.workspaceRoot);
		const nextSources = new Map<string, string>();
		for (const filePath of apexFiles) {
			try {
				nextSources.set(filePath, await fs.readFile(filePath, "utf8"));
			} catch {}
		}
		if (revision !== this.workspaceRevision) {
			return;
		}
		this.apexSources.clear();
		for (const [filePath, content] of nextSources) {
			this.apexSources.set(filePath, content);
		}
		await this.scheduleGeneration();
		if (this.workspaceWatcherMode === "directories") {
			await this.refreshDirectoryWatchers();
		}
	}

	private async startWorkspaceWatcher() {
		if (
			this.disposed ||
			this.workspaceWatchers.length ||
			this.workspaceWatcherMode !== "none"
		) {
			return;
		}

		try {
			const watcher = fsSync.watch(
				this.workspaceRoot,
				{ recursive: true },
				(_eventType, _filename) => {
					void this.scheduleWorkspaceRefresh();
				},
			);
			this.workspaceWatchers = [watcher];
			this.workspaceWatcherMode = "recursive";
			return;
		} catch (_error) {}

		this.workspaceWatcherMode = "directories";
		await this.refreshDirectoryWatchers();
	}

	private async refreshDirectoryWatchers() {
		if (this.disposed) return;
		this.closeWorkspaceWatchers();
		const directories = await this.collectApexDirectories(this.workspaceRoot);
		for (const directory of directories) {
			try {
				const watcher = fsSync.watch(directory, (_eventType, _filename) => {
					void this.scheduleWorkspaceRefresh();
				});
				watcher.on("error", (_error) => {});
				this.workspaceWatchers.push(watcher);
			} catch (_error) {}
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
		if (this.disposed) return;
		if (this.workspaceRefreshTimer) {
			clearTimeout(this.workspaceRefreshTimer);
		}
		this.workspaceRefreshTimer = setTimeout(() => {
			void this.refreshFromWorkspace();
		}, 50);
	}

	private async scheduleGeneration() {
		if (this.disposed) return;
		const ticket = ++this.generationTicket;
		if (this.generationTimer) {
			clearTimeout(this.generationTimer);
		}
		this.generationTimer = setTimeout(() => {
			void this.generateDefinitions(ticket);
		}, 0);
	}

	private async generateDefinitions(ticket: number) {
		if (this.disposed) return;
		const workerClient = this.workerClient;
		if (!workerClient) {
			return;
		}
		const sources = Array.from(this.apexSources.entries());

		const placeholderDefinitions = generateApexVirtualFiles(
			this.workspaceRoot,
			sources,
			{ placeholder: true },
		);
		const placeholderMap = new Map(
			placeholderDefinitions.map((definition) => [definition.path, definition]),
		);
		if (!this.definitionsAreEqual(this.definitions, placeholderMap)) {
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
			nextDefinitions.set(file.path, file);
		}

		if (ticket !== this.generationTicket) {
			return;
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

	private definitionsAreEqual(
		current: Map<string, ApexVirtualFile>,
		next: Map<string, ApexVirtualFile>,
	) {
		if (current.size !== next.size) return false;
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

	private async collectApexDirectories(root: string): Promise<string[]> {
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
		return directories;
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
