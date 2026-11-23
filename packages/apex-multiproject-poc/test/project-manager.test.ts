import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { DxProject } from "../src/discovery.ts";
import type { ApexEngine } from "../src/engine.ts";
import { ProjectManager } from "../src/project-manager.ts";

const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const rootFile = pathToFileURL(
	path.join(ws, "force-app/main/default/classes/RootThing.cls"),
).toString();
const nestedFile = pathToFileURL(
	path.join(
		ws,
		"packages/nested/force-app/main/default/classes/AccountService.cls",
	),
).toString();

function fakeFactory() {
	const made: FakeEngine[] = [];
	class FakeEngine {
		readonly kind = "typescript" as const;
		pid = 1;
		alive = false;
		startupMs = 0;
		docs = new Map<string, string>();
		starts = 0;
		exitCb: (() => void) | undefined;
		readonly project: DxProject;
		constructor(project: DxProject) {
			this.project = project;
		}
		async start() {
			this.alive = true;
			this.starts++;
		}
		async waitReady() {
			return { ms: 0, ready: true };
		}
		openDocument(uri: string, text: string) {
			this.docs.set(uri, text);
		}
		changeDocument(uri: string, text: string) {
			this.docs.set(uri, text);
		}
		saveDocument() {}
		closeDocument(uri: string) {
			this.docs.delete(uri);
		}
		async completion(uri: string) {
			return [
				{ label: `${path.basename(this.project.root)}:${this.docs.has(uri)}` },
			];
		}
		async definition() {
			return [];
		}
		async diagnostics() {
			return [];
		}
		async restart() {
			const keep = new Map(this.docs);
			this.starts++;
			this.docs = keep;
			return 1;
		}
		async stop() {
			this.alive = false;
		}
		onExit(cb: () => void) {
			this.exitCb = cb;
		}
	}
	const fn = ((_kind: string, project: DxProject) => {
		const e = new FakeEngine(project);
		made.push(e);
		return e as unknown as ApexEngine;
	}) as never;
	return { fn, made };
}

describe("ProjectManager", () => {
	it("nested scope leaves the root project to the Salesforce extension", async () => {
		const { fn, made } = fakeFactory();
		const m = new ProjectManager({
			workspaceRoot: ws,
			engine: "typescript",
			config: {},
			createEngineFn: fn,
		});
		await m.openDocument(rootFile, "class RootThing {}");
		expect(made).toHaveLength(0);
		expect(await m.completion(rootFile, { line: 0, character: 0 })).toEqual([]);
		await m.openDocument(nestedFile, "class AccountService {}");
		expect(made).toHaveLength(1);
		expect(path.basename(made[0]?.project.root ?? "")).toBe("nested");
		await m.dispose();
	});

	it("scope all serves each project from its own engine and reuses it", async () => {
		const { fn, made } = fakeFactory();
		const m = new ProjectManager({
			workspaceRoot: ws,
			engine: "typescript",
			scope: "all",
			config: {},
			createEngineFn: fn,
		});
		await m.openDocument(rootFile, "a");
		await m.openDocument(nestedFile, "b");
		await m.completion(nestedFile, { line: 0, character: 0 });
		expect(made).toHaveLength(2);
		expect(made.map((e) => [...e.docs.keys()])).toEqual([
			[rootFile],
			[nestedFile],
		]);
		await m.dispose();
	});

	it("restart of one project keeps unsaved text and leaves the other engine untouched", async () => {
		const { fn, made } = fakeFactory();
		const m = new ProjectManager({
			workspaceRoot: ws,
			engine: "typescript",
			scope: "all",
			config: {},
			createEngineFn: fn,
		});
		await m.openDocument(rootFile, "a");
		await m.openDocument(nestedFile, "b");
		await m.changeDocument(nestedFile, "b-edited");
		const nested = made.find((e) => e.project.root.endsWith("nested"));
		await m.restartProject(nested?.project.root ?? "");
		expect(nested?.starts).toBe(2);
		expect(nested?.docs.get(nestedFile)).toBe("b-edited");
		expect(made.find((e) => !e.project.root.endsWith("nested"))?.starts).toBe(
			1,
		);
		await m.dispose();
	});

	it("a crashed engine is replaced and replayed with only its own documents", async () => {
		const { fn, made } = fakeFactory();
		const m = new ProjectManager({
			workspaceRoot: ws,
			engine: "typescript",
			scope: "all",
			config: {},
			createEngineFn: fn,
		});
		await m.openDocument(rootFile, "a");
		await m.openDocument(nestedFile, "b");
		await m.changeDocument(nestedFile, "b2");
		const crashed = made.find((e) => e.project.root.endsWith("nested"));
		if (crashed) crashed.alive = false;
		const items = await m.completion(nestedFile, { line: 0, character: 0 });
		expect(made).toHaveLength(3);
		expect(made[2]?.docs.get(nestedFile)).toBe("b2");
		expect([...(made[2]?.docs.keys() ?? [])]).toEqual([nestedFile]);
		expect(items[0]?.label).toBe("nested:true");
		await m.dispose();
	});

	it("evicts the least recently used engine beyond maxActiveProjects", async () => {
		const { fn, made } = fakeFactory();
		const m = new ProjectManager({
			workspaceRoot: ws,
			engine: "typescript",
			scope: "all",
			maxActiveProjects: 1,
			config: {},
			createEngineFn: fn,
		});
		await m.openDocument(rootFile, "a");
		await m.openDocument(nestedFile, "b");
		expect(made.filter((e) => e.alive)).toHaveLength(1);
		await m.dispose();
	});
});

describe("ProjectManager status reporting", () => {
	it("reports starting -> ready, restarting -> ready and stopped per project", async () => {
		const { fn } = fakeFactory();
		const events: string[] = [];
		const m = new ProjectManager({
			workspaceRoot: ws,
			engine: "typescript",
			config: {},
			createEngineFn: fn,
			onStatus: (root, s) => events.push(`${path.basename(root)}:${s}`),
		});
		await m.openDocument(nestedFile, "class A {}");
		await m.restartProject(path.join(ws, "packages/nested"));
		await m.dispose();
		expect(events).toEqual([
			"nested:starting",
			"nested:ready",
			"nested:restarting",
			"nested:ready",
			"nested:stopped",
		]);
		expect(m.states()).toEqual([
			{ root: path.join(ws, "packages/nested"), state: "stopped" },
		]);
	});
});
