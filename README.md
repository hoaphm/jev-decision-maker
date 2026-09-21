# JEV Decision Maker

An omp plugin that adds one tool: `decision_maker`. At a coding/debug branch point the main agent
supplies 2-5 candidate next steps and a TypeSafe System One model (Jev, through OpenRouter) either
picks one (`mode: "select"`) or rates them all against one rubric (`mode: "score"`) - in a single
request either way. The tool executes nothing, writes no code and grants no permission; a `main`
answer hands the decision straight back to the agent.

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

## Modes

One call is one request. `mode` is required and has no default.

`select` picks the best next step from 2-5 candidates, each `{id, kind, action, expected}`:

```json
{
  "mode": "select",
  "goal": "Fix the shared expiry comparison",
  "state": "The seeded helper serves a value exactly at expiresAt; both callers route through it.",
  "candidates": [
    {"id": "repair", "kind": "edit", "action": "Change > to >= in the shared helper", "expected": "The boundary case returns the default"},
    {"id": "inspect", "kind": "read", "action": "Read both callers", "expected": "Both callers are confirmed to share the helper"}
  ]
}
```

`score` rates every candidate against one ordered rubric, worst level first. The state is sent once and
each candidate gets its own question inside that same request:

```json
{
  "mode": "score",
  "goal": "Choose the cache repair that preserves the stated contract",
  "state": "Tenants can share ids; undefined is a valid cached value; a throwing loader must not cache.",
  "candidates": [
    {"id": "tuple-key", "kind": "edit", "action": "Key on JSON.stringify([tenantId, id])", "expected": "Tenant/id pairs stop sharing entries"},
    {"id": "colon-key", "kind": "edit", "action": "Join tenant and id with a colon", "expected": "One key per tenant/id pair"}
  ],
  "rubric": ["Contradicts a stated requirement", "Required behaviour left unspecified", "Directly supported"]
}
```

Answers are typed, never prose:

| Answer | What it means |
| --- | --- |
| `{"status":"selected","candidateId":"repair","probability":0.96,"confidence":0.93}` | carry that candidate out with your normal tools |
| `{"status":"scored","scores":[{"candidateId":"tuple-key","score":2,"probabilities":{"0":0,"1":0,"2":1},"confidence":1}]}` | every candidate rated; nothing was chosen for you |
| `{"status":"main","reason":"deferred" \| "uncertain" \| "missing_key" \| ...}` | the decision is back with the agent |

`score` is the probability-weighted rubric index (`0 .. rubric.length - 1`). It orders candidates
against *that* rubric; it is not a probability that a candidate is correct and it does not compare
across different rubrics. `confidence` is computed from the shape of the distribution the answer
already carries, so it is a second look at the same numbers, not independent evidence.


The status line tells you what the session can do before any call; see [Status line](#status-line) for the
four labels and what they do and do not promise.

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
| `◆ JEV on` | opted in, omp reports a credential, tool active - readiness only, not proof that the endpoint answered |
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

- One request per call, whichever mode it uses: a 5-candidate `score` batch is still one request and
  one slot of the 5 calls per session. 3 s timeout, no retries.
- The 3 s deadline covers the credential lookup, the request and the body read. A provider resolver
  that hangs, throws or ignores cancellation ends the call as `timeout`, `missing_key` or `cancelled`
  - it cannot hold the tool open, and a credential that arrives late never sends a request. A
  `models.yml` key that shells out (`!command`) therefore shares that same 3 s: a key program slower
  than that turns every call into `main`/`timeout` until it is replaced with a literal key.
- A request carries only what the agent passes (goal, evidence, candidates, rubric) and is capped at
  24 KiB; a rubric is 2-5 levels. Responses are validated - model, provider, exactly the questions
  that were asked, distributions summing to 1, and a score matching its own distribution - before
  anything is reported. One bad answer voids the whole batch: there is no partial success.
- `select` needs `p >= 0.90` for a `read` candidate and `p >= 0.41` for `edit`/`check`: measured, not
  guessed (see `docs/adr/0002-measured-probability-thresholds.md`). The old 0.95 gates were starving the
  tool - `edit` committed 3 of 27 correct picks - and the loosening drops the risky `edit` gate below the
  safe `read` one, which is a property of the fixture set, not a policy. They are still experimental gates,
  not correctness or safety guarantees. Naming one of several equal maxima comes
  back as `main`/`uncertain` with the distribution kept rather than as a malformed answer.
- The answer is a suggestion, never authorization: it does not approve a destructive, networked or
  account-changing action, and it is not a test oracle - a deterministic check still outranks it.
  Text from files, logs or issues that the agent puts in `state` is untrusted input; the wording in
  the prompt lowers the risk of being steered by it, it is not a security boundary.
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
is the one that spends money: 12 omp sessions. It holds no credential of its own - the plugin resolves
the `openrouter` credential through omp's provider configuration, so configure it in omp (one of the
sources omp checks is an exported `OPENROUTER_API_KEY`).

The rendered status line itself was verified out of band in a real interactive session (a pty under an
isolated HOME with the plugin linked): `◆ JEV on` with the switch set, `◆ JEV off` without it. The
automated check covers the same labels through RPC, where omp serialises `setStatus` as an
`extension_ui_request` frame.

## Measurement status

Two batches have run, and neither shows the tool paying for itself.

- The first (`docs/research/jev-decision-maker.md`) never called the tool: its fixtures had no real
  branch point, and its credential handling fell outside the approved scope, so it is recorded as
  invalid for acceptance rather than as a result.
- The second ran 12 sessions with the baseline arm interleaved, on two judgement fixtures. What it
  actually exercised: `score` was called **once** (`patch-shortlist-2J`) and worked - one request, five
  candidates, one rubric, 636 ms, $0.000063, and it ranked the intended repair first (3.19 vs 0.57).
  `select` was exercised only by the smoke's direct `decide()` call (1 request, 1.001 s, $0.000026,
  chose the intended `cache-identity`), never through the tool inside a session: `diagnostic-selection`
  had zero calls in all six sessions, which is the designed outcome for a task whose evidence already
  excludes the other options.
- Quality is therefore a ceiling, not a result: both arms answered correctly in all 12 sessions
  (the main model solved both fixtures alone), and 5 of 6 treatment sessions never called the tool, so
  each median time ratio is computed over pairs where JEV contributed nothing - no JEV effect is
  estimable here. The one session that did call was 2.02x its baseline pair, but JEV's own round-trip
  was 636 ms of a +22.2 s difference, so that is agent-side, not tool-side.
- The mechanism claim cannot be made from this batch: sessions ran with `--no-rules`, so
  `rules/decision-maker.md` never reached the model. What was measured is the invocation rate the tool
  description plus the task policy alone provoke - not the shipped policy.

So: the endpoint, the one-request batch shape and the validation path are measured working; the
*benefit* is not demonstrated, and the thresholds were still guesses at that point. Do not read them, or the per-session call limit, as validated by
this. The 32-request ceiling is arithmetic rather than enforced: the plugin's own five-calls-per-session
limit bounds spend, and the count is reconciled after each session. Raw artifacts for all three attempts
(each abort spent real requests) are committed under `docs/research/jev-effective-runs/`, with
`attempts.md` as the ledger.

A fourth protocol (`docs/research/jev-effective-protocol-4/`) measured the gates directly: 180 calls
through the real resolver, the first batch whose failure count stayed inside the frozen limit. Its
rejected-body capture answered the question three earlier runs could not - the one `invalid_response` was
**our** validator rejecting a valid answer whose probabilities summed to 0.99, not the endpoint breaking
its shape - and the sweep it fed is what the gates above come from. `read` kept its old value because its
hold-out was too thin to decide, so the sweep's own volume floor refused it.

The next batch is already specified, frozen and implemented in
`docs/research/jev-effective-protocol-2/`: a direct-call judgement benchmark (30 graded forks, 70
calls, no agent) that measures top-1 accuracy and how often the 0.90/0.95 gates refuse to commit, plus
an 18-session three-arm run whose arm `E` calls a schema-identical empty tool - the control both
previous reports named as missing, with its response labelled `control` so it can never be mistaken for
the model declining. `runner.ts --self-check` verifies the case oracles, both fixture graders, the
control/real schema parity and the reason classification, offline. Its decision rules are fixed before
the first paid request, and any edit to them makes the numbers a new protocol's, not that one's.
