import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOfficialJorjeJar } from "../src/jorje-locator.ts";

const tmp: string[] = [];
afterEach(() => {
	for (const t of tmp.splice(0)) rmSync(t, { recursive: true, force: true });
});

function ext(base: string, name: string, withJar: boolean) {
	const dir = path.join(base, name, "out");
	mkdirSync(dir, { recursive: true });
	if (withJar) writeFileSync(path.join(dir, "apex-jorje-lsp.jar"), "x");
	return path.join(dir, "apex-jorje-lsp.jar");
}

describe("findOfficialJorjeJar", () => {
	it("picks the newest installed official extension that ships a JAR", () => {
		const base = mkdtempSync(path.join(os.tmpdir(), "jl-"));
		tmp.push(base);
		ext(base, "salesforce.salesforcedx-vscode-apex-62.1.0", true);
		const newest = ext(
			base,
			"salesforce.salesforcedx-vscode-apex-64.10.0",
			true,
		);
		ext(base, "salesforce.salesforcedx-vscode-apex-65.0.0", false);
		ext(base, "other.thing-99.0.0", true);
		expect(findOfficialJorjeJar({ extensionDirs: [base] })).toBe(newest);
	});

	it("returns undefined when nothing is installed", () => {
		const base = mkdtempSync(path.join(os.tmpdir(), "jl-"));
		tmp.push(base);
		expect(findOfficialJorjeJar({ extensionDirs: [base] })).toBeUndefined();
	});
});
