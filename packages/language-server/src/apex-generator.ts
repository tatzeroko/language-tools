import * as path from "node:path";

import { renderApexDocBlock } from "./apex-doc";

type TreeSitterNode = {
	type: string;
	text: string;
	namedChildren: TreeSitterNode[];
	previousNamedSibling?: TreeSitterNode;
	descendantsOfType(type: string): TreeSitterNode[];
};

type TreeSitterTree = {
	rootNode: TreeSitterNode;
};

type TreeSitterParser = {
	setLanguage(language: unknown): void;
	parse(content: string): TreeSitterTree;
};

type TreeSitterParserCtor = new () => TreeSitterParser;

type ApexParser = TreeSitterParser | null;

let cachedParser: ApexParser | undefined;

/** Generated virtual Apex declaration file. */
export type ApexVirtualFile = {
	readonly path: string;
	readonly content: string;
	readonly moduleName: string;
};

type ApexGenerationOptions = {
	readonly placeholder?: boolean;
};

type ApexMethod = {
	name: string;
	returnType: string;
	params: Array<{ name: string; type: string }>;
	docComment?: string;
};

type ApexClass = {
	name: string;
	methods: ApexMethod[];
};

const PRIMITIVE_TYPE_MAP: Record<string, string> = {
	String: "string",
	Integer: "number",
	Long: "number",
	Double: "number",
	Decimal: "number",
	Boolean: "boolean",
	Id: "string",
	Date: "string",
	Datetime: "string",
	Time: "string",
	Blob: "string",
	Object: "unknown",
	void: "void",
};

/**
 * Generates virtual Apex declaration files for the given workspace sources.
 */
export function generateApexVirtualFiles(
	workspaceRoot: string,
	sources: ReadonlyArray<readonly [string, string]>,
	options: ApexGenerationOptions = {},
) {
	const placeholder = options.placeholder ?? false;
	const parser = getApexParser();
	const files: ApexVirtualFile[] = [];

	for (const [, content] of sources) {
		for (const apexClass of parseApexFile(parser, content)) {
			for (const method of apexClass.methods) {
				const moduleName = `@salesforce/apex/${apexClass.name}.${method.name}`;
				const virtualPath = getVirtualFilePath(
					workspaceRoot,
					apexClass.name,
					method.name,
				);
				files.push({
					path: virtualPath,
					content: renderModuleWithMode(method, placeholder),
					moduleName,
				});
			}
		}
	}

	return files;
}

function getApexParser() {
	if (cachedParser !== undefined) {
		return cachedParser;
	}

	try {
		// Native Tree-sitter bindings loaded lazily so startup never fails here.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const Parser = require("tree-sitter") as TreeSitterParserCtor;
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const TsSfApex = require("tree-sitter-sfapex") as { apex: unknown };
		const parser = new Parser();
		parser.setLanguage(TsSfApex.apex);
		cachedParser = parser;
	} catch {
		cachedParser = null;
	}

	return cachedParser;
}

function parseApexFile(parser: ApexParser, content: string) {
	if (!parser) {
		return parseApexFileFallback(content);
	}
	const tree = parser.parse(content);
	const classes: ApexClass[] = [];

	for (const classNode of tree.rootNode.descendantsOfType(
		"class_declaration",
	)) {
		const className = extractClassName(classNode);
		if (!className) continue;

		const methods: ApexMethod[] = [];
		for (const methodNode of classNode.descendantsOfType(
			"method_declaration",
		)) {
			if (!hasAuraEnabledAnnotation(methodNode)) continue;
			const methodName = extractMethodName(methodNode);
			if (!methodName) continue;
			methods.push({
				name: methodName,
				params: extractParameters(methodNode),
				returnType: extractReturnType(methodNode),
				docComment: extractDocComment(methodNode),
			});
		}

		if (methods.length > 0) {
			classes.push({ name: className, methods });
		}
	}

	return classes;
}

function parseApexFileFallback(content: string) {
	const classes: ApexClass[] = [];
	const classMatch = content.match(/class\s+(\w+)\s*\{/);
	if (!classMatch) {
		return classes;
	}

	const className = classMatch[1];
	const methods: ApexMethod[] = [];
	const methodPattern =
		/@AuraEnabled[\s\S]*?(?:public|global)\s+static\s+([^\s]+)\s+(\w+)\s*\(([^)]*)\)/g;
	for (const match of content.matchAll(methodPattern)) {
		const returnType = match[1] ?? "void";
		const methodName = match[2];
		const params = (match[3] ?? "")
			.split(",")
			.map((chunk) => chunk.trim())
			.filter(Boolean)
			.map((param, index) => {
				const pieces = param.split(/\s+/).filter(Boolean);
				return {
					name: pieces.length >= 2 ? pieces[1] : `arg${index}`,
					type: pieces.length >= 2 ? pieces[0] : "unknown",
				};
			});
		methods.push({
			name: methodName,
			params,
			returnType,
			docComment: undefined,
		});
	}

	if (methods.length) {
		classes.push({ name: className, methods });
	}

	return classes;
}

function extractClassName(classNode: TreeSitterNode) {
	const identifier = classNode.namedChildren.find(
		(child) => child.type === "identifier",
	);
	return identifier?.text?.trim();
}

function hasAuraEnabledAnnotation(methodNode: TreeSitterNode) {
	const modifiers = methodNode.namedChildren.find(
		(child) => child.type === "modifiers",
	);
	if (!modifiers) return false;
	return modifiers.namedChildren.some((child) => {
		if (child.type !== "annotation") return false;
		const identifier = child.namedChildren.find(
			(grand) => grand.type === "identifier",
		);
		return identifier?.text === "AuraEnabled";
	});
}

function extractMethodName(methodNode: TreeSitterNode) {
	const identifier = methodNode.namedChildren.find(
		(child) => child.type === "identifier",
	);
	return identifier?.text;
}

function extractReturnType(methodNode: TreeSitterNode) {
	const candidate = methodNode.namedChildren.find((child) => {
		return (
			child.type !== "modifiers" &&
			child.type !== "identifier" &&
			child.type !== "formal_parameters" &&
			child.type !== "block"
		);
	});
	return candidate?.text?.trim() ?? "void";
}

function extractParameters(methodNode: TreeSitterNode) {
	const paramsNode = methodNode.namedChildren.find(
		(child) => child.type === "formal_parameters",
	);
	if (!paramsNode) return [];

	return paramsNode.namedChildren
		.filter((child) => child.type === "formal_parameter")
		.map((param, index) => {
			const nameNode = param.namedChildren.find(
				(child) => child.type === "identifier",
			);
			const typeNode = param.namedChildren.find(
				(child) => child.type !== "modifiers" && child.type !== "identifier",
			);
			return {
				name: nameNode?.text?.trim() ?? `arg${index}`,
				type: typeNode?.text?.trim() ?? "unknown",
			};
		});
}

function extractDocComment(methodNode: TreeSitterNode) {
	const sibling = methodNode.previousNamedSibling;
	return sibling?.type === "block_comment" ? sibling.text : undefined;
}

function renderModule(method: ApexMethod) {
	const docBlock = renderApexDocBlock(method.docComment);
	const returnType = mapApexType(method.returnType);
	const paramsType = !method.params.length
		? "Record<string, unknown>"
		: `{
${method.params.map((param) => `\t${param.name}: ${mapApexType(param.type)};`).join("\n")}
}`;
	return `${docBlock}export default function ${method.name}(params: ${paramsType}): Promise<${returnType}>;`;
}

function renderModuleWithMode(method: ApexMethod, placeholder: boolean) {
	if (!placeholder) {
		return renderModule(method);
	}

	const docBlock = renderApexDocBlock(method.docComment);
	return `${docBlock}export default function ${method.name}(params: unknown): Promise<unknown>;`;
}

function mapApexType(type: string): string {
	const trimmed = type.trim();
	if (!trimmed) return "unknown";
	if (PRIMITIVE_TYPE_MAP[trimmed]) {
		return PRIMITIVE_TYPE_MAP[trimmed];
	}
	const arrayMatch = trimmed.match(/^(?:List|Set)<(.+)>$/);
	if (arrayMatch) {
		return `${mapApexType(arrayMatch[1])}[]`;
	}
	const mapMatch = trimmed.match(/^Map<(.+),\s*(.+)>$/);
	if (mapMatch) {
		return `Record<string, ${mapApexType(mapMatch[2])}>`;
	}
	if (trimmed.endsWith("[]")) {
		return `${mapApexType(trimmed.slice(0, -2))}[]`;
	}
	return "unknown";
}

function getVirtualFilePath(
	workspaceRoot: string,
	className: string,
	methodName: string,
) {
	return path.join(
		workspaceRoot,
		".tatzeroko",
		"virtual",
		"apex",
		`${className}.${methodName}.d.ts`,
	);
}
