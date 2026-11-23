import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DxProject, discoverProjects, ownerOf } from "./discovery.ts";
import {
	type ApexEngine,
	createEngine,
	type EngineCompletion,
	type EngineConfig,
	type EngineLocation,
	type EnginePosition,
} from "./engine.ts";

export type ManagerOptions = {
	workspaceRoot: string;
	engine: "typescript" | "jorje";
	config: EngineConfig;
	/** Project roots (relative to workspaceRoot) this manager serves; "." is the root project. Default: nested only. */
	scope?: "nested" | "all";
	maxActiveProjects?: number;
	createEngineFn?: typeof createEngine;
	log?: (msg: string) => void;
	/** Called whenever a project's engine state changes. */
	onStatus?: (root: string, state: ProjectState) => void;
};

export type ProjectState =
	| "starting"
	| "ready"
	| "restarting"
	| "failed"
	| "stopped";

type Entry = { engine: ApexEngine; ready: Promise<void>; lastUsed: number };

/**
 * Maps a document to its owning DX project and keeps at most one engine per project.
 * A document is only ever sent to the engine of the project that owns it.
 */
export class ProjectManager {
	private projects: DxProject[];
	private readonly engines = new Map<string, Entry>();
	private readonly docs = new Map<string, { text: string; project: string }>();
	private readonly log: (msg: string) => void;
	private readonly make: typeof createEngine;

	private readonly opts: ManagerOptions;
	private readonly state = new Map<string, ProjectState>();

	constructor(opts: ManagerOptions) {
		this.opts = opts;
		this.projects = discoverProjects(opts.workspaceRoot);
		this.log = opts.log ?? (() => {});
		this.make = opts.createEngineFn ?? createEngine;
	}

	listProjects() {
		return this.projects;
	}

	rediscover() {
		this.projects = discoverProjects(this.opts.workspaceRoot);
		return this.projects;
	}

	/** The project this manager serves for a file URI, or undefined (not Apex-owned / out of scope). */
	ownerOfUri(uri: string): DxProject | undefined {
		if (!uri.startsWith("file:")) return undefined;
		const owner = ownerOf(fileURLToPath(uri), this.projects);
		if (!owner) return undefined;
		const isRoot =
			path.resolve(owner.root) === path.resolve(this.opts.workspaceRoot);
		if ((this.opts.scope ?? "nested") === "nested" && isRoot) return undefined;
		return owner;
	}

	private setState(root: string, s: ProjectState) {
		this.state.set(root, s);
		this.opts.onStatus?.(root, s);
	}

	states(): Array<{ root: string; state: ProjectState }> {
		return [...this.state.entries()].map(([root, state]) => ({ root, state }));
	}

	activeProjects() {
		return [...this.engines.entries()]
			.filter(([, e]) => e.engine.alive)
			.map(([root]) => root);
	}

	private async engineFor(project: DxProject): Promise<ApexEngine> {
		let entry = this.engines.get(project.root);
		if (entry && !entry.engine.alive) {
			this.engines.delete(project.root);
			entry = undefined;
		}
		if (!entry) {
			await this.evictIfNeeded(project.root);
			const engine = this.make(this.opts.engine, project, this.opts.config);
			engine.onExit(() => {
				this.log(`engine exited: ${project.root}`);
				if (
					this.engines.get(project.root)?.engine === engine &&
					this.state.get(project.root) !== "restarting"
				)
					this.setState(project.root, "stopped");
			});
			this.setState(project.root, "starting");
			const ready = (async () => {
				try {
					await engine.start();
					await engine.waitReady();
				} catch (e) {
					this.setState(project.root, "failed");
					this.engines.delete(project.root);
					await engine.stop().catch(() => {});
					throw e;
				}
				// Replay documents of this project only, including unsaved text.
				for (const [uri, d] of this.docs)
					if (d.project === project.root) engine.openDocument(uri, d.text);
				this.setState(project.root, "ready");
			})();
			entry = { engine, ready, lastUsed: Date.now() };
			this.engines.set(project.root, entry);
		}
		entry.lastUsed = Date.now();
		await entry.ready;
		return entry.engine;
	}

	private async evictIfNeeded(keep: string) {
		const max = this.opts.maxActiveProjects ?? 4;
		const live = [...this.engines.entries()].filter(([r]) => r !== keep);
		if (live.length < max) return;
		live.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const [root, victim] = live[0] as [string, Entry];
		this.log(`evicting idle engine ${root}`);
		this.engines.delete(root);
		await victim.engine.stop();
		this.setState(root, "stopped");
	}

	async openDocument(uri: string, text: string) {
		const owner = this.ownerOfUri(uri);
		if (!owner) return;
		const known = this.docs.has(uri);
		this.docs.set(uri, { text, project: owner.root });
		const entry = this.engines.get(owner.root);
		if (!known && entry?.engine.alive) {
			await entry.ready;
			entry.engine.openDocument(uri, text);
		} else if (!entry || !entry.engine.alive) await this.engineFor(owner);
	}

	async changeDocument(uri: string, text: string) {
		const d = this.docs.get(uri);
		if (!d) return this.openDocument(uri, text);
		d.text = text;
		const entry = this.engines.get(d.project);
		if (entry?.engine.alive) {
			await entry.ready;
			entry.engine.changeDocument(uri, text);
		}
	}

	async saveDocument(uri: string) {
		const d = this.docs.get(uri);
		const entry = d && this.engines.get(d.project);
		if (entry?.engine.alive) entry.engine.saveDocument(uri);
	}

	async closeDocument(uri: string) {
		const d = this.docs.get(uri);
		if (!d) return;
		this.docs.delete(uri);
		const entry = this.engines.get(d.project);
		if (entry?.engine.alive) entry.engine.closeDocument(uri);
	}

	private async withEngine<T>(
		uri: string,
		fn: (e: ApexEngine) => Promise<T>,
		empty: T,
	): Promise<T> {
		const owner = this.ownerOfUri(uri);
		if (!owner) return empty;
		const doc = this.docs.get(uri);
		if (!doc) return empty;
		return fn(await this.engineFor(owner));
	}

	completion(uri: string, p: EnginePosition): Promise<EngineCompletion[]> {
		return this.withEngine(uri, (e) => e.completion(uri, p), []);
	}

	definition(uri: string, p: EnginePosition): Promise<EngineLocation[]> {
		return this.withEngine(uri, (e) => e.definition(uri, p), []);
	}

	diagnostics(uri: string): Promise<string[]> {
		return this.withEngine(uri, (e) => e.diagnostics(uri), []);
	}

	/** Restarts one project's engine; other engines are untouched. Its open documents are replayed. */
	async restartProject(root: string) {
		const entry = this.engines.get(root);
		if (!entry) return;
		await entry.ready;
		this.setState(root, "restarting");
		try {
			await entry.engine.restart();
			this.setState(root, "ready");
		} catch (e) {
			this.setState(root, "failed");
			throw e;
		}
	}

	async dispose() {
		const all = [...this.engines.values()];
		for (const r of this.engines.keys()) this.setState(r, "stopped");
		this.engines.clear();
		await Promise.all(all.map((e) => e.engine.stop().catch(() => {})));
	}
}
