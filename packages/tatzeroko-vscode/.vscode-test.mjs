import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	files: "out/test/**/*.test.js",
	launchArgs: [path.join(packageRoot, "test-fixtures/apex-workspace")],
	workspaceFolder: path.join(packageRoot, "test-fixtures/apex-workspace"),
	mocha: {
		timeout: 30000,
	},
});
