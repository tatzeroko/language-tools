import * as assert from "node:assert";

import { pickTsProbeFile } from "../transport";

suite("transport", () => {
	test("prefers an open TypeScript file in the workspace", () => {
		const workspace = "/workspace";
		const docs = [
			{ uri: { scheme: "file", fsPath: "/workspace/README.md" } },
			{ uri: { scheme: "file", fsPath: "/workspace/src/index.ts" } },
			{ uri: { scheme: "untitled", fsPath: "/workspace/src/other.ts" } },
		];

		const probe = pickTsProbeFile(workspace, docs);

		assert.strictEqual(probe?.uri.fsPath, "/workspace/src/index.ts");
	});

	test("ignores files outside the workspace", () => {
		const workspace = "/workspace";
		const docs = [
			{ uri: { scheme: "file", fsPath: "/other/src/index.ts" } },
			{ uri: { scheme: "file", fsPath: "/workspace/docs/readme.md" } },
		];

		const probe = pickTsProbeFile(workspace, docs);

		assert.strictEqual(probe, undefined);
	});
});
