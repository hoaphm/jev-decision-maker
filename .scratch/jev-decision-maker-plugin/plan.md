# OMP Credential and Project Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project-local activation safely prepare its Git ignore rule and make the decision maker resolve OpenRouter credentials from OMP at runtime.

**Architecture:** `src/setup-command.ts` owns activation only: unflagged commands maintain a launch-directory switch and explicit `--global` commands retain the agent-wide switch. `src/decision-maker.ts` owns credential resolution: status uses OMP's cheap presence probe, while execution resolves the credential once through OMP and injects it into the existing HTTP boundary. No plugin path reads or writes `OPENROUTER_API_KEY` directly.

**Tech Stack:** Bun, TypeScript, Node `assert/strict`, OMP extension APIs, Git.

## Global Constraints

- Do not call OpenRouter, a model, or any inference endpoint during tests.
- Add no dependencies.
- `JEV_DECISION_MAKER=1` remains the sole registration switch.
- Resolve credentials from `ctx.modelRegistry` for provider `openrouter`; never fall back to `process.env.OPENROUTER_API_KEY` in plugin code.
- Use `authStorage.peekApiKey("openrouter")` for status; full resolution occurs only during tool execution.
- If the resolver capability or credential is unavailable, return `main/missing_key` without a request.
- Preserve explicit `enable --global` and `disable --global` behavior.
- For local enable, refuse a tracked `.env` before changing `.gitignore` or `.env`; append no duplicate ignore pattern.
- Historical inference artifacts remain invalid for acceptance and are not reclassified.
- Update `README.md` and `AGENTS.md` in the same implementation commit as the changed behavior.

---

### Task 1: Make local activation Git-safe and credential-free

**Files:**
- Modify: `src/setup-command.ts:1-200`
- Modify: `tests/setup-command.test.ts:1-217`

**Interfaces:**
- Consumes: `SetupContext.exec`, which runs Git as `Exec(file, args)` and returns `{ code, stdout, stderr }`.
- Produces: `runSetupCommand(args, ctx)` with `enable`, `disable`, `enable --global`, and `disable --global`; `key` is no longer a supported subcommand.
- Produces: `SetupContext.credentialPresent?: () => Promise<boolean>` for the command status report; callers omit it only in unit tests that assert a missing credential.

- [ ] **Step 1: Write the failing setup-command regressions**

Replace the `key` storage tests with these observable contracts:

```ts
await test("local enable ignores an untracked target once before writing the switch", async () => {
	const root = tempRoot();
	try {
		const cwd = join(root, "project", "nested");
		mkdirSync(cwd, { recursive: true });
		// Use an Exec stub that reports a worktree root, untracked target, initially-unignored target,
		// then ignored after the test observes `/.env` or `/nested/.env` in root/.gitignore.
		const report = await runSetupCommand("enable", { cwd, env: { HOME: root }, exec: gitFor(root, cwd) });
		assert.equal(report.level, "info");
		assert.equal(parseEnvFile(readFileSync(join(cwd, ".env"), "utf8")).get("JEV_DECISION_MAKER"), "1");
		assert.equal(readFileSync(join(root, "project", ".gitignore"), "utf8").split("\n").filter((line) => line === "/nested/.env").length, 1);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

await test("local enable never changes files when the target env file is tracked", async () => {
	const root = tempRoot();
	try {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".gitignore"), "# existing\n");
		const report = await runSetupCommand("enable", { cwd, env: { HOME: root }, exec: gitTrackedStub() });
		assert.equal(report.level, "error");
		assert.equal(existsSync(join(cwd, ".env")), false);
		assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "# existing\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
```

Add a repeat-enable assertion that the exact ignore pattern occurs once. Keep the existing global-switch mode `0600` assertion. Replace the credential-status test with an injected `credentialPresent: async () => true` and assert neither the report nor its lines contain a key value. Assert `/setup-jev key` returns the normal unknown-argument error and creates no agent `.env` credential file.

- [ ] **Step 2: Run the focused regression before implementation**

Run: `bun tests/setup-command.test.ts`

Expected: FAIL because local enable still refuses an unignored worktree and `key` still stores a credential.

- [ ] **Step 3: Implement the minimal activation flow**

Delete `CREDENTIAL_KEY`, `storeCredential()`, and the credential write paths. Keep `agentEnvPath()` only for explicit global switches. Add an async project preparation helper with this order:

```ts
async function prepareProjectEnvFile(ctx: SetupContext, path: string): Promise<string | null> {
	const worktree = await ctx.exec("git", ["rev-parse", "--show-toplevel"]);
	if (worktree.code !== 0) return null;
	const root = worktree.stdout.trim();
	const target = relative(root, path).replaceAll("\\", "/");
	if (!target || target.startsWith("../")) return `refusing to write ${path}: it is outside the Git worktree.`;
	const tracked = await ctx.exec("git", ["ls-files", "--error-unmatch", "--", target]);
	if (tracked.code === 0) {
		return `refusing to write ${path}: it is already tracked by Git; remove it from the index before enabling locally.`;
	}
	if (tracked.code !== 1) return `refusing to write ${path}: Git could not determine whether it is tracked.`;
	const initiallyIgnored = await ctx.exec("git", ["check-ignore", "--quiet", "--", target]);
	if (initiallyIgnored.code === 0) return null;
	if (initiallyIgnored.code !== 1) return `refusing to write ${path}: Git could not determine whether it is ignored.`;
	const pattern = `/${target}`;
	const ignorePath = join(root, ".gitignore");
	const current = readEnvFile(ignorePath);
	if (!current.split("\n").some((line) => line.trim() === pattern)) {
		writeFileSync(ignorePath, `${current.replace(/\n*$/, "\n")}${pattern}\n`);
	}
	const verified = await ctx.exec("git", ["check-ignore", "--quiet", "--", target]);
	if (verified.code === 0) return null;
	return verified.code === 1
		? `refusing to write ${path}: Git does not ignore it after updating ${ignorePath}.`
		: `refusing to write ${path}: Git could not verify the ignore rule.`;
}
```

Use this helper only from unflagged `enable` before `writeEnvFile`. Do not call it from `disable`: disabling only removes the switch and never removes a user-visible ignore rule. Make `status()` await `credentialPresent?.()` and report only `credential: configured` or `credential: missing`; remove all environment and agent-file credential reads. Change usage to `/setup-jev [enable|disable] [--global]`.

- [ ] **Step 4: Run the focused regression after implementation**

Run: `bun tests/setup-command.test.ts`

Expected: PASS. Local enable writes exactly one root-relative ignore pattern only after proving the target is untracked; global enable and disable still use the agent env file.

- [ ] **Step 5: Commit the setup-command change**

```bash
git add src/setup-command.ts tests/setup-command.test.ts
git commit -m "fix: prepare ignored project activation"
```

### Task 2: Resolve credentials through the OMP extension context

**Files:**
- Modify: `src/decision-maker.ts:1-457`
- Modify: `tests/decision-maker.test.ts:1-548`

**Interfaces:**
- Consumes: `ExtensionContext.modelRegistry.getApiKeyForProvider("openrouter", sessionId, { signal })` during tool execution.
- Consumes: `ExtensionContext.modelRegistry.authStorage.peekApiKey("openrouter")` for lifecycle status and setup-command status.
- Produces: `DecideOptions.resolveApiKey?: () => Promise<string | undefined>`; omitted or blank results return `main/missing_key` before fetch.
- Produces: tool execution that passes the context resolver to `decide()` and never reads `process.env.OPENROUTER_API_KEY`.

- [ ] **Step 1: Write failing decision-maker tests**

Replace process-environment setup with an injected resolver:

```ts
const resolveKey = async (): Promise<string | undefined> => KEY;
const result = await decide(input(), { fetch: impl, resolveApiKey: resolveKey });
assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);

const missing = await decide(input(), { fetch: impl, resolveApiKey: async () => undefined });
assert.equal(missing.reason, "missing_key");
assert.equal(calls.length, 0);
```

Make the registration stub supply a context with both methods. Add a status test where `peekApiKey()` returns `KEY` and `getApiKeyForProvider()` throws; lifecycle status must still write `◆ JEV on`, proving status never runs the full resolver. Add a tool execution test where the full resolver is called once, the injected fetch receives the bearer key, and status refreshes from `peekApiKey()` afterward.

- [ ] **Step 2: Run the focused decision boundary test before implementation**

Run: `bun tests/decision-maker.test.ts`

Expected: FAIL because `decide()` still reads `process.env.OPENROUTER_API_KEY` and lifecycle status synchronously reads the same variable.

- [ ] **Step 3: Implement context-owned credential resolution**

Change `DecideOptions` and the credential guard to:

```ts
export type DecideOptions = {
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	budget?: { remaining: number };
	resolveApiKey?: () => Promise<string | undefined>;
};

const apiKey = await options.resolveApiKey?.();
if (!apiKey?.trim()) return failure("missing_key", started);
```

Import OMP's `ExtensionContext` as a type and replace the narrow status context with the required `ui`, `modelRegistry`, and `sessionManager` capabilities. Make `refreshStatus` async and derive `hasKey` exclusively from `ctx.modelRegistry.authStorage.peekApiKey("openrouter")`; treat throws as absent. On lifecycle hooks, `await refreshStatus(ctx)`. In `execute`, create a resolver that calls `ctx.modelRegistry.getApiKeyForProvider("openrouter", ctx.sessionManager.getSessionId?.(), { signal })`, pass it to `decide`, and await the subsequent status refresh. Pass the same cheap presence callback into `runSetupCommand` for slash-command status.

Keep `JEV_DECISION_MAKER` as the process-environment registration switch. Do not change endpoint, model, timeout, request body, response validation, quotas, or thresholds.

- [ ] **Step 4: Run the focused decision boundary test after implementation**

Run: `bun tests/decision-maker.test.ts`

Expected: PASS. All HTTP boundary tests provide a resolver; missing and unavailable resolver paths make zero fetch calls; status never invokes full key resolution.

- [ ] **Step 5: Commit the resolver cutover**

```bash
git add src/decision-maker.ts tests/decision-maker.test.ts
git commit -m "feat: resolve decision credentials through omp"
```

### Task 3: Update isolated integration proof and operator documentation

**Files:**
- Modify: `tests/plugin-install.test.ts:53-420`
- Modify: `README.md:50-148`
- Modify: `AGENTS.md:17-27`

**Interfaces:**
- Consumes: the project-local activation contract from Task 1 and context credential resolution from Task 2.
- Produces: an offline isolated-HOME proof of OMP env-backed credential resolution and operator instructions that name OMP, not plugin-owned credentials.

- [ ] **Step 1: Write failing integration and documentation assertions**

In `tests/plugin-install.test.ts`, remove the `/setup-jev key` command and agent credential-file assertions. Keep the isolated environment's placeholder `OPENROUTER_API_KEY`; it is resolved by OMP, not the plugin. Assert that `/setup-jev enable --global` still writes only `JEV_DECISION_MAKER=1` to the agent env file, and that local enable writes its project switch without starting an agent turn. Update README assertions so they require `JEV_DECISION_MAKER`, `OMP-managed` or `OMP configuration`, `enable --global`, and the status labels; they must not require `/setup-jev key`.

- [ ] **Step 2: Run the integration proof before documentation changes**

Run: `bun tests/plugin-install.test.ts`

Expected: FAIL because the test still invokes the removed `key` command and README still states that both variables must be exported directly for registration.

- [ ] **Step 3: Update docs and integration behavior**

In `README.md`:

```md
/setup-jev enable              # records a project-local switch; creates the exact Git ignore rule when needed
/setup-jev enable --global     # records an explicit machine-wide switch
/setup-jev disable [--global]
```

State that `JEV_DECISION_MAKER=1` controls tool registration, while OMP resolves OpenRouter credentials from its configured provider sources. State that `◆ JEV no key` means OMP reports no credential through the cheap presence check. Remove every `/setup-jev key` instruction and every claim that the plugin reads a key from process environment at call time. Retain the benchmark's separate environment requirement only where the benchmark script itself consumes it.

In `AGENTS.md`, replace the two-variable launch requirement with: the plugin registers with `JEV_DECISION_MAKER=1`; calls require an OpenRouter credential configured for OMP; missing configuration returns `main/missing_key` without a request.

Keep `rules/decision-maker.md` unchanged because it contains tool-usage authorization policy, not credential configuration.

- [ ] **Step 4: Run integration and offline regression checks**

Run:

```bash
bun tests/setup-command.test.ts
bun tests/decision-maker.test.ts
bun tests/plugin-install.test.ts
bun scripts/benchmark-decision-maker.ts --self-check
```

Expected: all commands pass offline; no agent turn or inference request occurs in the plugin-install proof.

- [ ] **Step 5: Commit integration proof and documentation**

```bash
git add tests/plugin-install.test.ts README.md AGENTS.md
git commit -m "docs: describe omp-managed decision credentials"
```

## Plan Self-Review

- **Spec coverage:** Task 1 covers exact project-local ignore preparation, tracked-file refusal, duplicate prevention, and preserved global activation. Task 2 covers OMP-only credential resolution, cheap status probing, capability failure, and no fallback. Task 3 updates all named user-facing docs and proves the isolated integration path. Historical evidence is preserved and not reclassified.
- **Placeholder scan:** No TBD, TODO, deferred behavior, or unspecified error handling remains.
- **Type consistency:** `resolveApiKey` is the only `decide()` credential seam; `credentialPresent` is the only setup-command status seam; both return a key-presence result without exposing key material.
