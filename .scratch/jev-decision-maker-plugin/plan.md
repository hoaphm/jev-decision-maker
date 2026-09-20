# JEV Decision Maker Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the JEV Decision Maker a Git-installable OMP plugin and correct the quota/evidence defects without new inference.

**Architecture:** A root OMP package manifest names `src/decision-maker.ts` as the extension entrypoint. The package ships a conventional `rules/` runtime policy and uses OMP’s plugin manager for link/Git installation. The JSONL transcripts stay immutable and hash-pinned; the report and results JSON are intentionally annotated as invalid for acceptance, and a correction section supersedes their acceptance claims.

**Tech Stack:** Bun 1.4.2, TypeScript, OMP 18.2.6 extension/plugin APIs, Node `assert/strict`, OMP RPC mode.

**Spec:** `.scratch/jev-decision-maker-plugin/spec.md` (repo convention: `docs/agents/issue-tracker.md`)

## Global Constraints

- Do not call OpenRouter, any model, or any inference endpoint.
- Do not call `omp token`, read OMP credential stores, publish a package, create a remote, commit, or alter real user/project plugin state.
- OMP plugin manifest: `package.json#omp.extensions` must point to `./src/decision-maker.ts`.
- Budget resets only for `start`, `switch`, `branch`, and `tree`; cap remains five calls per session.
- Preserve existing `docs/research/jev-decision-maker-results.json`, `docs/research/jev-decision-maker.md`, and `docs/research/jev-runs/` byte-for-byte as historical artifacts.
- Test only with `bun tests/decision-maker.test.ts`, `bun scripts/benchmark-decision-maker.ts --self-check`, and the isolated plugin-link/RPC test.
- Do not install dependencies.

---

### Task 1: Establish package and lifecycle regression tests

**Files:**
- Modify: `tests/decision-maker.test.ts`
- Create: `tests/plugin-install.test.ts`

**Interfaces:**
- Consumes: current exported `decide`, `CALL_LIMIT`, `DEFER_ID`, candidate types.
- Produces: a failing import of `BUDGET_RESET_REASONS` from `../src/decision-maker.ts`; an isolated OMP plugin-link test that requires a root `package.json` with an `omp.extensions` entry.

- [ ] **Step 1: Point the existing guard test at the desired package entrypoint and state the lifecycle contract**

```ts
import {
  BUDGET_RESET_REASONS,
  CALL_LIMIT,
  DEFER_ID,
  decide,
  type Candidate,
  type DecisionInput,
} from "../src/decision-maker.ts";

await test("only lifecycle boundaries reset the session budget", async () => {
  assert.deepEqual(BUDGET_RESET_REASONS, ["start", "switch", "branch", "tree"]);
});
```

- [ ] **Step 2: Write the isolated plugin-link integration test**

The test creates one `mkdtemp` root, gives OMP only temporary `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`, then runs:

```ts
const link = await run(["omp", "plugin", "link", repo], tempDir, env);
assert.equal(link.code, 0, link.stderr);

const rpc = await runRpcGetState(tempWorkspace, env);
assert.equal(rpc.frames.some(frame => frame.type === "agent_start"), false);
assert.ok(
  rpc.state.data.dumpTools.some((tool: { name: string }) => tool.name === "decision_maker"),
);
```

`runRpcGetState` supplies exactly one JSONL `get_state` command to `omp --mode rpc --no-session --no-title --no-skills --no-rules`; it must not send a prompt. `finally` removes the full temporary root.

- [ ] **Step 3: Run the two tests and confirm red**

Run:

```text
bun tests/decision-maker.test.ts
bun tests/plugin-install.test.ts
```

Expected: the first fails because `../src/decision-maker.ts` does not exist; the second fails because the repository has no `package.json` plugin manifest. Neither process may emit `agent_start` or an inference request.

### Task 2: Package the extension and fix quota reset behavior

**Files:**
- Create: `package.json`
- Create: `src/decision-maker.ts` by moving `.omp/extensions/decision-maker.ts`
- Create: `rules/decision-maker.md`
- Create: `README.md`
- Remove: `.omp/extensions/decision-maker.ts`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`
- Modify: `scripts/benchmark-decision-maker.ts`

**Interfaces:**
- Consumes: `BUDGET_RESET_REASONS` from Task 1 and OMP’s plugin manifest loader.
- Produces: installable package `jev-decision-maker`; extension path `src/decision-maker.ts`; runtime rule `rules/decision-maker.md`.

- [ ] **Step 1: Add the minimal manifest**

```json
{
  "name": "jev-decision-maker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "omp": {
    "extensions": ["./src/decision-maker.ts"]
  }
}
```

No scripts, dependencies, package manager lockfile, marketplace metadata, or publish configuration.

- [ ] **Step 2: Move the extension and constrain reset events**

Move the complete module to `src/decision-maker.ts`. Near `CALL_LIMIT`, add and export:

```ts
export const BUDGET_RESET_REASONS = ["start", "switch", "branch", "tree"] as const;
```

Replace the broad lifecycle branch with:

```ts
if (BUDGET_RESET_REASONS.includes(reason as (typeof BUDGET_RESET_REASONS)[number])) {
  budget.remaining = CALL_LIMIT;
}
```

Do not change HTTP behavior, thresholds, API key lookup, request schema, or call-limit decrement behavior.

- [ ] **Step 3: Add the package runtime rule and source documentation**

`rules/decision-maker.md` defines the activation boundary: genuine coding/debug branch point; 2–5 evidence-backed candidates; selected is not authorization; `main` returns reasoning to the main agent; no fake branch points or obvious steps.

Replace the detailed `AGENTS.md` Decision maker section with one pointer to `rules/decision-maker.md`, avoiding two divergent policies. Update `CONTEXT.md` to name `src/decision-maker.ts` as the implementation path.

`README.md` documents:

```text
omp plugin link /absolute/path/to/JEV-omp
omp plugin install github:OWNER/JEV-omp#main
```

It requires OMP 18.2.6+, Bun 1.4.2+, `JEV_DECISION_MAKER=1`, and an already-exported `OPENROUTER_API_KEY`; it never suggests secret-store commands. It warns that `JEV_DECISION_MAKER=1 omp` in an unlinked source checkout does not discover `src/` automatically; use plugin link or `-e /absolute/path/to/src/decision-maker.ts`.

- [ ] **Step 4: Update the executable benchmark source path only**

Change:

```ts
const EXTENSION = join(REPO, ".omp", "extensions", "decision-maker.ts");
```

to:

```ts
const EXTENSION = join(REPO, "src", "decision-maker.ts");
```

Do not edit paths inside `docs/research/`; they describe the historical run.

- [ ] **Step 5: Run green checks**

Run:

```text
bun tests/decision-maker.test.ts
bun tests/plugin-install.test.ts
```

Expected: all guard checks pass; OMP links only in temporary XDG state; `get_state` lists `decision_maker`; no `agent_start` frame exists.

### Task 3: Correct the benchmark evidence and pin the immutable transcripts

**Files:**
- Create: `docs/research/jev-decision-maker-correction.md`

**Interfaces:**
- Consumes: historical raw artifacts under `docs/research/` and the approved credential constraint.
- Produces: the authoritative correction for acceptance/readers.

- [ ] **Step 1: Add the correction record**

State all of the following explicitly:

- The 12-session live batch and one live endpoint probe are invalid for acceptance because the credential was retrieved through an OMP secret-store command, not provided as `OPENROUTER_API_KEY` by the user.
- The 12 JSONL transcripts are the immutable evidence set: untouched since the run and hash-pinned in
  `docs/research/jev-decision-maker-evidence.sha256`.
- `docs/research/jev-decision-maker.md` and `jev-decision-maker-results.json` are **deliberately
  annotated** (correction section; three added top-level keys) and are therefore *not* byte-stable.
- Live proof is missing; only local guard tests, fixture self-check, and no-inference plugin discovery are accepted after this correction.
- Remove authority from the original “average six tool calls” claim: the runner did not record total tool calls for the batch, so no average is asserted.
- No conclusion about speed, task quality under JEV, model cost, endpoint latency, or JEV selection is accepted from the invalid batch.

- [ ] **Step 2: Verify which artifacts are immutable and which are annotated**

Write the transcript manifest, verify it, and record the annotation delta:

```sh
cd docs/research && sha256sum jev-runs/*.jsonl > jev-decision-maker-evidence.sha256
sha256sum -c jev-decision-maker-evidence.sha256        # 12/12 OK
stat -c '%y %n' jev-runs/*.jsonl                        # all mtimes inside the run window
```

Expected: the 12 transcripts verify OK and predate the correction edits. The report and the results JSON
are expected to differ from their pre-correction state - that is the point of Task 3 - so they must be
described as annotated, never as unchanged. For the JSON, prove content equality by parsing, dropping
`validity`/`validityReason`/`credentialSource`, and comparing against the pre-edit parse.

### Task 4: Run final local verification

**Files:**
- Verify: `tests/decision-maker.test.ts`
- Verify: `tests/plugin-install.test.ts`
- Verify: `scripts/benchmark-decision-maker.ts`

**Interfaces:**
- Consumes: packaged manifest/source/rule and correction from Tasks 1–3.
- Produces: reproducible local evidence without inference or real plugin state mutation.

- [ ] **Step 1: Run guard tests**

Run:

```text
bun tests/decision-maker.test.ts
```

Expected: every existing guard plus the exact reset-reasons assertion passes.

- [ ] **Step 2: Run fixture self-check**

Run:

```text
bun scripts/benchmark-decision-maker.ts --self-check
```

Expected: each seeded fixture fails both checks; each oracle passes both; no OMP/inference is launched.

- [ ] **Step 3: Run isolated package integration**

Run:

```text
bun tests/plugin-install.test.ts
```

Expected: temporary XDG plugin link succeeds; RPC `get_state` lists `decision_maker`; no `agent_start`; temporary directory removed.

- [ ] **Step 4: Scope review**

Confirm the only implementation additions/changes are the manifest, moved source, runtime rule, README, tests, source-path update, AGENTS/CONTEXT pointers, correction section, transcript hash manifest, and planning docs under `.scratch/`. Confirm the 12 transcripts verify against `jev-decision-maker-evidence.sha256`, that the report and results JSON changed **only** by the intended annotation, that no plugin state was written outside the isolated HOME (both `~/.omp/plugins` and `$XDG_DATA_HOME/omp/plugins` fingerprinted), that no remote exists, and that no commit was made.
