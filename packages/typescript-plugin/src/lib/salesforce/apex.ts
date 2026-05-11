import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";
import ProjectContext from "../../projectContext";
import WorkspaceContext from "../../workspaceContext";
import { getProjectRootPath } from "../ts";

export type ApexDefinitionFile = {
	readonly path: string;
	readonly content: string;
	readonly moduleName: string;
};

export type ApexUpdateRequest = {
	readonly workspace?: string;
	readonly files?: ReadonlyArray<ApexDefinitionFile>;
};

export function resolveApexModulePath(
	typescript: typeof ts,
	workspace: string,
	moduleName: string,
) {
	if (!moduleName.startsWith("@salesforce/apex/")) {
		return undefined;
	}
	const resolved = typescript.server.toNormalizedPath(
		path.join(
			workspace,
			".tatzeroko",
			"virtual",
			"apex",
			`${moduleName.slice("@salesforce/apex/".length)}.d.ts`,
		),
	);
	return resolved;
}

export function isApexUpdateRequest(
	value: unknown,
): value is ApexUpdateRequest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ApexUpdateRequest;
	return (
		(candidate.workspace === undefined ||
			typeof candidate.workspace === "string") &&
		(candidate.files === undefined || Array.isArray(candidate.files))
	);
}

export function buildApexStateSnapshot(
	typescript: typeof ts,
	apexDefinitionsByWorkspace: ReadonlyMap<
		string,
		ReadonlyArray<ApexDefinitionFile>
	>,
	workspace?: string,
) {
	type ContextEntry = {
		workspace: string;
		project: string;
		projectRootPath: string | null;
		vfs: string[];
		openFiles: string[];
		contains: Array<{
			path: string;
			containsFile: boolean;
			scriptInfo: boolean;
		}>;
	};
	const contexts: ContextEntry[] = [];
	const visitCanonicalWorkspace = (ws: string) => {
		const wsCtx = WorkspaceContext.resolve(ws) ?? WorkspaceContext.get(ws);
		const vfsFiles = wsCtx?.vfs.list() ?? [];
		const canonical = wsCtx?.workspace ?? ws;
		ProjectContext.forEachMatchingWorkspace(canonical, (_, ctx) => {
			contexts.push({
				workspace: canonical,
				project: ctx.project.getCurrentDirectory(),
				projectRootPath: getProjectRootPath(ctx.project),
				vfs: vfsFiles,
				openFiles: Array.from(ctx.project.projectService.openFiles.keys()),
				contains: vfsFiles.map((file) => {
					const normalizedFile = typescript.server.toNormalizedPath(file);
					return {
						path: normalizedFile,
						containsFile: ctx.project.containsFile(normalizedFile),
						scriptInfo:
							!!ctx.project.projectService.getScriptInfo(normalizedFile),
					};
				}),
			});
		});
	};
	if (workspace) {
		visitCanonicalWorkspace(workspace);
	} else {
		for (const ws of apexDefinitionsByWorkspace.keys()) {
			visitCanonicalWorkspace(ws);
		}
	}
	return {
		success: true,
		workspace: workspace ?? null,
		definitions: Array.from(apexDefinitionsByWorkspace.entries()).map(
			([ws, files]) => ({
				workspace: ws,
				count: files.length,
				paths: files.map((file) => file.path),
			}),
		),
		contexts,
	};
}
