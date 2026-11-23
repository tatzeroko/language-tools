# Multi-project Apex LSP — feasibility report

Status: PoC only. Nothing is committed, and the production extension and the Salesforce monorepo are untouched. Everything is in `packages/apex-multiproject-poc/` (private, opt-in, not built by `pnpm -r build`).

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
