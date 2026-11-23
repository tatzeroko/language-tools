# Multi-project Apex LSP — feasibility report

Status: PoC only, on branch `feat/multi-project-apex-lsp`. Everything is in `packages/apex-multiproject-poc/` (private, opt-in, not built by `pnpm -r build`). The production extension, language server, TypeScript plugin and the Salesforce monorepo are untouched. Nothing from the extended run is committed.

Labels used below: **[Confirmed]** measured or read in source in this run; **[Prototype]** behaviour of our PoC code; **[Hypothesis]** plausible but unverified; **[Untested]** not exercised.

# PART A — Extended run results (supersedes older numbers where they differ)

## A1. Executive technical verdict

- **[Confirmed]** Routing one pinned Salesforce TypeScript Apex server per DX project works: correct completion/definition routing, namespace-scoped workspace loading, per-project restart and crash isolation, clean shutdown with no orphans.
- **[Confirmed]** The engine is **suitable for an opt-in, experimental integration**, and **not yet suitable as a default or as a replacement of Salesforce's extension**, because of two server-side defects that this run could not remove from the client side: (1) repeated completion on an unchanged document returns empty after the first request, (2) semantic diagnostics are timing-dependent (see A5). Both are tied to the server's compile/cache state, not to our routing.
- Cost remains ~1.3 GB RSS and 11 threads per server, ~6.8 s cold start.

## A2. Confirmed working functionality (synthetic fixture + apex-recipes/fflib)

- Discovery of root and nested DX projects; ownership by nearest `sfdx-project.json`; nested roots excluded from the root's workspace load.
- Official-style startup per project (A3); deterministic readiness via `apex/workspaceIngestionComplete` (~160–240 ms for the fixture).
- Completion/definition routed to the owning server (apex-recipes 8/8, fflib 3/3 cross-file call sites; zero foreign definitions).
- Diagnostics pulled per owner; no cross-project leakage (fixture; real projects: 0 foreign class names).
- Open-document tracking with versions and unsaved text; in-place restart that replays only the owner's documents; SIGKILL recovery (A6).

## A3. Official client protocol comparison (source: `forcedotcom/apex-language-support` tag `v0.11.85-nightly.20261122`, read-only clone)

| Aspect | Official VS Code client | Our PoC (before) | Our PoC (now) |
|---|---|---|---|
| Sequence | initialize → initialized → didChangeConfiguration `{settings:{apex}}` → **client-driven workspace load** → ready on `apex/workspaceIngestionComplete` | initialize → bulk didOpen | same as official (`ApexServerInstance.initializeWorkspace`) |
| Client capabilities | large dev set incl. `experimental.{findMissingArtifactProvider, workspaceIngestionProvider, requestWorkspaceLoadProvider, queueStateProvider}`, `textDocument.diagnostic` | minimal | subset in `src/client-capabilities.ts` |
| initializationOptions | `apex.environment.{runtimePlatform, serverMode}`, stdlib path, telemetry/span URLs | environment + stdlib path | unchanged (telemetry omitted on purpose) |
| Workspace load | glob `**/*.cls\|trigger\|apex`, zip batches (fflate, `__metadata.json`) via `apex/sendWorkspaceBatch` → `apex/processWorkspaceBatches` → `apex/workspaceLoadComplete` | none | `src/workspace-load.ts`, same wire format |
| Namespace tagging | only workspace-folder-root `sfdx-project.json` namespace | none | **per owning project**, nested roots and non-packageDirectories skipped (deliberate divergence) |
| Server→client | `apex/findMissingArtifact` (answered `{notFound:true}`), `apex/queueStateChanged`, `$/progress`, `apex/requestWorkspaceLoad` | ignored | handled; `requestWorkspaceLoad` never arrived in our runs |
| Config | pushes settings with `didChangeConfiguration`; `workspace/configuration` is not used | answered null | same |
| Not implemented | document selectors/watchers (`*.cls,trigger,apex`), ApexLib, telemetry, SObject/standard-library generation | — | **[Untested]** `didChangeWatchedFiles` not wired |

Result **[Confirmed]** (`scripts/protocol-matrix.ts`, completion counts over 4 identical requests): capabilities alone change nothing; the workspace-load step makes cross-file completion work with a single opened document and gives a deterministic ready signal, but does **not** fix repeated completion.

| startup | open | counts |
|---|---|---|
| bare | single | [0,0,0,0] |
| bare | bulk | [2,0,0,0] |
| official | single | [2,0,0,0] |
| official | bulk | [2,0,0,0] |

Root-indexing criterion: the root's load contains only its own files (`test/workspace-load.test.ts`, 3 tests).

## A4. Repeated-completion root cause — **confirmed upstream defect**

- Symptom: first completion on an unchanged document returns items, later identical requests return `{items:[], isIncomplete:true}`. Reproduced on the single-server baseline, official startup, development mode, `apex.custom`, same/different positions, didSave, close/reopen. A genuine content change resets it.
- Mechanism **[Confirmed in source + patch]**: `DispatchCompletion` calls `prepareLspRequestCursor` (`apex-ls/src/worker.platform.shared.ts` ≈2701); if `prepared.ready` is false it returns empty/incomplete. `recompileCursorFileAtFullDetail` (≈2517) has a reuse guard `cached.content===content && cached.sourceVersion===(options.sourceVersion??-1) && cached.table===currentTable` that never checks the canonical table is still at full detail. Request 1 compiles but its write-back is rejected ("table reached private, below claimed full"); later requests hit the guard, report `reused`, and `ready` stays false until the content changes.
- Minimal patch **[Confirmed in a disposable copy only]**: add `&& currentTable?.getDetailLevel() === 'full'` to the reuse condition. With it, counts are `[2,2,2,2,2]` (`scripts/completion-regression.ts`, run with `APEX_LS_DIST=…/.cache/patch-reuse/dist`). The pinned VSIX is not modified (`.cache/patch-reuse` is a gitignored copy).
- **[Hypothesis]** why the write-back is rejected: a concurrent equal-version merge from the `DocumentChangeBatcher` flush after `didOpen`. Not verified.
- **Regression test:** `node scripts/completion-regression.ts` exits 1 on the pinned server (`counts=[2,0,0,0,0]`) and 0 on the patched copy. It is intentionally strict; it is **not** part of vitest, so the suite stays green while the blocker is documented. No didChange injection, no caching.
- Draft upstream issue: *"Completion returns empty/incomplete on 2nd request for an unchanged document"*. Repro: official startup, open one class, request completion after `Class.` five times. Expected 5× same items. Actual `[2,0,0,0,0]`. Cause and one-line fix as above.
- Not an issue of: missing client protocol step, workspace indexing, initialization settings, our routing (all excluded by A3/matrix and baseline).

## A5. Diagnostic reliability

**[Confirmed]** server behaviour:
- `DispatchDiagnostic` (≈6519) does not compile live text at full detail itself; body-level semantic errors only appear after a cursor-style request has compiled that document version (policy: `LspRequestPreparationPolicy`, diagnostics `live-if-available`).
- Bare pulls with the official startup and no editor requests were empty for initial, edit, syntax-error and reopen steps even after a 6 s poll.
- `scripts/prime-probe.ts` (fresh server per prime): diagnostics become non-empty after **hover, definition, codeLens, references**; they stay empty after none, completion, documentSymbol, semanticTokens, foldingRange.
- Pull reports carry no `resultId`; changes are debounced 300 ms (pull right after an edit is stale).

**Our handling [Prototype]:** the forced-hover helper is demoted to `probeOnlyHoverPrimedDiagnosticReport` (used only by evidence scripts). The legitimate trigger is `ApexServerInstance.editorRefresh()` = a `textDocument/codeLens` request, which VS Code issues itself after open/change.

**Matrix with editor-style codeLens refresh** (`scripts/diagnostics-matrix.ts`, 11 checks):
- PASS: ingestion on both servers; initial root and nested diagnostics without hover/definition (settle 567 / 128 ms); cross-project isolation; genuine edit detected (≈85 ms); corrected code clears; restart does not touch the nested server; restarted server receives only its own documents.
- **FAIL (4):** syntax error not reported; re-introduced error not reported after clearing; error not reported after close/reopen; unsaved-edit diagnostics not reproduced after restart/replay.
- Delaying the refresh past the 300 ms debounce made even the genuine-edit case fail; the patched (completion) server gives the same 4 failures. So this is a **separate, timing-dependent server-side behaviour**, not fixed by the completion patch. **[Hypothesis]** same family: write-back/compile state racing with the debounced batcher. Unresolved; the matrix is left failing deliberately.
- Step "corrected code clears" is satisfied trivially when diagnostics are always empty; do not treat it as evidence on its own.

**Real projects [Confirmed counts, `scripts/real-project.ts`]:** apex-recipes 2,470 diagnostics in 126/142 files; fflib 3,636 in 31/31. Standard-library path or workspace ingestion did not change counts. Classification by top messages (counts from the top-8 tables):
- *Suspected server defects / standard-library resolution* — "Unable to resolve receiver type for field access: Assert|Id|request|Account" (466+46+22 in recipes; 113+47 in fflib), "Expression cannot be assigned" (382; 157), "Ambiguous method signature: valueOf|get|crud|selectField" (48+30+29; 50+86), "Variable does not exist: Name|Id" (25; 90+49). These are valid, compiling projects, so none are genuine code errors.
- *Missing Salesforce metadata/annotation support* — "Unknown annotation: NamespaceAccessible" (495 in fflib).
- *Syntax errors:* none observed in these projects. *Missing installed-package dependencies:* not separable; **[Untested]** (no real P360).
- Conclusion: the engine's diagnostics are not trustworthy on real projects; do not surface them by default.

## A6. Lifecycle and recovery

**[Confirmed]** (`scripts/lifecycle.ts`, `scripts/bench-crash.ts`):
- Host tracks open docs with versions and unsaved text; `restart(settings)` re-runs the startup sequence and replays only that instance's docs. Replayed text equals the unsaved text; new pid; no foreign doc ever reached a restarted server (router ownership check).
- SIGKILL of the root server: in-flight/next request rejects ("Pending response rejected since connection got disposed"), no hang; nested server keeps answering with the same pid and correct diagnostics; no orphans (5 pids checked).
- 20 cancelled definitions, then a correct one; server healthy. Cancellation: requests settle (answered, not aborted) — **no cancellation machinery needed so far**.
- Restart ≈ 4.2–4.4 s; ingestion-ready ≈ 0.2 s after.
- **Remaining:** after replay, unsaved-edit diagnostics were not reproduced (A5 failure). Config-change handling and file watching are not implemented **[Untested]**.

## A7. Real-project compatibility

Real P360 inaccessible. Substitute: apex-recipes (142 files) + fflib (31 files) as nested project, read-only copies under `.cache/real-ws`. Navigation (definition/completion) works well; diagnostics do not (A5). Cold per-server definitions: 62 s and 84 s to diagnose all files (bulk pulls, not interactive latency).

## A8. Jorje evaluation (legacy Java server)

- **[Confirmed, source]** Official launch (`javaServerLauncher.ts`): `java -cp apex-jorje-lsp.jar [-Ddebug.semantic.errors=… -Dapex.jorje.db.path=… -Xmx…M] apex.jorje.lsp.ApexLanguageServerLauncher`, cwd must be the workspace root; initializationOptions `enableSemanticErrors`, `enableCompletionStatistics`; needs a JDK. Pushes `publishDiagnostics` (no pull).
- **[Confirmed, run locally]** `scripts/jorje-probe.ts` with the JAR read in place from the public testbed checkout (not copied, not committed; `JORJE_JAR` env): two instances (one per project) start in parallel in ≈2.8–3.0 s, ≈220 MB RSS each (vs ≈1.35 GB), JDK 27 works, capabilities: completion, definition, hover, references, documentSymbol, codeAction, codeLens, rename. No cross-project diagnostics leak.
- **Inconclusive:** in this minimal, unconfigured probe Jorje returned 0 completions, 0 definitions and no diagnostics. Jorje normally depends on the SFDX project layout, `.sfdx` indexing and standard-library data supplied by the official extension; getting functional parity needs further work **[Untested]**.
- Licensing: the JAR ships inside Salesforce's extension (the repo is BSD-3 for source; the binary's redistribution terms are not established). Do not bundle or redistribute it; use only an existing local install via a user-supplied path.
- **Recommendation:** an **engine abstraction** (`LaunchSpec` already exists: `tsServerSpec`, `jorjeSpec`) with the TypeScript server as first engine and Jorje as an opt-in secondary engine detected from an installed Salesforce extension; do not commit to Jorje until a functional probe works. Jorje's memory footprint (~6× smaller) makes it attractive for many projects, but completion quality is unproven here.

## A9. Salesforce extension coexistence (design; source-read, extensions not installable here)

- **[Confirmed, source]** The official TypeScript Apex extension (`apex-lsp-vscode-extension`) activates `onStartupFinished`, contributes languages `apex`, `apex-anon`, `soql`, uses a document selector for language `apex`, scheme `file`, and exports `{client, codeLens}` (public API type from `apex-language-server-extension-api`). It does not expose per-project servers or a request API for extra workspaces.
- Conflict surface: VS Code merges providers per language, so two clients on `apex` produce **duplicate completion/hover/definition entries and duplicate diagnostics** (diagnostic collections are per-owner; same-source dupes do not merge). **[Hypothesis]** based on VS Code semantics; not run since Marketplace is blocked.
- Strategy proposal (opt-in, default off):
  1. Default: Tatzeroko registers **no** Apex providers. Official experience unchanged.
  2. Opt-in setting `tatzeroko.apex.multiProject.enabled`; the client registers providers with a **document selector scoped to the nested projects' folders** (`{language:'apex', pattern:'<nested>/**'}`), leaving the root project to Salesforce.
  3. Name diagnostics with a distinct `DiagnosticCollection` and source; never touch Salesforce's settings or disable its extensions automatically; surface a notification explaining the overlap.
- **Cannot be reliably prevented:** the official extension's selector is `language: apex` over the whole workspace, so for files in nested projects both servers answer. VS Code has no API to exclude a path from another extension's provider. Hence nested files get duplicates (and Salesforce's server also indexes nested managed-package files into the root project) unless the user excludes them by `files.exclude`/`search.exclude`-style configuration or a Salesforce-side setting. State this plainly in the opt-in UX; no hooks into private internals.
- Commands for CLI/deploy/test remain Salesforce's; Tatzeroko must not duplicate them. Semantic tokens/CodeLens: Salesforce registers codeLens (test/anonymous Apex) — our host should not forward codeLens to the editor, only use it internally as the refresh trigger.

## A10. TypeScript 7 / tsgo (separate workstream)

Read-only review of `packages/typescript-plugin` (≈320 lines) and `packages/tatzeroko-vscode/src/extension.ts`:
- **Depends on tsserver plugin APIs (unavailable in the native tsgo LSP):** `ts.server.PluginModule` loading; `decorateLanguageService`; mutation of `LanguageServiceHost` (`getScriptFileNames`, `getScriptSnapshot`, `getScriptVersion`, `readFile`, `fileExists`, `readDirectory`, `directoryExists`, `resolveModuleNames`, `resolveModuleNameLiterals`); `getExternalFiles`; `project.addRoot` / `projectService.getOrCreateScriptInfoForNormalizedPath`; `session.addProtocolHandler` custom commands; a virtual file store (`lib/vfs.ts`) feeding placeholder `.d.ts` for `@salesforce/apex/*` and `c/*`. The extension also activates `vscode.typescript-language-features` to reach tsserver.
- **Independent of tsserver:** the Tatzeroko language server (own LSP) and `WorkspaceContext` logic (which project owns which path) are reusable.
- **Migration proposal:** generate real `.d.ts` files on disk (e.g. `.tatzeroko/types/<project>/…`) for Apex (`@salesforce/apex/<Class>.<method>`) and LWC (`c/<component>`), and wire them with `tsconfig` `paths`/`typeRoots`/`include` per DX project (written to a generated `tsconfig.tatzeroko.json` that user tsconfigs `extends`). Namespace-aware generation: one output directory per owning project, namespace prefix applied during generation, nested roots excluded. Incremental regeneration: file watchers on `*.cls`, `*.js-meta.xml`, LWC folders → regenerate only the affected declaration; reuse the shared discovery module. Works with both tsc and tsgo; keep the plugin as a fallback for the legacy tsserver until tsgo is default. **[Untested]** tsgo behaviour (not installed/run); the migration is a proposal only and no production code was changed.

## A11. Performance (one bounded run, `scripts/bench-crash.ts`, 2 servers, fixture)

| Metric | Measured | Previous |
|---|---|---|
| Startup (both in parallel, initialize response) | 6.8 s | ≈6.8 s |
| Workspace-ready after init (ingestion complete) | 0.18–0.24 s | n/a |
| First completion | ≈195 ms | n/a |
| Repeated completion | ≈20 ms (empty after first on pinned server — A4) | n/a |
| Definition | ≈21–28 ms | n/a |
| First non-empty diagnostic (editor refresh) | ≈200 ms | n/a |
| Crash restart (kill → new pid, replay) | ≈4.2 s | ≈4.3 s |
| RSS per server | 1,384 / 1,356 MB | ≈1.35 GB |
| PSS per server | 1,337 / 1,310 MB | n/a |
| Threads / processes per server | 11 / 1 | 11 |

Method: RSS from `/proc/<pid>/status` `VmRSS`, PSS from `/proc/<pid>/smaps_rollup`, summed over the process tree (single process; worker threads share the address space, so RSS/PSS already include them), threads from `Threads:`. Wall-clock via `performance.now()` in the host. Single run, no statistical claims. Jorje comparison: ≈220 MB RSS, ≈3 s start (A8). Completion latency of 20 ms on repeat is meaningless while it returns empty.
- Future optimisations **[Hypothesis]**: lazy server start on first Apex file open; one server per DX project (no duplication per window); idle shutdown with replay on demand (restart ≈4.2 s); cap of N active servers; avoid indexing nested projects twice (already done); Jorje engine for small projects.

## A12. Remaining blockers

1. Upstream completion defect (A4) — need upstream fix or a pinned patched build (not allowed to modify the VSIX; would require a maintained fork).
2. Diagnostics are timing-dependent and noisy on real projects (A5) — cannot be shown by default.
3. Memory ≈1.3 GB per server limits project count.
4. Duplicate providers with Salesforce's official extension cannot be prevented for nested files (A9).
5. Experimental, pre-release upstream; pinned nightly; tied to dev mode (see section 3 below).
6. Real P360 not tested; Jorje not functionally verified; official extension coexistence not run (Marketplace blocked); tsgo not run.

## A13. Recommended production architecture

- Shared **project-discovery + namespace-ownership** module (extract from PoC `discovery.ts`; also reused by the TS plugin / generated-typings workstream).
- **Engine abstraction** (`ApexEngine`: launch spec, initialization, workspace load, restart) with the TypeScript server first and Jorje optional.
- **Per-project host** (lazy start, doc tracking and replay, restart isolation, ingestion readiness) running as child processes of the Tatzeroko extension; router by owner; strict "never send a foreign document" invariant (tested).
- Opt-in setting, nested-only selectors, own diagnostic collection, no UI that suggests replacing Salesforce's extension.
- Gate diagnostics behind a separate setting until A5 is fixed upstream.

## A14. Phased roadmap

1. **Upstream first:** file the completion issue/PR (A4); re-run `completion-regression.ts` and the diagnostics matrix on each new pinned release.
2. **Extract shared modules** (discovery/ownership, host, workspace-load) into a library package; keep PoC scripts as integration tests.
3. **Opt-in VS Code client** in the extension: completion/definition/hover for nested projects only; diagnostics off by default.
4. **Lifecycle hardening:** config-change and `didChangeWatchedFiles` handling, idle shutdown, max-active limit.
5. **tsgo workstream:** generated `.d.ts` + tsconfig (A10), independent of Apex.
6. **Reassess** Jorje engine and server stability when Salesforce stabilises the server.

## A15. Tests and commands executed in this run

```
npx tsc --noEmit                       # clean
npx --yes @biomejs/biome@2.3.9 check --write --config-path=../../biome.json .   # clean
npx vitest run                         # 11 passed (discovery 4, router 4, workspace-load 3)
node scripts/poc.ts                    # all checks passed
node scripts/lifecycle.ts              # all checks passed
node scripts/real-project.ts           # all checks passed (diagnostic counts are informational)
node scripts/bench-crash.ts            # 8/9 PASS (restart-replay diagnostics FAIL, A5/A6)
node scripts/diagnostics-matrix.ts     # 7 PASS / 4 FAIL (A5; left failing deliberately)
node scripts/completion-regression.ts  # FAIL on pinned [2,0,0,0,0]; PASS on patched copy [2,2,2,2,2]
node scripts/protocol-matrix.ts        # table in A3
node scripts/prime-probe.ts            # priming table in A5
JORJE_JAR=<local jar> node scripts/jorje-probe.ts   # A8
```
Pinned artifact: tag `v0.11.85-nightly.20261122`, asset `apex-language-server-extension-0.11.85.vsix`, SHA-256 verified on each fetch (`221a7559…8709`).

**Failed approaches:** delaying the editor refresh past the debounce (broke genuine-edit detection); capability-only changes (no effect on completion); applying the completion patch to fix diagnostics (no effect); hover as permanent priming (rejected by requirement).

---

# PART B — Earlier findings (retained; numbers superseded by Part A where they differ)


## 1. Verdict

**Feasible.** One VS Code window can host one Apex language-server process per DX project, with requests routed by nearest-owner `sfdx-project.json`.

- The Salesforce TypeScript Apex server runs headless over stdio.
- Each instance holds its own workspace, because the server uses process-global singletons.
- Completion, definition and pull diagnostics routed correctly and did not leak between projects.
- The costs are memory (~1.35 GB per server) and a pre-release dependency whose full feature set is gated behind a development mode.

Caveats:
- The fixture is synthetic. Real P360 was not available.
- Jorje was not exercised.
- The upstream project describes itself as experimental.

## 2. Measured evidence

All numbers come from `node scripts/poc.ts` against the synthetic `fixtures/p360-like` (root project `p360` plus nested project `packages/nested`). Raw output is in `.cache/poc-results-development.json`. The results are from one Linux dev container, Node 26, and are not benchmarks.

| Check | Result |
|---|---|
| Discovery | 2 projects (`.`, `packages/nested`), 2 distinct server PIDs |
| Completion | Root gets only `rootOnlyMethod()`/`run()`. Nested gets only `nestedOnlyMethod()`/`run()`. |
| Definition | Each caller resolves to its own project's `AccountService.cls` |
| Diagnostics | Real `textDocument/diagnostic` pull on every owned file (4 files): all `kind=full`, answered by the owning server |
| Isolation | `NestedOnlyBroken` appears only in nested results and `RootOnlyBroken` only in root results. The diagnostic sets differ. No `relatedDocuments` point outside the owner. |
| Document leakage | The router sent neither server any foreign URI |
| Shutdown | `shutdown`/`exit` on both servers, with no surviving PIDs |

Diagnostics detail:
- The root project contains a deliberate `Illegal assignment from 2 to RootOnlyBroken`.
- The nested project contains `Illegal assignment from 1 to NestedOnlyBroken`.
- Both also contain the dangling `AccountService.` syntax error used for completion.

Bypass probe (informational, not a pass/fail check):
- When the router is bypassed and each server is asked to pull diagnostics for the other project's file, it returns `{"kind":"full","items":[]}`.
- This is the same shape as a clean file, so an empty result is not evidence of ownership. Routing is what prevents wrong answers, so it must live in the router.
- I did not run a "single server over both projects" negative control. That remains open.

### Memory and startup methodology

- **Startup** is the wall time from `spawn()` to the `initialize` response. Both servers start in parallel. Measured: 6.73 s and 6.77 s per server (wall 6.78 s).
- **Readiness** is the time from `didOpen` of all owned files to the first completion containing the project's own member. Measured: 0.30 s and 0.46 s. This is distinct from startup, and it is small for a 2-file project. It will grow with project size.
- **Memory** is sampled from `/proc/<pid>/status` (`VmRSS`, `Threads`) and `/proc/<pid>/smaps_rollup` (`Pss`). `treeRss`/`treePss` sum the server PID and all `/proc` descendants. This is Linux only.
  - The server's worker threads live inside one process. They are already counted in that process's RSS and are reported as `Threads` (11 per server). They are not separate OS processes.
  - The tree contained **1 process per server** (no child processes), so the tree total equals the server-process total here.
  - Sampling points: after initialize, after ready, and final.
- Measured per server: RSS 1327 / 1357 / 1394 MB and PSS 1282 / 1310 / 1348 MB at those three points. The two-server total at the end is ~2.8 GB.
- The cgroup `memory.current` was not available, so no container-level total is recorded.
- `completionTwoRequestsMs` in the JSON is no longer meaningful. The previous ~0.2 s figure was for two completion calls only.

Note that RSS includes shared pages and PSS divides them among sharers. They differ little here (~45 MB) because the two servers share little. This was not tested with a large real project, where each server's memory would grow with its symbol table.

## 3. Server modes: what `APEX_LS_MODE=development` really does (item 1)

Source: `ApexLanguageServerCapabilities.ts` and `ApexCapabilitiesManager` in `forcedotcom/apex-language-support`, plus an experiment (`scripts/mode-matrix.ts`) that starts the pinned build under 7 selection variants.

**Desktop production mode** advertises only documentSymbol, semanticTokens, codeLens, executeCommand (debugger commands) and workspace folders. There is no completion, definition, hover, references, rename, code actions or diagnostics. Source comments say "TDX26: production never gets diagnostics", that completion is "Not ready for production", and that hover and definition "require further validation before desktop release". In production the server publishes no diagnostics.

**Development mode** adds completion (`.` and `@` triggers), hover, definition, implementation, references, folding, rename, code actions, pull diagnostics (identifier `apex-ls-ts`, inter-file dependencies), `publishDiagnostics`, `findMissingArtifact` and a queue-state provider.

Experiment (capabilities advertised after `initialize`):

| Variant | completion | definition | diagnostic | hover | references |
|---|---|---|---|---|---|
| default (nothing set) | no | no | no | no | no |
| env `APEX_LS_MODE=development` only | no | no | no | no | no |
| `initializationOptions.apex.environment.serverMode=development` | yes | yes | yes | yes | yes |
| env production + init option development | yes | yes | yes | yes | yes |
| env development + init option production | no | no | no | no | no |
| production + `initializationOptions.apex.custom` (completion, definition, diagnostic) | yes | yes | yes | no | no |
| top-level `environment.serverMode` | no | no | no | no | no |

Findings:
1. **Only the initialization option `apex.environment.serverMode` selects the mode in this build.** The `APEX_LS_MODE` env var had no effect, even though the extension README says it forces a mode. The README also says production includes hover, which the code and experiment contradict. My earlier PoC worked only because it also sent the init option.
2. `apex.custom` can enable individual capabilities while staying in production mode. This is the narrowest way to get completion, definition and diagnostics. Hover and references stay off.
3. This is not a stable public contract. The modes exist to gate features Salesforce does not yet consider releasable.

**Is relying on development mode appropriate for a user-facing extension? Not as a default.** It is a pre-release gate that Salesforce can change or remove, and the server is explicitly experimental. Recommendations:
- Ship it opt-in and labelled experimental.
- Select the mode only through the init option, never the env var.
- Prefer `apex.custom` to enable only the capabilities Tatzeroko needs.
- Check the advertised `ServerCapabilities` (and the server's `featureStateProvider`) at runtime. Degrade gracefully, or refuse to start with a clear message, when a capability is missing.
- Pin the server version and hash (section 4), and bump it deliberately.

### Server behaviour worth knowing

- Workspace loading in the official client is driven by custom requests (`apex/requestWorkspaceLoad`, `apex/sendWorkspaceBatch`, `apex/workspaceIngestionComplete`). The PoC does not implement them and uses `didOpen` for every owned file.
- A production host will need either the full ingestion protocol or a bulk `didOpen`, which scales poorly for large orgs.
- **Repeated completion returns empty.** Root cause found in section 9a: a server defect, not the router.

## 9a. Stability investigation: repeated completion (priority 1)

**Reproduction.** `scripts/repro-completion.ts` talks raw LSP to one server with no router (scenarios A to K, JSON in `.cache/repro-*.json`). It reproduces every time and is independent of mode (`development` or `apex.custom`), open-file count, syntax errors, `didOpen` version (0, 1, 7), position, and of whether the bundled StandardApexLibrary is supplied.

| Sequence | Result |
|---|---|
| `didOpen`, completion #1 | items (2) |
| completion #2..N, same version, same or other position, after 3 s idle | `{items: [], isIncomplete: true}` |
| `didSave`, or `didClose` + `didOpen` | still empty |
| any `didChange` (even identical text, version bumped) | completion works again |
| typing flow (`didChange` before each request) | works every time |
| definition / hover repeated | always fine |

**Cause (confirmed by instrumenting a copy of the pinned worker and reading the source at the pinned tag).** `DispatchCompletion` (`apex-ls/src/worker.platform.shared.ts`) calls `prepareLspRequestCursor`. When `prepared.ready` is false it returns the empty incomplete list without calling `CompletionProcessingService`. Request 1 recompiles to `full`, but the write-back is rejected ("Write-back skipped: table reached private, below claimed full"). Requests 2..N hit the unchanged-content cursor cache and read the canonical table level as `public-api`, so `ready` stays false until the content changes.

**Classification: confirmed server limitation.** Not routing, not document sync, not initialization settings. The router and the single server behave identically. I did not cache the first response. A non-masking mitigation exists, a client-side identical-text `didChange` resync before a completion, but it is **not implemented** and needs a decision. It costs a recompile per request.

## 9b. Diagnostics behaviour (priority 1 and 3)

- **False clean.** `textDocument/diagnostic` returns `full` with `items: []` until a hover, definition or completion has run for that document version. documentSymbol and references do not unlock it. The PoC's `enrichedDiagnosticReport` issues a hover at (0,0) first. This is a **server limitation** and a workaround dependency.
- **Debounce staleness.** A pull right after `didChange` returns the previous diagnostics (the server debounces changes by 300 ms). A pull after 1 s is correct. A production client must wait or retry. Server limitation.
- Reports carry no `resultId`, so previous-result caching is not possible.
- **Noise on valid code.** apex-recipes: 2,470 diagnostics in 126 of 142 files. fflib-apex-common: 3,636 in 31 of 31 files. Top messages: "Unable to resolve receiver type", "Ambiguous method signature", "Unknown annotation: NamespaceAccessible", "Variable does not exist". Supplying `resources.standardApexLibraryPath` as the official client does **did not change the counts** (identical 2,470), so I attribute the noise to the experimental server, not to our init options. Unconfirmed: the official client's workspace ingestion protocol (not implemented in the PoC) might change this. Treat diagnostics as unreliable for production use until tested with that protocol.

## 9c. Real projects (priority 2)

- **Real P360 was not accessible** (filesystem search and `gh repo list` found nothing). It is untested. Read-only substitutes: `forcedotcom/apex-recipes` (142 files) as root and `apex-enterprise-patterns/fflib-apex-common` (31 files) as a nested project. Neither source clone was modified. The workspace is in gitignored `.cache/`.
- Definitions landed on the called class in the same project: 8/8 and 3/3. Zero definitions resolved outside their project. Completion after `Class.` offered the called method in 8/8 and 3/3 first requests.
- Isolation probe: an in-memory `ForeignClass __probe = 1;` produced "Illegal assignment ... to <ForeignClass>" in both directions, so neither project resolves the other's classes. Neither server received a foreign document.
- An earlier "foreign names in diagnostics" failure was a harness artefact: the substring match hit short generic class names. With word-boundary matching there are 0 hits. The harness also decoded URIs wrongly for paths with spaces; both are fixed.
- Timing: startup about 6.8 s per server. First resolving definition 10.6 s (recipes) and 15.2 s (fflib). A sequential diagnostics sweep took 64 s (142 files) and 83 s (31 files), so about 0.45 s and 2.7 s per file.

## 9d. Lifecycle (priority 3)

All checks in `scripts/lifecycle.ts` passed:
- Edits: a nested error appears, clears after the fix, returns when reintroduced. The root's error is unaffected. A root file naming a nested-only type reports an error.
- Restarting one server: new pid, the other pid unchanged, ~4.3 s startup, the other project kept answering (36 ms) while it was down. Requests to the down project raise `ServerUnavailableError`, never an answer from another project.
- SIGKILL: the crash is detected. **Tatzeroko bug found and fixed in the PoC host:** in-flight requests hung because the connection was not disposed on process exit. They now reject. Both projects crash and recover independently.
- Clean shutdown: exit code 0, no orphan processes (5 pids checked).
- Cancellation: `$/cancelRequest` is sent and nothing hangs. All 20 requests were still answered. The requests are too fast to show whether the server honours cancel, so **it is unverified**.
- A restarted server reads from disk. **Unsaved edits are lost unless the client replays open documents.** The host does not track them yet (Tatzeroko limitation).

## 9e. Server limitations vs Tatzeroko limitations

| Item | Server (confirmed) | Tatzeroko / host |
|---|---|---|
| Repeated completion empty | yes (9a) | no |
| Diagnostics false-clean until a hover | yes | workaround exists |
| 300 ms debounce staleness | yes | client must wait or retry |
| Diagnostics noise on valid code | likely, cause not fully isolated | init options ruled out |
| Dev-mode gating, experimental status | yes | opt-in only |
| ~1.35 GB RSS per server | yes | lazy start and idle shutdown needed |
| Hang on crash | no | fixed in PoC |
| No open-document replay on restart | no | open |
| No workspace ingestion protocol | no | open |
| Cancellation honoured | unknown | open |

## 9f. Remaining blockers before production integration

1. Completion defect (needs a decision on the resync mitigation or an upstream report).
2. Diagnostics reliability: false-clean, debounce and noise. Retest with the ingestion protocol.
3. Real P360 not tested (size, namespace, SObject metadata).
4. No document replay on restart and no ingestion protocol.
5. Memory of ~1.35 GB per server and slow diagnostics sweeps.
6. Cancellation unverified. The server is experimental and dev-mode gated.
7. Jorje was not evaluated, and no VS Code extension-host integration exists.

Not confirmed: the production extension, the Salesforce monorepo and git history were not touched.

## 10. Verification results

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 8/8 pass (2 files; 2 new router tests for `ServerUnavailableError` and `replace`) |
| `npx @biomejs/biome@2.3.9 check` | no warnings |
| `node scripts/poc.ts` | all checks passed, with a freshly downloaded and hash-verified server |
| `node scripts/lifecycle.ts` | all checks passed |
| `node scripts/real-project.ts` | all checks passed (apex-recipes + fflib; P360 not accessible) |
| `git status` | only `?? packages/apex-multiproject-poc/` |

## 11. Limitations

- Synthetic fixture. Real P360 size, namespaces and SObject metadata are untested.
- Dev-mode gating and the "experimental" status of the upstream server.
- Memory of ~1.35 GB per server grows with project size. Ten projects would not fit a typical dev container.
- ~6.8 s startup per server (parallel). Lazy start per project on first open is advisable.
- Repeated completion returns empty (section 9a).
- No Jorje run, no VS Code extension-host integration.
- Linux-only process metrics.
- Two-project fixture only.

## 12. Phased production proposal

**Phase 0: shared infrastructure (no Apex server).**
- Extract `ProjectRegistry` (discovery, nearest owner, nested exclusion) into a pure package.
- Replace `isRelatedWorkspace` propagation and key `WorkspaceContext` by project root.
- Add unit tests for nested-project isolation. This benefits LWC/TS independently.

**Phase 1: opt-in headless host.**
- Productise `ApexServerInstance` and `ApexRouter` behind `tatzeroko.apex.multiProject.enabled` (default off).
- Lazy start per project, idle shutdown, memory cap and a visible status item.
- Pinned, hash-verified server download. Mode selection via init options only, using `apex.custom`.
- Blocked on the completion defect (section 9a) and the diagnostics workaround (section 9b).

**Phase 2: parity and coexistence.**
- Implement the workspace ingestion protocol, and open-document tracking and replay on restart.
- Add conflict detection and the prompt flow from section 6, plus restart and crash recovery.
- Run against real P360 and measure memory and startup. Run the negative control.

**Phase 3: tsgo-compatible typings (separate workstream, can start any time).**
- Real `.d.ts` on disk plus `tsconfig` paths, keeping the plugin as fallback.

**Phase 4: reassess.**
- Re-evaluate when Salesforce stabilises production mode, or exposes a per-project or multi-client API, or ships the server on npm. Re-evaluate Jorje only if licensing permits and the TS server stays experimental.

## 13. How to reproduce

```
cd packages/apex-multiproject-poc
npm install --workspaces=false --no-package-lock
npx tsc --noEmit && npx vitest run
node scripts/poc.ts            # downloads and hash-verifies the pinned VSIX (needs gh auth)
node scripts/mode-matrix.ts    # mode-selection experiment
```

`pnpm` is not installed in this environment, and plain `npm install` fails on `workspace:*` at the repo root, hence the flags.


---

# PART C — Editor-level prototype and Jorje engine evaluation

Labels as above. Everything here is inside `packages/apex-multiproject-poc/`; `git status` outside it is empty.

## C1. What was built

| Piece | File | Notes |
|---|---|---|
| Engine interface | `src/engine.ts` | `ApexEngine` (start/waitReady/open/change/save/close/completion/definition/diagnostics/restart/stop/onExit). One `HostEngine` adapter over the existing `ApexServerInstance` serves **both** engines; only the launch spec, handshake and readiness signal differ. No second host implementation. |
| Project manager | `src/project-manager.ts` | VS Code-independent. `ownerOf` picks the project, one lazily started engine per project, LRU eviction (`maxActiveProjects`, default 4), crash → fresh engine + replay of **that project's** open documents including unsaved text, per-project restart. A document is never sent to another project's engine. |
| VS Code glue | `vscode-ext/extension.ts`, `package.json` | Separate extension (bundled with esbuild to `vscode-ext/out/extension.cjs`, gitignored). Not part of the Tatzeroko extension. |
| Tests | `test/project-manager.test.ts` | 5 tests with fake engines (scope, routing, per-project restart/replay, crash replacement, eviction). Vitest total 16/16. |
| Evidence scripts | `scripts/engine-compare.ts`, `scripts/engine-real.ts` | Same checks for either engine; JSON in `.cache/`. |

Opt-in design **[Prototype]**: `tatzeroko.experimental.apexMultiProject.enabled` defaults to `false`; when false `activate()` returns before registering anything or spawning anything. `diagnostics` defaults to `false`. `scope` defaults to `nested`: providers are registered only for nested project folders (via `RelativePattern`), so the root DX project stays with the Salesforce extension. `scope: all` also serves the root and **will duplicate** Salesforce's providers.

The extension declares the `apex` language id (`.cls/.trigger/.apex`) so it can be tested without the Salesforce extension. Redeclaring an id merges with the Salesforce contribution; this should be removed for production.

## C2. Real VS Code session — what was actually run

**[Confirmed]** The Marketplace, Open VSX and `update.code.visualstudio.com` are unreachable here, so desktop VS Code could not be installed. Instead `code-server` 4.146.0 (Code 1.146.0; release asset `code-server-4.146.0-linux-amd64.tar.gz`, SHA-256 `cf7e82ca5fe1df664d43a43d900c3c9710f8f3403a5e8d0e18f6a12d10d7401b`, one-time 266 MB public GitHub download kept in `/tmp`, not in the repo) was run, driven through Chromium/Playwright. This is real VS Code workbench + extension host; the extension was loaded from `--extensions-dir` and activated on `onLanguage:apex`.

Workspace: copy of `fixtures/p360-like` (root + `packages/nested`) plus a second nested project `packages/second` and two clean class pairs (no syntax errors). Only the workspace root was opened.

Scenario run through the real provider APIs (`vscode.executeCompletionItemProvider`, `vscode.executeDefinitionProvider`) by an env-gated self-test (`TATZEROKO_POC_SELFTEST`; inert unless set). Apex-originated items are tagged `[apex:<engine>]` so VS Code's own word-based suggestions are not counted:

| # | Step | Result |
|---|---|---|
| 1 | Nested A: definition on `CleanSvc` before any completion | → `packages/nested/.../CleanSvc.cls` |
| 2 | Nested A: completion at same position ×3 | `countAccounts(), label()` → **`[]` → `[]`** (upstream defect, see C4) |
| 3 | Active servers | `packages/nested` only |
| 4 | Open nested B, completion (project switch) | `SecondSvc` only; first request 4.8 s (includes lazy server start) |
| 5 | Nested B definition (after its completion) | none (same defect) |
| 6 | Active servers | `nested`, `second` (two processes) |
| 7 | Open a **root** project file, completion | no Apex items; **no root engine started** |
| 9 | Unsaved edit in A (line inserted), completion at shifted position | `countAccounts(), label()` (a genuine change resets the defective state) |
| 10 | Restart A only (command), completion at same position | `countAccounts(), label()` — unsaved edit was replayed |
| 11 | B after A's restart | still served by B's own process (0 items only because B had already been asked at that position: defect) |

Orphans: after stopping `code-server` (SIGTERM to its parent) **0** `server.node.js` processes remained.
Manual UI typing (Ctrl+Space) was attempted first; with the engine still starting the first request returned nothing and Monaco showed only word-based suggestions, so the deterministic API self-test was used. **[Untested]** hover, code actions, go-to-definition via Ctrl+click, tabs/window reload with multiple windows, and real Salesforce extension coexistence.

## C3. New server finding: definition is affected by the same defect

**[Confirmed]** With the pinned server, `definition` works on a fresh document but returns `[]` once a completion has run on it. Probe (`/tmp/def.ts`, fixture `CleanCaller/CleanSvc`): def ×3 OK → completion → def `[]`. With the disposable patched dist (`.cache/patch-reuse/dist`, one-line upstream fix from A4) the same sequence returns `CleanSvc.cls`. So `engine-compare`'s `definition resolves inside own project` FAIL on the TypeScript engine is the defect, not routing; the assertion was left strict. Upstream issue text should mention completion *and* definition.

## C4. Jorje (legacy Java) — initialization and evidence

Launch/handshake as the official client does (source: `salesforcedx-vscode` `languageServer.ts`, read-only): `java -cp <jar> -Ddebug.internal.errors=true -Ddebug.semantic.errors=<bool> -Ddebug.completion.statistics=<bool> -Dlwc.typegeneration.disabled=true [-Xmx<MB>M] apex.jorje.lsp.ApexLanguageServerLauncher`; `initializationOptions {enableEmbeddedSoqlCompletion, …}`; readiness = server notification **`indexer/done`**; there is no client-driven workspace load (the server indexes `rootPath` itself).

**[Confirmed]** (bytecode via `javap`): Jorje takes the project root from the deprecated `InitializeParams.rootPath`; without it indexing NPEs and `indexer/done` never fires. `-Dapex.jorje.db.path` is not enough. It writes its index to `<root>/.sfdx/tools/<ver>/apex.db` (gitignored; the PoC removes these from fixtures).

| Check (fixture, 2 projects) | Jorje result |
|---|---|
| Starts + ready (`indexer/done`) | 2.8–3.0 s for both servers in parallel; ready 1–1.2 s after initialize |
| Diagnostics (pushed) | own error found immediately, no cross-project leak |
| Definition | resolves inside own project (2–32 ms) |
| Per-project restart / orphans | 1.7 s, other project untouched, no orphans |
| **Member completion** (`Cls.` → members) | **fails**: `[0,0,0,0]` on fixture; on a clean pair it returns the enclosing class's members (`go()`) and a stdlib item but **not `CleanSvc` members** |
| Real project (apex-recipes ~140 classes) | completion/definition 0 at 8/8 sites; diagnostics `Variable does not exist: RestClient`, `Invalid type: Database.AllowsCallouts` — i.e. neither project classes nor standard types resolved |

**[Hypothesis, untested]** The testbed JAR (from `forcedotcom/apex-language-support`, not a Salesforce-shipped one) may be an incompatible/older build, or Jorje needs a client behaviour we do not replicate (e.g. `workspace/didChangeWatchedFiles` after index, or the official extension's SObject/`.sfdx/tools` symbol files). Ruled out: directory names with spaces (rerun with a space-free copy gave the same result); call-site positions (call sites skip comments and are validated against project class names). **Jorje is therefore NOT validated as an alternative engine here.** Its resource profile is good (below) but a working Jorje needs the JAR from a real Salesforce extension install (not available; the JAR must never be copied into this repo) and a re-test.

Isolation caveat **[Hypothesis]**: Jorje indexes everything under `rootPath`, so a *root* Jorje instance would ingest nested projects; the TypeScript engine's load is client-controlled and does not. Test before offering Jorje for root projects.

## C5. Engine comparison (identical fixture, 2 servers, one run each — single samples, not statistics)

| Metric | TypeScript engine (pinned `v0.11.85-nightly.20261122`) | Jorje (testbed JAR) |
|---|---|---|
| Startup, 2 parallel servers | 7.3 s (6.8–8.4 across runs) | 3.0 s |
| Ready after initialize | 0.2–0.3 s (fixture), 4.4–4.6 s (real project) | 1.0–1.2 s (fixture), 1–2 s (real) |
| RSS / PSS per server | ~1.39 GB / ~1.35 GB (real project: 1.75–1.8 GB RSS) | ~290 MB / ~275 MB (real: 280–410 MB RSS) |
| Threads | 11 | 27–39 |
| First / repeat completion | 160–190 ms / `[2,0,0,0]` (defect) | not working |
| Definition | 27–40 ms; empty after a completion (defect) | 2–32 ms |
| Diagnostics | needs editorRefresh + pull; ~110–140 ms; noisy on real code (96 / 481 in 15-file samples) | pushed; immediate; less noisy (43 / 18 in 15-file samples) but built on unresolved types |
| Restart (one project) | 4.6 s, other project untouched | 1.7 s, other project untouched |
| Orphans after stop | 0 | 0 |

Measurement: `src/proc-stats.ts` sums `/proc` RSS, PSS (`smaps_rollup`), thread and process counts over the server's process tree. Sampling at a single point after the checks; no warm-up repetition.

## C6. Coexistence with the official Salesforce extensions

**[Confirmed from source/VS Code semantics, not from a live install]**: the official TS Apex extension activates on startup and registers providers for language `apex` workspace-wide; VS Code cannot exclude paths from another extension's providers. So:

- Default (`scope: nested`, feature off by default): no overlap in the root project. In nested projects the Salesforce extension's providers and ours **both** respond; VS Code merges completions (duplicates possible) and shows multiple definitions (peek list). We cannot suppress theirs through any public API; document it.
- Diagnostics are the largest duplicate-risk, hence off by default and in a separate named collection.
- Nothing disables or reconfigures Salesforce extensions. Do not do that automatically.
- **[Untested]** Live side-by-side behaviour (merged completion UX, extra servers' memory ≈ 1.4 GB each) because the official extension cannot be installed here. Manual test below.

## C7. Remaining blockers (new/updated)

1. Upstream repeated-completion/definition defect (one-line patch proven; needs upstream fix or a vetted patched distribution — not shippable as-is).
2. Memory: ~1.4–1.8 GB per project server with the TS engine → needs lazy start + idle shutdown + project cap before production.
3. Jorje not validated (cross-file resolution failure above).
4. Duplicate providers in nested projects when Salesforce's extension is active.
5. Diagnostics unreliable/noisy on real projects (A5/A7).
6. No real-P360 checkout was available.

## C8. Manual testing needed (desktop VS Code)

1. `cd packages/apex-multiproject-poc && npm install --workspaces=false --no-package-lock && node scripts/fetch-server.ts && npx esbuild vscode-ext/extension.ts --bundle --platform=node --format=cjs --external:vscode --outfile=vscode-ext/out/extension.cjs`.
2. Launch with `code --extensionDevelopmentPath=$PWD/vscode-ext <monorepo-root>`; set `tatzeroko.experimental.apexMultiProject.enabled: true` and `…typescriptServerDir` to `.cache/extension/extension`.
3. With the official Salesforce extensions installed, open a class in a nested project: record duplicate completions/definitions, Output channel “Tatzeroko Apex (experimental)”, and process memory (`ps`).
4. Toggle `scope: all` to observe root duplication; confirm default off changes nothing.

## C9. Next production-integration steps

1. Land the upstream fix (or pin a patched build) before exposing completion/definition; add the C3 sequence as a regression test.
2. Move `ProjectManager` + engine interface into a separate package; keep the vscode glue in a feature-flagged module of `tatzeroko-vscode` (no production changes were made here).
3. Add idle shutdown + `maxActiveProjects` defaults + status bar item; add file-watcher forwarding.
4. Re-evaluate Jorje with a Salesforce-shipped JAR before committing to a dual-engine product; the interface already allows it.
5. Keep diagnostics off until the false-positive profile is acceptable.
6. Keep the TS 7/tsgo workstream (A10) independent.

## C10. Commands executed in this part

`npx tsc --noEmit` (clean); `npx vitest run` (4 files, 16/16); Biome 2.3.9 on `src test scripts vscode-ext/extension.ts` (clean); `node scripts/poc.ts` (all pass); `node scripts/lifecycle.ts` (all pass); `node scripts/engine-compare.ts typescript|jorje` (TS: 10/14 pass, failing the two *definition* and two *repeated completion* checks — defect; Jorje: 10/14, failing member completion ×2 and repeated completion ×2 — not working); `node scripts/engine-real.ts jorje` (see C4); pinned VSIX SHA-256 `221a7559…8709` re-verified; code-server session as in C2.

## C11. Desktop-validation preparation (this step)

**[Prototype]** Added, all inside the PoC package: `npm run ext:package` (esbuild bundle → unpublished VSIX, 195 KB, contains no Salesforce server/JAR), `.vscode/launch.json` + `tasks.json` for Extension Host debugging, `scripts/prepare-desktop.ts`, `DESKTOP-TEST.md` (Dev Container steps, 21-row test matrix, exact manual actions), a status bar item and `state` log lines driven by `ProjectManager.onStatus` (`starting → ready → restarting → failed/stopped`), a Jorje JAR locator (`src/jorje-locator.ts`, read in place, 2 unit tests), a `javaPath` setting, and `ELECTRON_RUN_AS_NODE=1` for the TS server child so it also runs when VS Code's `process.execPath` is the Electron binary (untested on desktop; code-server's is plain node).
**[Prototype]** The extension no longer contributes the `apex` language (it would duplicate the Salesforce extension's registration). Consequence: the VSIX needs an extension that registers `apex`; the earlier self-test was re-run with a stub language extension standing in for it.
**[Confirmed]** Re-run in code-server 4.146.0 from the *packaged VSIX*: activation OK; states `starting → ready`, a second project started independently, per-project restart showed `restarting → ready` while the other project stayed `ready`; status bar showed `Apex (exp): initializing…` during restart. Process list empty after stopping code-server. Observed variability: in this run the first definition request returned none (it landed at server readiness) and the following completions on that project returned 0 items (consistent with the one-answer-per-version upstream defect — the definition consumed the answer); the second project's first completion returned `SecondSvc`. Not a routing issue, but it shows the defect also bites when definition goes first.
**[Untested]** Official Salesforce Extension Pack coexistence, Electron-as-node spawn, and the official extension's `out/apex-jorje-lsp.jar` layout on a real install — all are rows in `DESKTOP-TEST.md`.
