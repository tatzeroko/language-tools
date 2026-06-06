import path from "node:path";
import type * as ts from "typescript/lib/tsserverlibrary";

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
