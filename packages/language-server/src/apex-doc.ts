export type ApexDocInfo = {
	description?: string;
	paramSummary?: string;
	paramDocs: Map<string, string>;
	returns?: string;
};

export function renderApexDocBlock(docComment?: string) {
	if (!docComment) {
		return "";
	}
	const info = parseApexDocComment(docComment);
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

export function parseApexDocComment(comment: string): ApexDocInfo {
	const raw = comment
		.replace(/^\/\*\*/, "")
		.replace(/\*\/$/, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*\*\s?/, "").trim())
		.filter(Boolean);
	const info: ApexDocInfo = { paramDocs: new Map() };
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
