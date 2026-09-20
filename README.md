# JEV Decision Maker

An omp plugin that adds one tool: `decision_maker`. At a coding/debug branch point the main agent
supplies 2-5 candidate next steps and a TypeSafe System One model (Jev, through OpenRouter) picks
one. The tool executes nothing, writes no code and grants no permission; a `main` answer hands the
decision straight back to the agent.

## Install

Requires omp (verified on 18.2.6). Nothing is added to your project's dependencies.

```sh
omp plugin link .                     # from a clone of this repository
omp plugin install <git-url>          # from a Git remote, once this repository has one
```

Project-native extension discovery only reads `<cwd>/.omp/extensions`, and this repository no longer
ships that directory: inside this repository the tool appears only after `omp plugin link .`, or for
one session via `-e src/decision-maker.ts`. No marketplace catalog is configured. Remove it again
with `omp plugin uninstall jev-decision-maker`.

## Enable

The tool is registered only for sessions started with both variables:

```sh
JEV_DECISION_MAKER=1 OPENROUTER_API_KEY=... omp
```

`OPENROUTER_API_KEY` is read from the environment at call time. It is never persisted, never logged,
never echoed into tool output, and sent nowhere except the `Authorization` header. Keep it out of
argv, prompts and fixtures: a key that reaches a command line or a prompt is visible to process
listings and transcripts. Missing or blank key answers `main` / `missing_key` without a request.
Every other failure also returns control to the agent: nothing is retried, no endpoint is switched,
and no other model is substituted.

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
| `src/decision-maker.ts` | the plugin: exported `decide()` plus the `decision_maker` tool |
| `rules/decision-maker.md` | usage policy distributed with the plugin |
| `tests/decision-maker.test.ts` | boundary guards for `decide()`; no network |
| `tests/plugin-install.test.ts` | link/uninstall proof in a throwaway HOME; starts no model turn |
| `scripts/benchmark-decision-maker.ts` | 3-fixture A/B benchmark plus its inference-free self-check |
| `docs/research/` | measurement protocol, raw results, transcripts |

## Checks

```sh
bun tests/decision-maker.test.ts
bun tests/plugin-install.test.ts
bun scripts/benchmark-decision-maker.ts --self-check
```

All three run offline. The live benchmark (`bun scripts/benchmark-decision-maker.ts`) is the one
that spends money: it runs 12 omp sessions and needs `OPENROUTER_API_KEY` in the environment.

## Status

The speed-up question is unanswered. The first measured batch never called the tool — its three
fixtures had no real branch point — and its credential handling fell outside the approved scope, so
it is recorded as invalid for acceptance rather than as a result. See
`docs/research/jev-decision-maker.md`.
