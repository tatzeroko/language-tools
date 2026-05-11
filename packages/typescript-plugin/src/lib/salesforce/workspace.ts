import type * as ts from "typescript/lib/tsserverlibrary";
import ProjectContext from "../../projectContext";
import WorkspaceContext from "../../workspaceContext";
import { loadFile, unloadFile } from "../ts/file";
import type { ApexDefinitionFile } from "./apex";

export function applyWorkspaceApexFiles(
	typescript: typeof ts,
	definitionsByWorkspace: Map<string, ReadonlyArray<ApexDefinitionFile>>,
	workspace: string,
) {
	const wsCtx =
		WorkspaceContext.resolve(workspace) ??
		WorkspaceContext.getOrCreate(workspace);
	const canonical = wsCtx.workspace;

	const definitions = definitionsByWorkspace.get(canonical) ?? [];
	const nextPaths = new Set(definitions.map((definition) => definition.path));
	const oldPaths = new Set(wsCtx.vfs.list());

	for (const oldPath of oldPaths) {
		if (!nextPaths.has(oldPath)) {
			wsCtx.vfs.delete(oldPath);
		}
	}
	for (const definition of definitions) {
		wsCtx.vfs.set(definition.path, definition.content);
	}

	ProjectContext.forEachMatchingWorkspace(canonical, (_, ctx) => {
		for (const oldPath of oldPaths) {
			if (!nextPaths.has(oldPath)) {
				unloadFile(typescript, ctx.project, oldPath);
			}
		}
		for (const definition of definitions) {
			loadFile(typescript, ctx.project, definition.path, definition.content);
		}
		ctx.project.updateGraph();
	});
}
