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

The prior 12-session JSONL, JSON, and Markdown are retained unchanged as historical data. `docs/research/jev-decision-maker-correction.md` states that the run is invalid for acceptance because the credential was obtained from an OMP secret-store command rather than provided as `OPENROUTER_API_KEY` by the user. It removes the unsupported average-tool-call claim and records that live proof is unavailable. The only accepted evidence after this change is local guard tests, fixture self-check, and isolated plugin discovery without inference.

## Verification

1. `bun tests/decision-maker.test.ts` verifies all existing decision guards and that the only budget reset reasons are `start`, `switch`, `branch`, and `tree`.
2. `bun scripts/benchmark-decision-maker.ts --self-check` verifies synthetic fixture seeds/oracles without starting OMP or inference.
3. `bun tests/plugin-install.test.ts` creates temporary XDG data/state/cache roots, links this package, starts OMP in RPC mode, calls only `get_state`, and asserts `dumpTools` includes `decision_maker` while no `agent_start` event exists. Temporary state is removed in `finally`.

## Distribution

Develop locally or on a copied clone:

```text
omp plugin link /absolute/path/to/JEV-omp
```

Published as the private repository `github.com/hoaphm/jev-decision-maker` (commit `c140c13`), and the
remote install path was then measured rather than assumed:

```text
omp plugin install ssh://git@github.com/hoaphm/jev-decision-maker.git     # works
omp plugin install github:hoaphm/jev-decision-maker[#main]                # fails: tarball API 404
omp plugin install https://github.com/hoaphm/jev-decision-maker.git#main  # fails: same endpoint
```

Bun resolves the `github:` and `https://…#ref` forms through
`api.github.com/repos/<owner>/<repo>/tarball/` without git credentials, which answers `404` for a
private repository; the `ssh://` spec clones through git and authenticates. `README.md` documents the
working form. Making the repository public would unblock the `github:` shorthand - not done, since the
transcripts under `docs/research/` are the owner's to publish.
