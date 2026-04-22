import * as path from "node:path";

type ApexParser = any;

let cachedParser: ApexParser | null | undefined;

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
					content: renderModuleWithMode(apexClass.name, method, placeholder),
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
		const Parser = require("tree-sitter");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const TsSfApex = require("tree-sitter-sfapex");
		const parser = new Parser();
		parser.setLanguage(TsSfApex.apex);
		cachedParser = parser as ApexParser;
	} catch {
		cachedParser = null;
	}

	return cachedParser;
}

function parseApexFile(parser: ApexParser | null, content: string) {
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
			const returnType = extractReturnType(methodNode);
			const params = extractParameters(methodNode);
			const docComment = extractDocComment(methodNode);
			methods.push({ name: methodName, params, returnType, docComment });
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
				const type = pieces.length >= 2 ? pieces[0] : "unknown";
				const name = pieces.length >= 2 ? pieces[1] : `arg${index}`;
				return { name, type };
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

function extractClassName(classNode: {
	namedChildren: Array<{ type: string; text: string }>;
}) {
	const identifier = classNode.namedChildren.find(
		(child) => child.type === "identifier",
	);
	return identifier?.text?.trim();
}

function hasAuraEnabledAnnotation(methodNode: { namedChildren: Array<any> }) {
	const modifiers = methodNode.namedChildren.find(
		(child) => child.type === "modifiers",
	);
	if (!modifiers) return false;
	return modifiers.namedChildren?.some((child: any) => {
		if (child.type !== "annotation") return false;
		const identifier = child.namedChildren?.find(
			(grand: any) => grand.type === "identifier",
		);
		return identifier?.text === "AuraEnabled";
	});
}

function extractMethodName(methodNode: {
	namedChildren: Array<{ type: string; text: string }>;
}) {
	const identifier = methodNode.namedChildren.find(
		(child) => child.type === "identifier",
	);
	return identifier?.text;
}

function extractReturnType(methodNode: {
	namedChildren: Array<{ type: string; text: string }>;
}) {
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

function extractParameters(methodNode: { namedChildren: Array<any> }) {
	const paramsNode = methodNode.namedChildren.find(
		(child) => child.type === "formal_parameters",
	);
	if (!paramsNode) return [];

	return paramsNode.namedChildren
		.filter((child: any) => child.type === "formal_parameter")
		.map((param: any, index: number) => {
			const nameNode = param.namedChildren.find(
				(child: any) => child.type === "identifier",
			);
			const typeNode = param.namedChildren.find((child: any) => {
				return child.type !== "modifiers" && child.type !== "identifier";
			});
			return {
				name: nameNode?.text?.trim() ?? `arg${index}`,
				type: typeNode?.text?.trim() ?? "unknown",
			};
		});
}

function extractDocComment(methodNode: { previousNamedSibling?: any }) {
	const sibling = methodNode.previousNamedSibling;
	if (sibling?.type === "block_comment") {
		return sibling.text;
	}
	return undefined;
}

function renderModule(className: string, method: ApexMethod) {
	const docBlock = buildDocBlock(method.docComment);
	const returnType = mapApexType(method.returnType);
	const paramsType = !method.params.length
		? "Record<string, unknown>"
		: `{\n${method.params
				.map((param) => `\t${param.name}: ${mapApexType(param.type)};`)
				.join("\n")}\n}`;
	return `${docBlock}export default function ${method.name}(params: ${paramsType}): Promise<${returnType}>;`;
}

function renderModuleWithMode(
	className: string,
	method: ApexMethod,
	placeholder: boolean,
) {
	if (!placeholder) {
		return renderModule(className, method);
	}

	const docBlock = buildDocBlock(method.docComment);
	void className;
	return `${docBlock}export default function ${method.name}(params: unknown): Promise<unknown>;`;
}

function buildDocBlock(docComment?: string) {
	if (!docComment) {
		return "";
	}
	const info = parseDocComment(docComment);
	const lines = ["/**"];
	if (info.description) {
		for (const line of info.description.split(/\n+/)) {
			lines.push(` * ${line}`);
		}
	}
	lines.push(
		` * @param params - ${info.paramSummary ?? "The parameters for this call."}`,
	);
	for (const [name, description] of info.paramDocs) {
		lines.push(` * @param params.${name} - ${description}`);
	}
	if (info.returns) {
		lines.push(` * @return ${info.returns}`);
	}
	lines.push(" */\n");
	return `${lines.join("\n")}`;
}

function parseDocComment(comment: string) {
	const raw = comment
		.replace(/^\/\*\*/, "")
		.replace(/\*\/$/, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*\*\s?/, "").trim())
		.filter(Boolean);
	const info: {
		description?: string;
		paramSummary?: string;
		paramDocs: Map<string, string>;
		returns?: string;
	} = { paramDocs: new Map() };
	let mode: "description" | "param" | "return" = "description";
	let currentParamName: string | undefined;
	for (const line of raw) {
		const tagMatch = line.match(/^@(param|return)\s+(.*)$/);
		if (tagMatch) {
			mode = tagMatch[1] === "param" ? "param" : "return";
			if (mode === "param") {
				const paramMatch = tagMatch[2].match(/^(\w+)\s*-?\s*(.*)$/);
				currentParamName = paramMatch?.[1];
				const paramDescription = paramMatch?.[2].trim() ?? "";
				if (currentParamName === "params") {
					info.paramSummary = paramDescription;
				} else if (currentParamName) {
					info.paramDocs.set(currentParamName, paramDescription);
				}
			} else {
				info.returns = tagMatch[2].trim();
				currentParamName = undefined;
			}
			continue;
		}
		if (mode === "description") {
			info.description = info.description
				? `${info.description} ${line}`
				: line;
		} else if (
			mode === "param" &&
			currentParamName &&
			currentParamName !== "params"
		) {
			info.paramDocs.set(
				currentParamName,
				`${info.paramDocs.get(currentParamName) ?? ""} ${line}`.trim(),
			);
		} else if (mode === "return") {
			info.returns = info.returns ? `${info.returns} ${line}`.trim() : line;
		}
	}
	return info;
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

function sanitizeIdentifier(value: string) {
	return value.replace(/[^A-Za-z0-9_]/g, "");
}

function capitalize(value: string) {
	if (!value) return "";
	return value.charAt(0).toUpperCase() + value.slice(1);
}
