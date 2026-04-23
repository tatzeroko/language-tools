import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

const fixtureRoot = path.resolve(process.cwd(), "test-fixtures/apex-workspace");
const documentPath = path.join(
	fixtureRoot,
	"force-app",
	"main",
	"default",
	"lwc",
	"contactViewer",
	"contactViewer.js",
);
const documentUri = vscode.Uri.file(documentPath);

async function activateExtension() {
	const extension = vscode.extensions.getExtension(
		"tatzeroko.tatzeroko-vscode",
	);
	assert.ok(extension, "expected Tatzeroko extension to be installed");
	await extension.activate();
	await vscode.extensions
		.getExtension("vscode.typescript-language-features")
		?.activate();
	return extension;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15000) {
	const started = Date.now();
	let lastValue: T | undefined;
	while (Date.now() - started < timeoutMs) {
		lastValue = await fn();
		if (lastValue !== undefined) {
			return lastValue;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return lastValue;
}

function hoverText(hover: vscode.Hover | undefined) {
	if (!hover) {
		return "";
	}
	return hover.contents
		.map((content) => {
			if (typeof content === "string") {
				return content;
			}
			if ("value" in content) {
				return content.value;
			}
			return "";
		})
		.join("\n");
}

suite("Apex virtual types integration", () => {
	test("exposes generated Apex typings in hover", async () => {
		await activateExtension();
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(workspace, "expected a workspace folder to be open");
		assert.strictEqual(workspace, fixtureRoot);
		assert.ok(fs.existsSync(documentPath), "fixture document is missing");
		const document = await vscode.workspace.openTextDocument(documentUri);
		await vscode.window.showTextDocument(document);
		const marker = "search({";
		const markerIndex = document.getText().indexOf(marker);
		assert.ok(markerIndex >= 0, "expected search call in fixture document");
		const position = document.positionAt(markerIndex);
		const hover = await waitFor(async () => {
			const hovers = (await vscode.commands.executeCommand(
				"vscode.executeHoverProvider",
				document.uri,
				position,
			)) as vscode.Hover[] | undefined;
			return hovers?.find((item) =>
				hoverText(item).includes("ContactControllerSearchParams"),
			);
		});
		assert.ok(hover, "expected hover with generated Apex params type");
		const text = hoverText(hover);
		assert.match(text, /ContactControllerSearchParams/);
		assert.match(text, /Finds contacts matching the query\./);
		const diagnostics = await waitFor(async () => {
			const items = vscode.languages.getDiagnostics(document.uri);
			return items.some(
				(item) =>
					item.code === 2307 &&
					item.message.includes("@salesforce/apex/ContactController.search"),
			)
				? undefined
				: true;
		}, 15000);
		assert.strictEqual(
			diagnostics,
			true,
			"expected resolved Apex module to clear TS2307",
		);
	});
});
