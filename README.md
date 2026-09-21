# JEV Decision Maker

An omp plugin that adds one tool: `decision_maker`. At a coding/debug branch point the main agent
supplies 2-5 candidate next steps and a TypeSafe System One model (Jev, through OpenRouter) picks
one. The tool executes nothing, writes no code and grants no permission; a `main` answer hands the
decision straight back to the agent.

## Install

Requires omp (verified on 18.2.6). Nothing is added to your project's dependencies.

```sh
omp plugin install github:hoaphm/jev-decision-maker         # shorthand
omp plugin install github:hoaphm/jev-decision-maker#main    # pinned ref
```

The repository is public, so installing needs no GitHub credential on the target machine. To work from
a clone instead:

```sh
git clone https://github.com/hoaphm/jev-decision-maker.git
omp plugin link ./jev-decision-maker
```

Verified with an empty git config, no token and no credential helper: `github:owner/repo`,
`github:owner/repo#main`, `git+https://…#main` and `ssh://git@…` all install the same package build,
register `decision_maker` only under `JEV_DECISION_MAKER=1`, and uninstall cleanly. While this
repository was private only the `ssh://` form worked - the others resolve through
`api.github.com/repos/<owner>/<repo>/tarball/`, which answers `404` without credentials - so use an
SSH spec (or a public repository) for any private plugin repo.

Project-native extension discovery only reads `<cwd>/.omp/extensions`, and this repository no longer
ships that directory: inside this repository the tool appears only after `omp plugin link .`, or for
one session via `-e src/decision-maker.ts`. No marketplace catalog is configured. Remove it again
with `omp plugin uninstall jev-decision-maker`.

Project scope, so this checkout always loads the plugin without touching your user profile: commit an
`.omp/config.yml` naming the module - which this repository does:

```yaml
# .omp/config.yml
extensions:
  - ./src/decision-maker.ts
```

`omp plugin link . --scope project` is **not** honoured by the link command. Measured on 18.2.6 it
reports success and writes the symlink into the user root (`~/.omp/plugins/node_modules/...`) instead,
so either use the project config above or accept a user-scope link.

Enable check: start omp in this checkout and read the status line. `◆ JEV on` means a call can reach the
model; `◆ JEV no key` means the switch is set but omp has no OpenRouter credential configured;
`◆ JEV off` means the project config did not load.

## Setup command

`/setup-jev` is registered whether or not the tool is enabled, so a fresh session can turn it on:

```sh
/setup-jev                    # switch, both env files, whether omp can resolve a credential, tool activeness
/setup-jev enable              # writes JEV_DECISION_MAKER=1 into ./.env (this checkout only)
/setup-jev enable --global     # ...into ~/.omp/agent/.env, which applies in every directory
/setup-jev disable [--global]
```

Measured rules the command follows:

- The command owns activation only, never a credential. `/setup-jev` reports whether omp can resolve an
  OpenRouter key for the session; configure that key in omp itself (its provider configuration or an
  exported `OPENROUTER_API_KEY` at launch), not through this plugin.
- A project `.env` is read from the launch directory exactly - omp does not walk parent directories, so
  `enable` from a checkout still needs `--global` when you launch from a subdirectory. The command says so
  when it writes.
- `enable` keeps a project switch out of git without mutating anything on a refusal: it refuses when the
  target `.env` is already tracked, otherwise it ensures the worktree `.gitignore` holds one exact
  launch-directory rule and re-checks `git check-ignore` before writing. `disable` leaves that rule alone.
- The process environment always wins over a `.env`. That is what keeps `JEV_DECISION_MAKER=0` - and the
  benchmark's baseline arm - authoritative.

## Enable

The tool is registered only for sessions started with the switch:

```sh
JEV_DECISION_MAKER=1 omp
```

`JEV_DECISION_MAKER` is the one variable this plugin reads from the environment, and only at registration.
The credential is not the plugin's: every call resolves the `openrouter` credential from omp's model
registry and sends it nowhere except the `Authorization` header - the plugin stores none, logs none, and
echoes none into tool output. Configure it in omp (an exported `OPENROUTER_API_KEY` is one of the sources
omp checks). Missing or blank resolution answers `main` / `missing_key` without a request. Every other
failure also returns control to the agent: nothing is retried, no endpoint is switched, and no other model
is substituted.

## Status line

Interactive sessions get one slot on the omp status line, written under the key `jev` and cleared when
the session ends. It reports what the session *can* do, never what it is *allowed* to do:

| Label | Meaning |
| --- | --- |
| `◆ JEV on` | opted in, omp reports a credential, tool active - a call can reach the model |
| `◆ JEV no key` | opted in but omp has no `openrouter` credential - every call answers `main`/`missing_key` |
| `◆ JEV inactive` | opted in with a credential, but the tool is not in this session's active tool set |
| `◆ JEV off` | not opted in - no tool is registered and nothing is ever sent |

The credential check is a presence peek only, so a lifecycle event can never run a command-backed key
program, refresh an OAuth token, or reach the network; the full provider resolver runs only for an actual
call.

omp strips ANSI from status text before rendering, so the marker is a plain glyph and any colour comes
from the status line itself. The label refreshes on session start/switch/branch/tree and after every
call. Print and `--mode json` runs have no UI context and write nothing; an RPC session has no terminal
but still serialises each write as an `extension_ui_request` frame.

## Bounds

- One request per call, 3 s timeout, no retries, at most 5 calls per session.
- A request carries only what the agent passes (goal, evidence, candidates) and is capped at 24 KiB.
  Responses are validated — model, provider, exact criteria keys, distribution summing to 1, unique
  maximum — before anything is reported; an invalid answer becomes `main`.
- `read` candidates need `p >= 0.90`; `edit` and `check` need `p >= 0.95`. These are experimental
  gates, not correctness or safety guarantees. The answer is a suggestion, never authorization: it
  does not approve a destructive, networked or account-changing action.
- Candidates are limited to read/edit/check steps, and the tool itself has no filesystem or shell
  access, so it cannot widen what the session is allowed to do.

## Layout

| Path | Role |
| --- | --- |
| `src/decision-maker.ts` | the plugin: `decide()`, the `decision_maker` tool and the status line |
| `rules/decision-maker.md` | usage policy distributed with the plugin |
| `tests/decision-maker.test.ts` | boundary guards for `decide()`; no network |
| `tests/plugin-install.test.ts` | link/uninstall and status-line proof in a throwaway HOME; no model turn |
| `scripts/benchmark-decision-maker.ts` | 3-fixture A/B benchmark plus its inference-free self-check |
| `docs/research/` | measurement protocol, raw results, transcripts |

## Checks

```sh
bun tests/decision-maker.test.ts
bun tests/setup-command.test.ts
bun tests/plugin-install.test.ts
bun scripts/benchmark-decision-maker.ts --self-check
```

All four run offline and start no model turn. The live benchmark (`bun scripts/benchmark-decision-maker.ts`)
is the one that spends money: 12 omp sessions, and the benchmark script itself needs
`OPENROUTER_API_KEY` in the environment.

The rendered status line itself was verified out of band in a real interactive session (a pty under an
isolated HOME with the plugin linked): `◆ JEV on` with the switch set, `◆ JEV off` without it. The
automated check covers the same labels through RPC, where omp serialises `setStatus` as an
`extension_ui_request` frame.

## Measurement status

The speed-up question is unanswered. The first measured batch never called the tool — its three
fixtures had no real branch point — and its credential handling fell outside the approved scope, so
it is recorded as invalid for acceptance rather than as a result. See
`docs/research/jev-decision-maker.md`.
