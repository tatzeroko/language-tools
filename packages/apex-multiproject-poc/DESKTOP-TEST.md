# Desktop validation: experimental multi-project Apex (unpublished VSIX)

Goal: with the real hybrid Salesforce monorepo **root as the only opened folder**, in a Dev Container, with the official Salesforce Extension Pack installed, verify that the opt-in extension gives Apex completion and Go to Definition in nested DX projects while the official extension keeps the root project.

Nothing here publishes, commits or modifies the monorepo. The VSIX contains only our bundled code: **no Salesforce server and no Jorje JAR is bundled**.

## 0. What is and is not installed

| Item | Where it lives | Notes |
|---|---|---|
| Tatzeroko experimental VSIX | built from this package | `out/` is gitignored |
| Pinned TypeScript Apex server (`v0.11.85-nightly.20261122`) | outside the monorepo, e.g. `~/.tatzeroko/apex-ls` | downloaded + SHA-256 verified |
| Jorje JAR (optional engine) | inside the official Salesforce Apex extension | read in place, never copied |

## 1. Build the VSIX (in this repo, any machine/container with Node ≥ 22.18)

```sh
cd packages/apex-multiproject-poc
npm install --workspaces=false --no-package-lock
npm run ext:package        # -> out/tatzeroko-apex-multiproject-experimental.vsix
sha256sum out/*.vsix       # record it with your results
```

Debug instead of installing: open `packages/apex-multiproject-poc` in VS Code, run the launch config "Tatzeroko Apex PoC: Extension Host" (it builds first, then asks for the monorepo path). Logs: Output → "Tatzeroko Apex (experimental)". The bundle ships a source map.

## 2. Get the pinned Apex server inside the monorepo Dev Container

Run this in the Dev Container terminal (writes outside the monorepo; needs only `curl`, `unzip`, `sha256sum`):

```sh
mkdir -p ~/.tatzeroko/apex-ls && cd ~/.tatzeroko/apex-ls
curl -fL -O https://github.com/forcedotcom/apex-language-support/releases/download/v0.11.85-nightly.20261122/apex-language-server-extension-0.11.85.vsix
echo "221a755901a488dd0d38f3791797944bc9094d977867a4845ffcebd3155c8709  apex-language-server-extension-0.11.85.vsix" | sha256sum -c -
unzip -q -o apex-language-server-extension-0.11.85.vsix -d unpacked
ls unpacked/extension/dist/server.node.js
```

`sha256sum -c` must print `OK`. Alternative where `gh` is authenticated: `npm run prepare:server` in this package does the same and prints the settings.

## 3. Install in the Dev Container

1. Attach VS Code desktop to the Dev Container with the monorepo root as the opened folder.
2. Install the official **Salesforce Extension Pack** (the normal setup). Confirm Apex works for a root-project class first (baseline).
3. Extensions view → `…` → **Install from VSIX…** → pick the file (copy it into the container or use a bind-mounted path). It is a workspace extension, so it installs into the container. CLI alternative inside the container: `code --install-extension /path/to/tatzeroko-apex-multiproject-experimental.vsix`.
4. Enable it **without touching the monorepo**: Settings → **Remote [Dev Container]** tab (not "Workspace"), or the container's `~/.vscode-server/data/Machine/settings.json`:

```jsonc
{
  "tatzeroko.experimental.apexMultiProject.enabled": true,
  "tatzeroko.experimental.apexMultiProject.typescriptServerDir": "/home/<user>/.tatzeroko/apex-ls/unpacked/extension"
  // defaults, listed for clarity: engine "typescript", scope "nested", diagnostics false, maxActiveProjects 4
}
```

5. **Developer: Reload Window.** Settings are read at activation.

Uninstall/rollback: set `enabled` to false and reload, or uninstall the extension. Disabled = no providers, listeners, status bar item or processes (only the status command exists and reports "disabled").

## 4. Status reporting (what you should see)

- Status bar (left): `Apex (exp): idle` → `Apex (exp): initializing…` while any project server starts or restarts → `Apex (exp): ready (N)`; `server failed` (warning colour + notification) on failure. Tooltip lists each project and its state; click opens the log.
- Output channel "Tatzeroko Apex (experimental)": `state <project> -> starting|ready|restarting|failed|stopped`, every completion/definition with latency and item count.
- Commands (palette, prefix "Tatzeroko (experimental):"): Apex multi-project status, Restart Apex server for a project, Stop all Apex servers, Show log.
- Expect ~5–7 s from first Apex request in a project to `ready`; the first completion waits for it (the TS server takes ~1.4 GB RSS per project).

## 5. Known behaviour to expect (do not report as new bugs)

- **Upstream server defect (confirmed, see FEASIBILITY.md A4/C4):** per unchanged document version, the *first* completion-or-definition request is answered; later ones return empty until the text changes. In the VS Code session: completion ×3 at one position → results, `[]`, `[]`. A definition fired first can consume that one answer. Any real edit resets it. This is not worked around.
- Completion items from our extension have detail prefixed `[apex:typescript]` (or `[apex:jorje]`) so they can be told apart from Salesforce's items.
- The extension does **not** contribute the `apex` language; it relies on the Salesforce extension to register it (Apex files will be plain text if no extension provides `apex`).

## 6. Test matrix

Record for each: PASS / FAIL / N/A, what you saw, and the log lines. Use a real P360 class pair where `A` calls a method of `B` in the same nested project, plus a class in a second nested project and one in the root project.

| # | Area | Steps | Expected | Result |
|---|---|---|---|---|
| 1 | Baseline | Extension installed but `enabled` false; reload | No `Apex (exp)` status item, no extra processes (`ps aux \| grep server.node`); Salesforce Apex behaves as before | |
| 2 | Enable | Enable, reload, open only a **root** class | Status `idle`; **no** server started by us | |
| 3 | Routing | Open a nested-project class | Status → initializing → ready (1); log shows only that project root | |
| 4 | Completion | In nested class type `B.` (or `b.`) | Items tagged `[apex:typescript]` incl. B's members, from the nested project only | |
| 5 | Definition | F12 / Ctrl-click on `B` and on a method | Jumps to the file in the **same nested project**; never to another project | |
| 6 | Repeated requests | Trigger completion 3× without editing | Document the outcome (expected: 1st results, then empty = upstream defect). Then type a character and retry: results return | |
| 7 | Edits | Edit unsaved text (add a method to B, don't save), complete in A | New method suggested (unsaved text is what the server sees) | |
| 8 | Save/close/reopen | Save, close the tab, reopen, complete | Works; no stale items | |
| 9 | Second project | Open a class in a second nested project | A second server starts; status `ready (2)`; memory ~+1.4 GB (`ps -o rss`) | |
| 10 | Isolation | In project 2, complete on a symbol that only exists in project 1 | No project-1 symbols offered or resolved; and vice versa | |
| 11 | Restart one | Command: Restart Apex server for a project (project 1) | Status `initializing…` → ready; project 2 untouched (same PID); project-1 unsaved edits still completed | |
| 12 | Crash recovery | `kill <pid>` of project 1's server | Log `engine exited`; status `stopped`; next request transparently restarts that project only | |
| 13 | Shutdown | Close window / run "Stop all Apex servers" | No orphaned `server.node.js` processes afterwards | |
| 14 | Cap | Open classes in > `maxActiveProjects` projects (set to 2 to test) | Least-recently-used server stopped (log `evicting idle engine`); reopen restarts it | |
| 15 | Diagnostics | Leave `diagnostics` false | None published by us. (Optional: enable, expect noisy/false positives; document counts.) | |
| 16 | Coexistence: root | Open a root class with scope `nested` | Only Salesforce provides items/definitions; ours silent | |
| 17 | Coexistence: nested | Open a nested class, trigger completion/hover/definition | Record duplicates: Salesforce items vs `[apex:…]` items; definition shows two peek locations or one? Salesforce's behaviour on nested projects (errors, empty?) | |
| 18 | Coexistence: scope all | Set `scope: "all"`, reload, open root class | Expect duplicate providers for the root project; confirms why default is `nested` | |
| 19 | Salesforce commands | Run SFDX: Create Apex Class, deploy/test commands from palette in nested project | Unaffected by our extension (we register none of these) | |
| 20 | Resource | `ps -eo pid,rss,nlwp,args \| grep -E "server.node\|jorje"` | Record RSS/threads per server (fixture baseline: ~1.4 GB, 11 threads; real projects 1.75–1.8 GB in headless runs) | |
| 21 | Jorje (optional) | `engine: "jorje"`, needs Java 11+/the official extension's Java setup; reload | Log shows `jorje: using official extension JAR <path>`; record completion/definition/cross-file results. Previously (testbed JAR) cross-file resolution failed | |

Report back: pass/fail per row, the Output-channel log, screenshots of rows 4, 11, 17, and the `ps` output for rows 9/20.

## 7. Jorje JAR: obtaining it without copying

Source evidence (`forcedotcom/salesforcedx-vscode`, `packages/salesforcedx-vscode-apex`): the extension's build copies `jars/apex-jorje-lsp.jar` to `out/apex-jorje-lsp.jar`, and `languageServer.ts` resolves `path.resolve(extensionPath, languageServerDir, 'apex-jorje-lsp.jar')`, launching it with `java -cp <jar> … apex.jorje.lsp.ApexLanguageServerLauncher`. After installing the Salesforce Apex extension the JAR is therefore at `<extensions dir>/salesforce.salesforcedx-vscode-apex-<version>/out/apex-jorje-lsp.jar`.

`src/jorje-locator.ts` finds it by (1) the installed extension's `extensionPath` via the VS Code API, then (2) scanning `~/.vscode*/extensions`. The path is only passed to `java -cp`; the JAR is never read, copied, bundled or committed. Distribution/licence terms of the JAR itself were not verified here; treat redistribution as not allowed. Java is taken from `tatzeroko…javaPath`, then `salesforcedx-vscode-apex.java.home`, then `JAVA_HOME`, then `java` on `PATH`.

Caveat: the `out/` layout is read from current `develop`, not from an installed extension (none was installable here); verify on the machine with the real extension (row 21 log line).
