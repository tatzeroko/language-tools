export function pickTsProbeFile(
	workspaceRoot: string,
	documents: ReadonlyArray<{ uri: { scheme: string; fsPath: string } }>,
) {
	const workspacePrefix = workspaceRoot.endsWith("/")
		? workspaceRoot
		: `${workspaceRoot}/`;
	return documents.find((candidate) => {
		return (
			candidate.uri.scheme === "file" &&
			(candidate.uri.fsPath === workspaceRoot ||
				candidate.uri.fsPath.startsWith(workspacePrefix)) &&
			/\.(ts|tsx|js|jsx)$/.test(candidate.uri.fsPath)
		);
	});
}

export async function findTsProbeFile(workspaceRoot: string) {
	const vscode = await import("vscode");
	console.log("[tatzeroko] findTsProbeFile start", workspaceRoot);
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const document = pickTsProbeFile(
			workspaceRoot,
			vscode.workspace.textDocuments,
		);
		if (document) {
			console.log("[tatzeroko] findTsProbeFile hit", document.uri.fsPath);
			return document.uri.fsPath;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	console.log("[tatzeroko] findTsProbeFile timeout", workspaceRoot);
	return undefined;
}
