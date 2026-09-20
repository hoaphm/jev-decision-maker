# JEV Decision Maker Plugin Design

## Goal

Package the JEV Decision Maker as a Git-installable OMP plugin without adding dependencies, publishing it, modifying global OMP state, or running inference.

## Scope

- Correct the per-session budget reset to run only on `start`, `switch`, `branch`, and `tree`.
- Preserve the prior paid-run artifacts under `docs/research/` as historical records, but add a separate correction that excludes them from acceptance because their credential path was outside the approved environment-only scope.
- Move the executable extension from native project discovery (`.omp/extensions/`) into the plugin package entrypoint (`src/`).
- Provide a Git-compatible `package.json` OMP manifest, packaged runtime rule, and installation README.
- Verify local `omp plugin link` plus RPC tool discovery using temporary XDG state only; no prompts, model calls, inference, remote publication, or mutation of real plugin state.

## Non-goals

- No marketplace catalog, npm publication, Git remote creation, dependency installation, global configuration, or commit.
- No new benchmark, fixtures, OpenRouter request, model request, or speed conclusion.
- No rewrite of historical paths or measurements in `docs/research/jev-decision-maker-results.json` or the original result report.

## Layout

```text
package.json                         Git-installable OMP plugin manifest
src/decision-maker.ts                Extension entrypoint and exported decision API
rules/decision-maker.md              Runtime activation and authorization boundary
README.md                            Git/local installation and security guidance
tests/decision-maker.test.ts         HTTP boundary and lifecycle reset contract
tests/plugin-install.test.ts         Isolated link + RPC discovery integration test
docs/research/jev-decision-maker-correction.md
                                    Correction that supersedes acceptance claims
```

`package.json#omp.extensions` points to `./src/decision-maker.ts`. OMP loads this extension when the package is installed or linked. Native discovery no longer loads the extension merely because OMP starts at this repository; local source development must use `omp plugin link <repo>` or explicit `-e <repo>/src/decision-maker.ts`.

## Runtime behavior

The extension remains opt-in: it registers `decision_maker` only for `JEV_DECISION_MAKER=1`. It reads only `OPENROUTER_API_KEY` from the process environment at decision time. Missing credentials return `main/missing_key`; they are never retrieved from OMP stores, files, argv, prompts, or logs.

The factory owns `{ remaining: 5 }`. Only `start`, `switch`, `branch`, and `tree` reset it to five. Prompt, retry, compaction, TTSR, todo, and shutdown events do not reset quota.

The plugin rule supplies the activation boundary to installed sessions: use the tool only at genuine coding/debug branch points with 2–5 supported candidates; a selected result is not authorization; `main` means the primary agent keeps reasoning.

## Evidence correction

The prior 12-session JSONL transcripts are retained byte-for-byte and hash-pinned in
`docs/research/jev-decision-maker-evidence.sha256`. `docs/research/jev-decision-maker.md` carries a dated
correction section (it is annotated, not immutable, together with three added keys in the results JSON)
recording that the run is invalid for acceptance because the credential came from an OMP secret-store
command rather than the operator's environment, and withdrawing the unsupported average-tool-call claim.
The only accepted evidence after this change is local guard tests, fixture self-check, and isolated
plugin discovery without inference.

## Status line

The extension owns one status-line slot keyed `jev`, registered whether or not the tool is opted in, so
the line describes the session instead of staying silent. Rendered text is `◆ <label>`:

| Condition | Label |
| --- | --- |
| opted in, key present, tool in the active set | `JEV on` |
| opted in, `OPENROUTER_API_KEY` missing or blank | `JEV no key` |
| opted in with key, tool not active | `JEV inactive` |
| not opted in | `JEV off` |

omp strips ANSI from status text before drawing, so no colour is attempted and the glyph carries the
distinction. `statusLabel()` is exported and its full 8-row truth table is asserted, so the state
machine cannot drift silently. Refresh points are `session_start`, `session_switch`, `session_branch`,
`session_tree` and after every tool call; `session_shutdown` clears the slot because the host never
releases one. Print/JSON/headless sessions have no UI context and write nothing, so the benchmark arms
are unaffected. The label states capability, never authorization.

## Verification

1. `bun tests/decision-maker.test.ts` verifies all existing decision guards and that the only budget reset reasons are `start`, `switch`, `branch`, and `tree`.
2. `bun scripts/benchmark-decision-maker.ts --self-check` verifies synthetic fixture seeds/oracles without starting OMP or inference.
3. `bun tests/plugin-install.test.ts` creates temporary XDG data/state/cache roots, links this package, starts OMP in RPC mode, calls only `get_state`, and asserts `dumpTools` includes `decision_maker` while no `agent_start` event exists. Temporary state is removed in `finally`.

4. The same `probeSession` asserts an `extension_ui_request` frame with `statusKey: "jev"` whose text ends
   with the expected label for off / no-key / ready, and that no frame arrives after `plugin uninstall`.
   Rendering itself was confirmed out of band in a pty-backed interactive session in the isolated HOME:
   `◆ JEV on` with the switch set, `◆ JEV off` without it.

## Distribution

From a clone, or as the source checkout itself:

```text
omp plugin link /absolute/path/to/jev-decision-maker
```

Published at `https://github.com/hoaphm/jev-decision-maker`. The transcripts under `docs/research/`
were scanned for tokens, `gh_`/`gho_` shapes, provider keys, the hindsight URL and password fields
before publication; the only local detail left is one absolute `/home/hoaphm/...` path inside a
historical results record.

Install specs were measured, not assumed, in an isolated HOME with `GIT_CONFIG_GLOBAL=/dev/null`, no
credential helper, no token and no D-Bus session (so any success is anonymous):

```text
omp plugin install github:hoaphm/jev-decision-maker                        # ok
omp plugin install github:hoaphm/jev-decision-maker#main                   # ok
omp plugin install git+https://github.com/hoaphm/jev-decision-maker.git#main  # ok
omp plugin install ssh://git@github.com/hoaphm/jev-decision-maker.git      # ok
```

Each installed version 0.1.0 with `omp.extensions: ["./src/decision-maker.ts"]`, registered
`decision_maker` only when `JEV_DECISION_MAKER=1`, and removed the tool on `omp plugin uninstall`.

While the repository was private, only the `ssh://` form worked: `github:` and `https://…#ref` resolve
through `api.github.com/repos/<owner>/<repo>/tarball/`, which answers `404` without credentials, and
Bun does not consult the git credential helper on that path. For a private plugin repository, use an
SSH spec - or `git clone` plus `omp plugin link`.
