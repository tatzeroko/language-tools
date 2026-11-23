import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { discoverProjects } from "../src/discovery.ts";
import { encodeBatch, readOwnedWorkspaceFiles } from "../src/workspace-load.ts";

const ws = path.resolve(import.meta.dirname, "..", "fixtures", "p360-like");
const projects = discoverProjects(ws);
const must = <T>(v: T | undefined): T => {
	if (v === undefined) throw new Error("fixture project missing");
	return v;
};
const root = must(projects.find((p) => p.nestedRoots.length > 0));
const nested = must(projects.find((p) => p !== root));

describe("workspace-load", () => {
	it("never reads nested-project files for the root project", () => {
		const files = readOwnedWorkspaceFiles(root);
		expect(files.length).toBeGreaterThan(0);
		expect(files.some((f) => f.uri.includes(nested.root))).toBe(false);
	});

	it("tags nested files with the nested namespace", () => {
		const files = readOwnedWorkspaceFiles(nested);
		expect(
			files.every((f) => f.namespace === (nested.namespace || undefined)),
		).toBe(true);
	});

	it("encodes batches in the official zip + __metadata.json format", () => {
		const files = readOwnedWorkspaceFiles(root);
		const { compressedData } = encodeBatch(0, 1, files);
		const zip = unzipSync(Buffer.from(compressedData, "base64"));
		expect(Object.keys(zip)).toContain("__metadata.json");
		const meta = JSON.parse(new TextDecoder().decode(zip["__metadata.json"]));
		expect(meta.isLastBatch).toBe(true);
		expect(meta.fileMetadata).toHaveLength(files.length);
		expect(new TextDecoder().decode(zip[files[0].uri])).toBe(files[0].content);
	});
});
