import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProjects, listOwnedFiles, ownerOf } from "../src/discovery.ts";

function makeWorkspace() {
	const root = mkdtempSync(path.join(tmpdir(), "dx-"));
	const write = (rel: string, content = "{}") => {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), content);
	};
	const manifest = (ns: string) =>
		JSON.stringify({
			namespace: ns,
			packageDirectories: [{ path: "force-app" }],
		});
	write("sfdx-project.json", manifest("root"));
	write("force-app/A.cls", "");
	write("packages/child/sfdx-project.json", manifest("child"));
	write("packages/child/force-app/B.cls", "");
	write("node_modules/x/sfdx-project.json", manifest("ignored"));
	return root;
}

describe("discovery", () => {
	const ws = makeWorkspace();
	const projects = discoverProjects(ws);

	it("finds root and nested projects, skipping node_modules", () => {
		expect(projects.map((p) => p.namespace).sort()).toEqual(["child", "root"]);
	});

	it("resolves the deepest owner", () => {
		expect(
			ownerOf(path.join(ws, "packages/child/force-app/B.cls"), projects)
				?.namespace,
		).toBe("child");
		expect(ownerOf(path.join(ws, "force-app/A.cls"), projects)?.namespace).toBe(
			"root",
		);
		expect(ownerOf("/elsewhere/C.cls", projects)).toBeUndefined();
	});

	it("does not treat sibling-prefix paths as inside", () => {
		expect(ownerOf(`${ws}-other/force-app/A.cls`, projects)).toBeUndefined();
	});

	it("excludes nested project files from the parent", () => {
		const root = projects.find((p) => p.namespace === "root");
		if (!root) throw new Error("root project not discovered");
		expect(listOwnedFiles(root).map((f) => path.basename(f))).toEqual([
			"A.cls",
		]);
		const child = projects.find((p) => p.namespace === "child");
		if (!child) throw new Error("child project not discovered");
		expect(listOwnedFiles(child).map((f) => path.basename(f))).toEqual([
			"B.cls",
		]);
	});
});
