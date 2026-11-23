import { writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { findOfficialJorjeJar } from "../src/jorje-locator.ts";
import { ProjectManager, type ProjectState } from "../src/project-manager.ts";

const SECTION = "tatzeroko.experimental.apexMultiProject";

export async function activate(context: vscode.ExtensionContext) {
	const cfg = vscode.workspace.getConfiguration(SECTION);
	// Opt-in gate: when disabled no providers, listeners or servers are created.
	// Only an informational command is registered so the palette never errors.
	if (!cfg.get<boolean>("enabled", false)) {
		context.subscriptions.push(
			vscode.commands.registerCommand("tatzeroko.apexMultiProject.status", () =>
				vscode.window.showInformationMessage(
					`Tatzeroko experimental Apex multi-project is disabled. Set "${SECTION}.enabled": true and reload the window.`,
				),
			),
		);
		return undefined;
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) return undefined;

	const out = vscode.window.createOutputChannel(
		"Tatzeroko Apex (experimental)",
	);
	const log = (m: string) =>
		out.appendLine(`[${new Date().toISOString()}] ${m}`);
	const engine = cfg.get<"typescript" | "jorje">("engine", "typescript");
	const scope = cfg.get<"nested" | "all">("scope", "nested");

	const bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0,
	);
	bar.command = "tatzeroko.apexMultiProject.showLog";
	const rel = (r: string) => path.relative(root, r) || ".";
	const render = () => {
		const st = manager.states();
		if (!st.length) {
			bar.text = "$(circle-outline) Apex (exp): idle";
			bar.tooltip =
				"Tatzeroko experimental Apex: no project server started yet. Open an Apex file in a nested DX project.";
			return;
		}
		const busy = st.some(
			(s) => s.state === "starting" || s.state === "restarting",
		);
		const failed = st.some((s) => s.state === "failed");
		const ready = st.filter((s) => s.state === "ready").length;
		bar.text = failed
			? "$(warning) Apex (exp): server failed"
			: busy
				? "$(sync~spin) Apex (exp): initializing…"
				: `$(check) Apex (exp): ready (${ready})`;
		bar.tooltip = new vscode.MarkdownString(
			`**Tatzeroko experimental Apex (${engine})**\n\n${st
				.map((s) => `- \`${rel(s.root)}\`: ${s.state}`)
				.join("\n")}\n\nClick to open the log.`,
		);
		bar.backgroundColor = failed
			? new vscode.ThemeColor("statusBarItem.warningBackground")
			: undefined;
	};
	const onStatus = (r: string, s: ProjectState) => {
		log(`state ${rel(r)} -> ${s}`);
		render();
		if (s === "failed")
			void vscode.window.showWarningMessage(
				`Tatzeroko experimental Apex: server for ${rel(r)} failed to start. See the "Tatzeroko Apex (experimental)" output.`,
			);
	};

	// Jorje JAR: explicit setting, else read in place from the official Salesforce Apex extension.
	let jar = cfg.get<string>("jorjeJar", "");
	if (engine === "jorje" && !jar) {
		jar =
			findOfficialJorjeJar({
				extensionPaths: ["salesforce.salesforcedx-vscode-apex"]
					.map((id) => vscode.extensions.getExtension(id)?.extensionPath)
					.filter((p): p is string => !!p),
			}) ?? "";
		log(
			jar
				? `jorje: using official extension JAR ${jar}`
				: "jorje: no JAR found",
		);
	}
	const javaHome = vscode.workspace
		.getConfiguration("salesforcedx-vscode-apex")
		.get<string>("java.home");
	const java =
		cfg.get<string>("javaPath", "") ||
		(javaHome ? path.join(javaHome, "bin", "java") : undefined) ||
		(process.env.JAVA_HOME
			? path.join(process.env.JAVA_HOME, "bin", "java")
			: undefined);
	const manager = new ProjectManager({
		workspaceRoot: root,
		engine,
		scope,
		maxActiveProjects: cfg.get<number>("maxActiveProjects", 4),
		log,
		onStatus,
		config: {
			typescript: { extensionDir: cfg.get<string>("typescriptServerDir", "") },
			jorje: { jar, java },
		},
	});
	render();
	bar.show();
	log(
		`enabled engine=${engine} scope=${scope} projects=${manager
			.listProjects()
			.map((p) => p.root)
			.join(", ")}`,
	);

	const served = manager
		.listProjects()
		.filter((p) =>
			manager.ownerOfUri(vscode.Uri.file(`${p.root}/x.cls`).toString()),
		);
	const selector: vscode.DocumentSelector = served.map((p) => ({
		language: "apex",
		scheme: "file",
		pattern: new vscode.RelativePattern(vscode.Uri.file(p.root), "**"),
	}));

	const toPos = (p: vscode.Position) => ({
		line: p.line,
		character: p.character,
	});
	const sync = (d: vscode.TextDocument) =>
		d.languageId === "apex" &&
		manager
			.openDocument(d.uri.toString(), d.getText())
			.catch((e) => log(`open failed: ${e}`));

	const subs: vscode.Disposable[] = [out, bar];
	if (selector.length) {
		subs.push(
			vscode.languages.registerCompletionItemProvider(
				selector,
				{
					async provideCompletionItems(doc, pos) {
						await manager.openDocument(doc.uri.toString(), doc.getText());
						const t0 = Date.now();
						const items = await manager.completion(
							doc.uri.toString(),
							toPos(pos),
						);
						log(
							`completion ${path.basename(doc.fileName)}:${pos.line}:${pos.character} -> ${items.length} items in ${Date.now() - t0}ms`,
						);
						return items.map((i) => {
							const c = new vscode.CompletionItem(
								i.label,
								i.kind ? i.kind - 1 : undefined,
							);
							c.detail = `[apex:${engine}]${i.detail ? ` ${i.detail}` : ""}`;
							if (i.insertText) c.insertText = i.insertText;
							return c;
						});
					},
				},
				".",
			),
			vscode.languages.registerDefinitionProvider(selector, {
				async provideDefinition(doc, pos) {
					await manager.openDocument(doc.uri.toString(), doc.getText());
					const t0 = Date.now();
					const locs = await manager.definition(doc.uri.toString(), toPos(pos));
					log(
						`definition ${path.basename(doc.fileName)}:${pos.line}:${pos.character} -> ${locs.map((l) => path.basename(l.uri)).join(",") || "none"} in ${Date.now() - t0}ms`,
					);
					return locs.map(
						(l) =>
							new vscode.Location(
								vscode.Uri.parse(l.uri),
								new vscode.Range(
									l.range.start.line,
									l.range.start.character,
									l.range.end.line,
									l.range.end.character,
								),
							),
					);
				},
			}),
		);
	}

	const diag = cfg.get<boolean>("diagnostics", false)
		? vscode.languages.createDiagnosticCollection("tatzeroko-apex-experimental")
		: undefined;
	if (diag) subs.push(diag);
	const timers = new Map<string, NodeJS.Timeout>();
	const refreshDiag = (d: vscode.TextDocument) => {
		if (!diag || !manager.ownerOfUri(d.uri.toString())) return;
		clearTimeout(timers.get(d.uri.toString()));
		timers.set(
			d.uri.toString(),
			setTimeout(async () => {
				const msgs = await manager.diagnostics(d.uri.toString());
				diag.set(
					d.uri,
					msgs.map(
						(m) =>
							new vscode.Diagnostic(
								new vscode.Range(0, 0, 0, 1),
								m,
								vscode.DiagnosticSeverity.Warning,
							),
					),
				);
			}, 800),
		);
	};

	subs.push(
		vscode.workspace.onDidOpenTextDocument((d) => {
			sync(d);
			refreshDiag(d);
		}),
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.languageId !== "apex") return;
			manager
				.changeDocument(e.document.uri.toString(), e.document.getText())
				.catch((x) => log(`change failed: ${x}`));
			refreshDiag(e.document);
		}),
		vscode.workspace.onDidSaveTextDocument((d) =>
			manager.saveDocument(d.uri.toString()),
		),
		vscode.workspace.onDidCloseTextDocument((d) => {
			manager.closeDocument(d.uri.toString());
			diag?.delete(d.uri);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SECTION))
				vscode.window.showInformationMessage(
					"Tatzeroko experimental Apex: reload the window to apply settings.",
				);
		}),
		vscode.commands.registerCommand("tatzeroko.apexMultiProject.status", () => {
			log(
				`status: ${
					manager
						.states()
						.map((s) => `${rel(s.root)}=${s.state}`)
						.join(", ") || "(no servers started)"
				}; served=${served.map((p) => rel(p.root)).join(", ") || "(none)"}`,
			);
			out.show(true);
			return manager.activeProjects();
		}),
		vscode.commands.registerCommand("tatzeroko.apexMultiProject.showLog", () =>
			out.show(true),
		),
		vscode.commands.registerCommand(
			"tatzeroko.apexMultiProject.restartProject",
			async (rootArg?: string) => {
				const target =
					rootArg ??
					(await vscode.window.showQuickPick(manager.activeProjects()));
				if (target) await manager.restartProject(target);
			},
		),
		vscode.commands.registerCommand(
			"tatzeroko.apexMultiProject.selfTest",
			async () => {
				type Site = { file: string; line: number; character: number };
				const sc = JSON.parse(process.env.TATZEROKO_POC_SELFTEST ?? "{}") as {
					a: Site;
					b: Site;
					root: Site;
				};
				const rec: Record<string, unknown> = {};
				const apexLabels = (l: vscode.CompletionList) =>
					l.items
						.filter((i) => i.detail?.startsWith("[apex:") ?? false)
						.map((i) =>
							typeof i.label === "string" ? i.label : i.label.label,
						);
				const comp = async (s: Site, dLine = 0) => {
					const t = Date.now();
					const l = await vscode.commands.executeCommand<vscode.CompletionList>(
						"vscode.executeCompletionItemProvider",
						vscode.Uri.file(s.file),
						new vscode.Position(s.line + dLine, s.character),
					);
					return { apexItems: apexLabels(l), ms: Date.now() - t };
				};
				const def = async (s: Site, dLine = 0) => {
					const d = await vscode.commands.executeCommand<
						Array<vscode.Location>
					>(
						"vscode.executeDefinitionProvider",
						vscode.Uri.file(s.file),
						new vscode.Position(s.line + dLine, s.character - 3),
					);
					return (d ?? []).map((x) => x.uri.fsPath.replace(root, "."));
				};
				const open = async (s: Site) =>
					vscode.window.showTextDocument(
						await vscode.workspace.openTextDocument(vscode.Uri.file(s.file)),
					);
				const active = () =>
					manager.activeProjects().map((r) => path.relative(root, r) || ".");

				await open(sc.a);
				rec["1 nested A: definition before any completion"] = await def(sc.a);
				rec["2 nested A: completion x3 (same position)"] = [
					await comp(sc.a),
					await comp(sc.a),
					await comp(sc.a),
				];
				rec["3 active after A"] = active();
				await open(sc.b);
				rec["4 nested B: completion (project switch)"] = await comp(sc.b);
				rec["5 nested B: definition"] = await def(sc.b);
				rec["6 active after B"] = active();
				await open(sc.root);
				rec[
					"7 root file: apex items (expect none, root stays with Salesforce)"
				] = await comp(sc.root);
				rec["8 active after root file (expect no root engine)"] = active();
				const ed = await open(sc.a);
				await ed.edit((b) =>
					b.insert(new vscode.Position(0, 0), "// unsaved edit\n"),
				);
				rec["9 A after unsaved edit (line shifted +1): completion"] =
					await comp(sc.a, 1);
				const aRoot = manager
					.listProjects()
					.find(
						(p) => sc.a.file.startsWith(`${p.root}/`) && p.root !== root,
					)?.root;
				await vscode.commands.executeCommand(
					"tatzeroko.apexMultiProject.restartProject",
					aRoot,
				);
				rec["10 A after restart (unsaved edit replayed): completion"] =
					await comp(sc.a, 1);
				rec["11 B after A restart: completion"] = await comp(sc.b);
				rec["12 active at end"] = active();
				const dest = process.env.TATZEROKO_POC_REPORT;
				if (dest) writeFileSync(dest, JSON.stringify(rec, null, 2));
				log(`selfTest ${JSON.stringify(rec)}`);
				return rec;
			},
		),
		vscode.commands.registerCommand(
			"tatzeroko.apexMultiProject.restartAll",
			() => manager.dispose(),
		),
		{ dispose: () => void manager.dispose() },
	);
	context.subscriptions.push(...subs);
	for (const d of vscode.workspace.textDocuments) sync(d);
	if (process.env.TATZEROKO_POC_SELFTEST)
		setTimeout(
			() =>
				void vscode.commands.executeCommand(
					"tatzeroko.apexMultiProject.selfTest",
				),
			1500,
		);
	return { manager };
}

export function deactivate() {}
