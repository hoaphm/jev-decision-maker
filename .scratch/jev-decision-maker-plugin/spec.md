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
.omp/config.yml                      Project-scoped loader for this checkout
src/decision-maker.ts                Extension entrypoint and exported decision API
rules/decision-maker.md              Runtime activation and authorization boundary
README.md                            Git/local installation and security guidance
tests/decision-maker.test.ts         HTTP boundary and lifecycle reset contract
tests/plugin-install.test.ts         Isolated link + RPC discovery integration test
docs/research/jev-decision-maker-evidence.sha256
                                    Hashes pinning the 12 immutable transcripts
docs/research/jev-decision-maker.md  Report plus the dated correction section that
                                    supersedes its acceptance claims
```

`package.json#omp.extensions` points to `./src/decision-maker.ts`, and omp loads it when the package is
installed or linked. Native extension discovery no longer loads anything merely because omp starts in
this repository - `<cwd>/.omp/extensions` is gone - so this checkout carries `.omp/config.yml` with
`extensions: [./src/decision-maker.ts]`: project scope, tracked in git, no per-machine step. Measured
caveat: `omp plugin link . --scope project` does not honour the scope on 18.2.6 - it reports success and
writes the symlink into the user root instead.

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
releases one. Print and `--mode json` runs have no UI context and write nothing, so the benchmark arms
are unaffected; an RPC session has no terminal but still serialises each write as a frame, which is how
the automated test observes the label. The label states capability, never authorization.

## Setup command

The plugin registers `/setup-jev` unconditionally - also while the tool is off - because it is the only
discoverable way for a fresh session to turn the tool on:

| Argument | Effect |
| --- | --- |
| none | reports the effective switch, both env files and their contents, credential presence, tool activeness |
| `enable` / `disable` | writes/removes `JEV_DECISION_MAKER` in `<cwd>/.env` |
| `enable --global` / `disable --global` | same, in `<agent dir>/.env` |
| `key` | copies an already-exported `OPENROUTER_API_KEY` into `<agent dir>/.env`, mode 600, never printed |

Measured constraints (omp 18.2.6, isolated HOME, RPC only, no inference):

- extension UI has no masked input, and provider-login secret prompts are rejected in RPC, so the command
  never asks for the credential - it copies one from the environment or prints the shell line to run;
- a launch-directory `.env` is read from that exact directory, never from an ancestor, while
  `<agent dir>/.env` is read from any working directory;
- the process environment beats both files, which keeps `JEV_DECISION_MAKER=0` authoritative;
- launching omp with `cwd == $HOME` makes omp switch to a temp directory, so the session cwd - and with it
  the project `.env` target - is not the home directory; the harness must therefore drive the command from
  a real project subdirectory;
- `enable` checks `git check-ignore` and refuses to write a `.env` that git would track;
- writes go through a temp file and `rename`, and merge instead of clobbering unrelated lines.

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

Each installed the then-current package build with `omp.extensions: ["./src/decision-maker.ts"]`, registered
`decision_maker` only when `JEV_DECISION_MAKER=1`, and removed the tool on `omp plugin uninstall`. No
version literal is recorded here on purpose: the installed version tracks `package.json`.

While the repository was private, only the `ssh://` form worked: `github:` and `https://…#ref` resolve
through `api.github.com/repos/<owner>/<repo>/tarball/`, which answers `404` without credentials, and
Bun does not consult the git credential helper on that path. For a private plugin repository, use an
SSH spec - or `git clone` plus `omp plugin link`.

## Amendments after approval

Requested by the owner later in the same effort, so they supersede the matching non-goals above:

- Publication: the repository was created at `github.com/hoaphm/jev-decision-maker` and switched from
  private to public, after the transcripts were scanned for tokens, provider keys and personal data.
- Commits: the work was committed and pushed to `main` instead of being left in the working tree.
- Project-scope install: `.omp/config.yml` was added, and `omp plugin link . --scope project` was tried
  first. It wrote to the user root despite the flag, so the entry was removed again with
  `omp plugin uninstall jev-decision-maker`; `~/.omp/plugins` holds no `jev-decision-maker` symlink or
  lock entry afterwards.
- Status line: added on request, sized by the Q&A round (readiness only, no runtime toggle, no cost
  counters), and it does not change what the tool sends or authorises.

## Configuration amendment

This accepted amendment supersedes the credential and setup-command requirements in **Runtime behavior**
and **Setup command** above.

The decision maker remains opt-in through `JEV_DECISION_MAKER=1`, but resolves its OpenRouter credential
through OMP's runtime `modelRegistry` for provider `openrouter`. It does not read, write, log, or fall
back to `process.env.OPENROUTER_API_KEY` itself. An unavailable resolver or missing credential returns
`main/missing_key` without a request. The extension performs a capability check rather than claiming a
version floor. An isolated RPC probe on the installed OMP 17.3.2 host confirmed that this resolver also
returns an exported `OPENROUTER_API_KEY`; the historical 18.2.6 measurements remain version-specific.

The status line uses the cheap `authStorage.peekApiKey("openrouter")` presence check. It never invokes
command-backed credential programs, refreshes OAuth, or performs a network request during session events;
full credential resolution occurs only when the decision maker executes.

`/setup-jev key` is removed. `/setup-jev enable` remains a project-local opt-in: it first refuses if the
launch-directory `.env` is tracked, without mutating the worktree. If the file is not ignored, it adds an
exact launch-directory `.env` pattern to the worktree-root `.gitignore` only when that pattern is absent,
then verifies `git check-ignore`. An ineffective existing rule is an error; no switch is written. Repeated
enables do not duplicate ignore patterns.

`enable --global` and `disable --global` remain unchanged as explicit global opt-ins. The unflagged
commands retain the project-local behavior above.

README, AGENTS.md, setup and plugin integration tests must describe and prove this contract. The historical
12-session batch remains invalid for acceptance: this policy change does not retroactively establish that
batch as evidence for the new implementation.

The exported-environment resolver probe ran in an isolated HOME. A separate stored-credential presence
probe ran under the operator's real HOME without exporting `OPENROUTER_API_KEY`; because it lacked a
pre-probe state fingerprint, it is not verification evidence and must not be repeated against real state.
