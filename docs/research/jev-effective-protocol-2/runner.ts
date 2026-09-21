/**
 * Protocol v2 runner — judgement measurement for the JEV decision maker.
 *
 * Read `docs/research/jev-effective-protocol-2/protocol.md` first: this file implements §2–§5 of it and adds no
 * decision of its own. Every threshold, arm, order and abort rule below is copied from that document; if
 * they ever disagree, the document wins and this file is wrong.
 *
 * Offline, no inference:
 *   bun runner.ts --self-check
 *
 * Paid, in this order:
 *   bun runner.ts --stage1     # 70 direct decide() calls through a temp extension, no agent
 *   bun runner.ts --stage2     # 18 sessions, arms B / J / E
 *
 * Re-render a finished run (the output path is required and must not exist):
 *   bun runner.ts --render <results.json> <out.md>
 */

import { PROBABILITY_THRESHOLDS } from "../../../src/decision-maker.ts";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const RUNNER_PATH = import.meta.path;
const LOCAL_DIR = dirname(RUNNER_PATH);
const REPO = resolve(LOCAL_DIR, "..", "..", "..");
const EXTENSION = join(REPO, "src", "decision-maker.ts");
const STUB_EXTENSION = join(LOCAL_DIR, "stub-extension.ts");
const CASES_PATH = join(LOCAL_DIR, "cases.json");
const RULES_PATH = join(REPO, "rules", "decision-maker.md");
const ARTIFACTS = join(LOCAL_DIR, "runs");
/** Protocol v3 reuses this protocol's frozen fixtures and owns its own artefacts. */
const V3_DIR = join(REPO, "docs", "research", "jev-effective-protocol-3");
const V3_ARTIFACTS = join(V3_DIR, "runs");
const V4_DIR = join(REPO, "docs", "research", "jev-effective-protocol-4");
const V4_ARTIFACTS = join(V4_DIR, "runs");
const V5_DIR = join(REPO, "docs", "research", "jev-effective-protocol-5");
const V5_ARTIFACTS = join(V5_DIR, "runs");
/** Health window: the opening calls must be clean or the batch stops before spending the rest. */
const V3_HEALTH_FIRST = 10;
/** Consecutive provider faults that end a batch early, so an outage cannot burn the tail. */
const V3_FAIL_FAST = 5;
const REAL_AGENT_DIR = join(process.env.HOME ?? "", ".omp", "agent");
const REAL_MODELS_YML = join(REAL_AGENT_DIR, "models.yml");
const REAL_AGENT_DB = join(REAL_AGENT_DIR, "agent.db");

const MAIN_PROVIDER = "9router";
const MAIN_MODEL_ID = "cx/gpt-5.6-terra";
const MAIN_MODEL = `${MAIN_PROVIDER}/${MAIN_MODEL_ID}:high`;
const TOOL_NAME = "decision_maker";
const JEV_MODEL_PREFIX = "typesafe/jev-";
const PUBLIC_TEST = "tests/check.mjs";

const SESSION_TIMEOUT_MS = 190_000;
const SESSION_MAX_TIME = "3m";
const CHECK_TIMEOUT_MS = 10_000;
const RPC_DEADLINE_MS = 60_000;
/** Gap between direct calls: enough for a provider rate limit, cheap next to a 120-call batch. */
const PACE_MS = 150;
/** Stage 1 issues ~70 sequential calls in one handler, so its own deadline is much longer. */
const STAGE1_DEADLINE_MS = 600_000;
const NOTIFY_GRACE_MS = 2_000;

const STAGE2_DOSSIERS = ["cache-isolation", "retry-amplification"];
const STAGE2_REPEATS = [1, 2, 3];
/** Only these forks get a position-permuted repeat; the repeat exists to measure order sensitivity. */
const PERMUTED_FORKS = ["F1", "F2", "F3", "F4", "F5", "F6", "F13", "F16", "F22", "F28"];
const ARMS: Arm[] = ["B", "J", "E"];
const BASELINE_TOOLS = ["read", "write", "bash"];
const TREATMENT_TOOLS = ["read", "write", "bash", TOOL_NAME];

/** §3.3 of the protocol, verbatim. Each arm holds each position once per dossier. */
const ORDERS: Record<string, Array<{ dossier: string; repeat: number; arm: Arm }>> = {
	stage2: [
		{ dossier: "cache-isolation", repeat: 1, arm: "B" },
		{ dossier: "cache-isolation", repeat: 1, arm: "J" },
		{ dossier: "cache-isolation", repeat: 1, arm: "E" },
		{ dossier: "cache-isolation", repeat: 2, arm: "E" },
		{ dossier: "cache-isolation", repeat: 2, arm: "J" },
		{ dossier: "cache-isolation", repeat: 2, arm: "B" },
		{ dossier: "cache-isolation", repeat: 3, arm: "B" },
		{ dossier: "cache-isolation", repeat: 3, arm: "J" },
		{ dossier: "cache-isolation", repeat: 3, arm: "E" },
		{ dossier: "retry-amplification", repeat: 1, arm: "E" },
		{ dossier: "retry-amplification", repeat: 1, arm: "B" },
		{ dossier: "retry-amplification", repeat: 1, arm: "J" },
		{ dossier: "retry-amplification", repeat: 2, arm: "J" },
		{ dossier: "retry-amplification", repeat: 2, arm: "E" },
		{ dossier: "retry-amplification", repeat: 2, arm: "B" },
		{ dossier: "retry-amplification", repeat: 3, arm: "B" },
		{ dossier: "retry-amplification", repeat: 3, arm: "E" },
		{ dossier: "retry-amplification", repeat: 3, arm: "J" },
	],
};

/**
 * The frozen analysis contract. Hashed into `freeze.json` so a later median, re-bucketing or threshold
 * edit is visible as a new protocol rather than as a quiet second look at the same numbers.
 */
const METRIC_RULES = {
	protocol: "jev-effective-protocol-2",
	stage1: {
		callCount: 70,
		forks: 30,
		viewsPerFork: ["select", "score", "score-permuted"],
		permutedForks: PERMUTED_FORKS,
		itemCorrect: "select picks the oracle AND the score view's sole top is the oracle; a call that errored counts as not picked",
		commitRate: "calls whose status is selected or scored, over all calls (unit: CALLS, not forks)",
		commitBar: "commitCalls >= 20 of 70 calls, the same number the report prints",
		usefulIf: "itemCorrect >= 24/30 AND commitCalls >= 20/70 calls AND clientFailures <= 3",
		stopIf: "itemCorrect <= 19/30",
		refuseIf: "commitCalls < 20/70 while itemCorrect >= 24/30 means the gates block, not the model",
		clientFailureLimit: 3,
		authoringErrors: "invalid_input is an authoring error, never a client failure: it is rejected before the resolver and before the network",
		positionFlips: "permuted answer differs from unpermuted answer, reported per fork",
	},
	stage2: {
		sessions: 18,
		forkDecisionsPerArm: 18,
		primary: "fork accuracy per arm over 18 fork-decisions (9 per dossier)",
		adoptionComparable: "call rate on the FIRST fork only; later forks are a decay curve",
		attribution: "median(deltaJ) - median(deltaE), where deltaArm = agentMs(arm) - agentMs(B) per pair",
		controlRules: [
			"arm E results carry reason `control` and are never merged with J's refusals",
			"arm E reports stubDeferrals and stubCalls separately from J's real counters",
			"latencyMs and costUsd of a control answer are stub constants, labelled as such",
		],
		stopInvestingIf: "forkAccuracy(J) <= forkAccuracy(B) and forkAccuracy(E) ~ forkAccuracy(B)",
		notDefaultIf: "forkAccuracy(J) > forkAccuracy(B) but attribution >= 0",
		hookIf: "first-fork call rate < 3/6: the trigger mechanism is the blocker, not the thresholds",
		clientFailureLimit: 3,
		noSignificanceLanguage: true,
	},
} as const;

const USAGE = `usage: bun ${RUNNER_PATH} --self-check | --stage1 | --stage2 | --v3 | --v4 | --v5 | --render <results.json> <out.md>`;

type Arm = "B" | "J" | "E";

// ---------------------------------------------------------------- cases (§2.1)

type Candidate = { id: string; kind: string; action: string; expected: string };

type Fork = {
	id: string;
	kind: string;
	goal: string;
	contract: string;
	state: string;
	candidates: Candidate[];
	oracle: string;
	why: string;
};

type Dossier = { id: string; title: string; forks: Fork[] };

type CaseFile = { protocol: string; note: string; rubric: string[]; dossiers: Dossier[] };

function loadCases(): CaseFile {
	return JSON.parse(readFileSync(CASES_PATH, "utf8")) as CaseFile;
}

/** Every invariant the oracle depends on: a fork whose gold is not derivable from its own brief is invalid. */
function validateCases(cases: CaseFile): string[] {
	const problems: string[] = [];
	if (cases.rubric.length < 2 || cases.rubric.length > 10) problems.push(`rubric has ${cases.rubric.length} levels`);
	const seenFork = new Set<string>();
	for (const dossier of cases.dossiers) {
		if (dossier.forks.length < 3) problems.push(`${dossier.id} has ${dossier.forks.length} forks, need >= 3`);
		for (const fork of dossier.forks) {
			if (seenFork.has(fork.id)) problems.push(`duplicate fork id ${fork.id}`);
			seenFork.add(fork.id);
			if (!fork.state.includes(fork.contract)) problems.push(`${fork.id}: contract is not verbatim inside state`);
			if (!fork.candidates.some((candidate) => candidate.id === fork.oracle)) problems.push(`${fork.id}: oracle is not a candidate`);
			if (fork.candidates.length < 3) problems.push(`${fork.id}: ${fork.candidates.length} candidates, need >= 3`);
			if (new Set(fork.candidates.map((candidate) => candidate.id)).size !== fork.candidates.length) problems.push(`${fork.id}: duplicate candidate ids`);
			if (fork.candidates.filter((candidate) => candidate.kind !== fork.kind).length > 0) problems.push(`${fork.id}: candidate kind differs from the fork kind`);
			if (fork.why.trim().length < 20) problems.push(`${fork.id}: oracle justification is too thin`);
			if (!/^[a-z][a-z0-9_-]{0,31}$/.test(fork.oracle)) problems.push(`${fork.id}: oracle id fails the product's id pattern`);
			// The product's own caps: a fork that trips one would come back as `invalid_input`, which is an
			// authoring error dressed up as an endpoint problem, so it is refused here instead.
			if (fork.goal.length > 1_000) problems.push(`${fork.id}: goal is ${fork.goal.length} chars, over the product's 1000`);
			if (fork.state.length > 12_000) problems.push(`${fork.id}: state is ${fork.state.length} chars, over the product's 12000`);
			if (fork.candidates.length > 5) problems.push(`${fork.id}: ${fork.candidates.length} candidates, over the product's 5`);
			for (const candidate of fork.candidates) {
				if (!/^[a-z][a-z0-9_-]{0,31}$/.test(candidate.id)) problems.push(`${fork.id}: candidate ${candidate.id} fails the id pattern`);
				if (candidate.action.length > 600 || candidate.expected.length > 600) problems.push(`${fork.id}/${candidate.id}: text over the product cap`);
			}
		}
	}
	for (const id of STAGE2_DOSSIERS) if (!cases.dossiers.some((dossier) => dossier.id === id)) problems.push(`stage-2 dossier ${id} is missing`);
	return problems;
}

function forkById(cases: CaseFile, id: string): Fork {
	for (const dossier of cases.dossiers) {
		const found = dossier.forks.find((fork) => fork.id === id);
		if (found) return found;
	}
	throw new Error(`unknown fork: ${id}`);
}

// ---------------------------------------------------------------- frozen policy (§3.2)

const COMMON_POLICY = `Work only on the current task in this workspace.

- Read only \`brief.json\`, \`src/answers.json\` and \`tests/check.mjs\`. Write only \`src/answers.json\`.
- Verify with \`bun tests/check.mjs\` (that exact command is pre-approved; other shell commands may be refused).
- No git, no dependency installs, no network beyond the tools you are given.
- Answer every fork in \`brief.json\` with exactly one candidate id. The acceptance check is still the file
  you write: whatever a tool answers is a suggestion, never a verdict and never authorization.
`;

/** Appended verbatim to arm J and arm E, so both see the shipped policy and differ only in the answer. */
function shippedPolicyAppend(): string {
	return `${readFileSync(RULES_PATH, "utf8").trimEnd()}

- In this task every fork in the dossier is a real branch point. Use one \`decision_maker\` call per fork
  instead of writing the comparison out yourself, then answer the fork.
`;
}

const AGENTS_MD = `# Judgement dossier

The dossier is \`brief.json\`; answer every fork it contains in \`src/answers.json\` as
\`{"F1":"<id>","F2":"<id>",...}\` and nothing else. \`tests/check.mjs\` is the public acceptance check:
leave it exactly as it is and make \`bun tests/check.mjs\` pass.
`;

function promptFor(dossier: Dossier): string {
	const keys = dossier.forks.map((fork) => fork.id).join(", ");
	return (
		`Đọc brief.json. Với mỗi fork trong đó (${keys}), chọn đúng một candidate id theo contract mà fork đó nêu. ` +
		`Ghi src/answers.json dạng {"${dossier.forks[0].id}":"<id>", ...} với khoá là mã fork, rồi chạy bun tests/check.mjs. ` +
		"Không sửa brief.json hay tests/check.mjs."
	);
}

function briefOf(dossier: Dossier): string {
	return `${JSON.stringify(
		{
			dossier: dossier.id,
			title: dossier.title,
			forks: dossier.forks.map((fork) => ({ id: fork.id, kind: fork.kind, goal: fork.goal, state: fork.state, candidates: fork.candidates })),
		},
		null,
		2,
	)}\n`;
}

/** Public: well-formed and each answer is one of that fork's ids. A non-winner passes it. */
function publicCheckOf(dossier: Dossier): string {
	const allowed = Object.fromEntries(dossier.forks.map((fork) => [fork.id, fork.candidates.map((candidate) => candidate.id)]));
	return `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const answers = JSON.parse(readFileSync("src/answers.json", "utf8"));
const allowed = ${JSON.stringify(allowed)};
assert.equal(typeof answers, "object");
assert.notEqual(answers, null);
assert.equal(Array.isArray(answers), false);
assert.deepEqual(Object.keys(answers).sort(), Object.keys(allowed).sort());
for (const [fork, ids] of Object.entries(allowed)) assert.ok(ids.includes(answers[fork]), fork + " must name one of its candidates");
console.log("${dossier.id} checks passed");
`;
}

/** Private grader: the only file that names the gold. */
function graderOf(dossier: Dossier): string {
	const expected = Object.fromEntries(dossier.forks.map((fork) => [fork.id, fork.oracle]));
	return `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.argv[2];
const answers = JSON.parse(readFileSync(join(workspace, "src", "answers.json"), "utf8"));
const expected = ${JSON.stringify(expected)};
for (const [fork, id] of Object.entries(expected)) assert.equal(answers[fork], id, "wrong choice for " + fork);
console.log("${dossier.id} grader passed");
`;
}

function workspaceTreeOf(dossier: Dossier, answers: Record<string, string> | null): Record<string, string> {
	return {
		"brief.json": briefOf(dossier),
		"src/answers.json": `${JSON.stringify(answers ?? Object.fromEntries(dossier.forks.map((fork) => [fork.id, null])), null, 2)}\n`,
		[PUBLIC_TEST]: publicCheckOf(dossier),
		"AGENTS.md": AGENTS_MD,
	};
}

// ---------------------------------------------------------------- primitives

type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; ms: number };

async function runProcess(argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<ProcessResult> {
	const started = performance.now();
	const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return { code, stdout, stderr, timedOut, ms: Number((performance.now() - started).toFixed(1)) };
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
}

function hashOf(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function hashFile(path: string): string {
	try {
		return hashOf(readFileSync(path, "utf8"));
	} catch {
		return "missing";
	}
}

function redact(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join("[redacted]");
	return out;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sumOrNull(values: Array<number | null>): number | null {
	if (values.length === 0 || values.some((value) => value === null)) return null;
	return Number(values.reduce<number>((total, value) => total + (value as number), 0).toFixed(6));
}

function list(values: Array<number | null>): string {
	return values.length === 0 ? "none" : values.map((value) => (value === null ? "null" : value)).join(", ");
}

/** Wilson interval, printed beside every rate so no small sample is read as a point estimate. */
function wilson(successes: number, total: number): [number, number] {
	if (total === 0) return [0, 1];
	const z = 1.96;
	const p = successes / total;
	const denominator = 1 + (z * z) / total;
	const centre = p + (z * z) / (2 * total);
	const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
	return [Number(Math.max(0, (centre - spread) / denominator).toFixed(3)), Number(Math.min(1, (centre + spread) / denominator).toFixed(3))];
}

// ---------------------------------------------------------------- isolation

const PLACEHOLDER_MODELS = Bun.YAML.stringify({
	providers: {
		[MAIN_PROVIDER]: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-responses",
			apiKey: "placeholder-not-a-credential",
			authHeader: true,
			models: [{ id: MAIN_MODEL_ID, input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, contextWindow: 1050000 }],
		},
	},
});

let realModelsYml: string | null = null;

function buildModelsYmlFile(): string {
	if (realModelsYml) return realModelsYml;
	const parsed = Bun.YAML.parse(readFileSync(REAL_MODELS_YML, "utf8")) as { providers?: Record<string, Record<string, unknown>> };
	const provider = parsed?.providers?.[MAIN_PROVIDER];
	if (!provider) throw new Error(`${REAL_MODELS_YML} has no "${MAIN_PROVIDER}" provider`);
	const trimmed: Record<string, unknown> = {};
	for (const key of ["baseUrl", "api", "apiKey", "authHeader", "discovery"]) if (provider[key] !== undefined) trimmed[key] = provider[key];
	const models = (provider.models as Array<{ id?: string }> | undefined)?.filter((model) => model.id === MAIN_MODEL_ID) ?? [];
	if (models.length !== 1) throw new Error(`expected exactly one ${MAIN_PROVIDER} model "${MAIN_MODEL_ID}", found ${models.length}`);
	trimmed.models = models;
	const built = Bun.YAML.stringify({ providers: { [MAIN_PROVIDER]: trimmed } });
	realModelsYml = built;
	return built;
}

function modelSecrets(yml: string): string[] {
	const parsed = Bun.YAML.parse(yml) as { providers?: Record<string, { apiKey?: unknown } | undefined> };
	const values: string[] = [];
	for (const provider of Object.values(parsed?.providers ?? {})) {
		const key = provider?.apiKey;
		if (typeof key === "string" && key.length > 0) values.push(key);
	}
	return values;
}

type IsolatedRun = { root: string; home: string; workspace: string };

function makeIsolatedRun(label: string, modelsYml: string): IsolatedRun {
	const root = mkdtempSync(join(tmpdir(), `jev2-${label}-`));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	for (const leaf of [".omp/agent", "xdg-config", "xdg-data/omp", "xdg-state/omp", "xdg-cache/omp"]) {
		mkdirSync(join(home, leaf), { recursive: true, mode: 0o700 });
	}
	mkdirSync(workspace, { recursive: true });
	if (!root.startsWith(tmpdir())) throw new Error(`isolated run escaped the temp dir: ${root}`);
	const models = join(home, ".omp/agent", "models.yml");
	writeFileSync(models, modelsYml, { mode: 0o600 });
	chmodSync(models, 0o600);
	writeFileSync(join(home, ".omp/agent", "config.yml"), `modelRoles:\n  default: ${MAIN_MODEL}\n`, "utf8");
	return { root, home, workspace };
}

function childEnv(run: IsolatedRun, options: { jev?: string; openRouterKey?: string } = {}): Record<string, string> {
	const env: Record<string, string> = {
		HOME: run.home,
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
		XDG_CONFIG_HOME: join(run.home, "xdg-config"),
		XDG_DATA_HOME: join(run.home, "xdg-data"),
		XDG_STATE_HOME: join(run.home, "xdg-state"),
		XDG_CACHE_HOME: join(run.home, "xdg-cache"),
	};
	if (options.jev !== undefined) env.JEV_DECISION_MAKER = options.jev;
	// Only J receives a credential: the baseline cannot reach the endpoint, and the control never wants to.
	if (options.openRouterKey !== undefined) env.OPENROUTER_API_KEY = options.openRouterKey;
	return env;
}

function checkEnv(run: IsolatedRun): Record<string, string> {
	return { HOME: run.home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb" };
}

function guardEnv(): Record<string, string> {
	return { HOME: mkdtempSync(join(tmpdir(), "jev2-guard-")), PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb" };
}

type CredentialSource = "operator-env" | "omp-store-readonly-to-isolated-env";

function resolveCredential(): { source: CredentialSource; key: string } {
	const fromEnv = process.env.OPENROUTER_API_KEY;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return { source: "operator-env", key: fromEnv.trim() };
	if (!existsSync(REAL_AGENT_DB)) throw new Error(`no credential store at ${REAL_AGENT_DB} and no OPENROUTER_API_KEY in the environment`);
	const db = new Database(REAL_AGENT_DB, { readonly: true });
	try {
		const rows = db
			.query("SELECT data FROM auth_credentials WHERE provider = 'openrouter' AND credential_type = 'api_key' AND disabled_cause IS NULL")
			.all() as Array<{ data: string }>;
		if (rows.length !== 1) throw new Error(`expected exactly one active openrouter api_key credential, found ${rows.length}`);
		const data = JSON.parse(rows[0].data) as { key?: unknown };
		if (typeof data.key !== "string" || data.key.length === 0) throw new Error("the openrouter credential has no literal key field");
		if (data.key.startsWith("!")) throw new Error("the openrouter credential is a command reference; this harness will not run it");
		return { source: "omp-store-readonly-to-isolated-env", key: data.key };
	} finally {
		db.close();
	}
}

async function confirmChildCredential(key: string): Promise<boolean> {
	const run = makeIsolatedRun("credential-check", buildModelsYmlFile());
	try {
		const token = await runProcess(["omp", "token", "openrouter"], run.workspace, 60_000, childEnv(run, { jev: "1", openRouterKey: key }));
		return token.code === 0 && token.stdout.trim() === key;
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- parsing

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function numberOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/**
 * The product's own return-to-main reasons that mean the endpoint or the transport failed. `invalid_input`
 * is deliberately absent: it is rejected before the resolver runs and before any request, so it can only
 * mean the caller (or, here, the fixture) sent something the contract forbids. It is counted separately as
 * an authoring failure, and a stop rule keyed to the wrong class would invalidate a paid stage for a typo.
 * `control` is absent too: it is fabricated by the arm-E stub, never a model answer.
 */
const PRODUCT_FAILURE_REASONS = [
	"missing_key",
	"cancelled",
	"timeout",
	"http_error",
	"invalid_response",
	"network_error",
	"call_limit",
];

type DecisionSample = {
	callId: string;
	requestedMode: string | null;
	questionCount: number | null;
	toolInputBytes: number | null;
	status: string | null;
	reason: string | null;
	candidateId: string | null;
	model: string | null;
	latencyMs: number | null;
	costUsd: number | null;
	scores: Array<{ candidateId: string; score: number }> | null;
	topScoreIds: string[] | null;
	/** True when the answer came from the empty control tool rather than the model. */
	fabricated: boolean;
};

function readDecision(details: JsonObject, args: JsonObject | undefined, callId: string): DecisionSample {
	const reason = textOf(details.reason);
	const rawScores = Array.isArray(details.scores) ? details.scores : null;
	const scores = rawScores
		? (rawScores
				.map((entry) => {
					const record = asObject(entry);
					const candidateId = textOf(record?.candidateId);
					const score = numberOf(record?.score);
					return candidateId && score !== null ? { candidateId, score } : null;
				})
				.filter((entry): entry is { candidateId: string; score: number } => entry !== null) as Array<{ candidateId: string; score: number }>)
		: null;
	let topScoreIds: string[] | null = null;
	if (scores && scores.length > 0) {
		const best = Math.max(...scores.map((entry) => entry.score));
		topScoreIds = scores.filter((entry) => entry.score === best).map((entry) => entry.candidateId);
	}
	const candidates = Array.isArray(args?.candidates) ? args.candidates.length : null;
	const mode = textOf(args?.mode);
	return {
		callId,
		requestedMode: mode,
		questionCount: mode === "select" ? 1 : mode === "score" ? candidates : null,
		toolInputBytes: args === undefined ? null : new TextEncoder().encode(JSON.stringify(args)).length,
		status: textOf(details.status),
		reason,
		candidateId: textOf(details.candidateId),
		model: textOf(details.model),
		latencyMs: numberOf(details.latencyMs),
		costUsd: numberOf(details.costUsd),
		scores,
		topScoreIds,
		fabricated: reason === "control",
	};
}

type SessionMetrics = {
	mainModels: string[];
	turns: number;
	toolCounts: Record<string, number>;
	toolCallSequence: string[];
	missingToolEnds: string[];
	extensionErrors: number;
	decisions: DecisionSample[];
	realCalls: number;
	controlCalls: number;
	realDeferred: number;
	realUncertain: number;
	controlAnswers: number;
	failures: string[];
	authoringFailures: string[];
	jevLatencyMs: number[];
	jevCostUsd: Array<number | null>;
	mainCostUsd: number | null;
	costStatus: "reported" | "unknown";
	totalTokens: number | null;
};

function summarizeTranscript(stdout: string): SessionMetrics {
	const mainModels = new Set<string>();
	const starts = new Map<string, { name: string; args: JsonObject | undefined }>();
	const decisions: DecisionSample[] = [];
	const toolCounts: Record<string, number> = {};
	const sequence: string[] = [];
	const costs: Array<number | null> = [];
	const tokens: Array<number | null> = [];
	let turns = 0;
	let extensionErrors = 0;

	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const event = asObject(parsed);
		if (!event) continue;
		const type = textOf(event.type);
		if (type === "extension_error") {
			extensionErrors += 1;
			continue;
		}
		if (type === "turn_start") {
			turns += 1;
			continue;
		}
		const message = asObject(event.message);
		if (type === "message_start" && message?.role === "assistant") {
			const provider = textOf(message.provider);
			const model = textOf(message.model);
			if (provider && model) mainModels.add(`${provider}/${model}`);
			continue;
		}
		if (type === "message_end" && message?.role === "assistant") {
			const usage = asObject(message.usage) ?? {};
			const cost = asObject(usage.cost) ?? {};
			costs.push(numberOf(cost.total));
			tokens.push(numberOf(usage.totalTokens));
			continue;
		}
		const callId = textOf(event.toolCallId);
		if (!callId) continue;
		const name = textOf(event.toolName);
		if (type === "tool_execution_start" && name) {
			toolCounts[name] = (toolCounts[name] ?? 0) + 1;
			sequence.push(name);
			starts.set(callId, { name, args: asObject(event.args) });
			continue;
		}
		if (type === "tool_execution_end") {
			const started = starts.get(callId);
			if (started) starts.delete(callId);
			if (started?.name !== TOOL_NAME) continue;
			decisions.push(readDecision(asObject(asObject(event.result)?.details) ?? {}, started.args, callId));
		}
	}
	const real = decisions.filter((decision) => !decision.fabricated);
	return {
		mainModels: [...mainModels].sort(),
		turns,
		toolCounts,
		toolCallSequence: sequence,
		missingToolEnds: [...starts.values()].map((entry) => entry.name),
		extensionErrors,
		decisions,
		realCalls: real.length,
		controlCalls: decisions.length - real.length,
		realDeferred: real.filter((decision) => decision.reason === "deferred").length,
		realUncertain: real.filter((decision) => decision.reason === "uncertain").length,
		controlAnswers: decisions.filter((decision) => decision.fabricated).length,
		// `control` never lands in either bucket: the fabricate check is separate from the product's reasons,
		// and `invalid_input` is an authoring problem rather than an endpoint one.
		failures: real.map((decision) => decision.reason ?? "unknown").filter((reason) => PRODUCT_FAILURE_REASONS.includes(reason)),
		authoringFailures: real.map((decision) => decision.reason ?? "unknown").filter((reason) => reason === "invalid_input"),
		jevLatencyMs: real.map((decision) => decision.latencyMs).filter((value): value is number => value !== null),
		jevCostUsd: real.map((decision) => decision.costUsd),
		mainCostUsd: costs.length > 0 && costs.every((value) => value !== null) ? sumOrNull(costs) : null,
		costStatus: costs.length > 0 && costs.every((value) => value !== null) ? "reported" : "unknown",
		totalTokens: sumOrNull(tokens),
	};
}

// ---------------------------------------------------------------- RPC driving

type RpcFrame = { frames: JsonObject[] };

async function driveRpc(
	argv: string[],
	run: IsolatedRun,
	env: Record<string, string>,
	send: JsonObject[],
	done: (frames: JsonObject[]) => boolean,
	deadlineMs = RPC_DEADLINE_MS,
): Promise<RpcFrame> {
	const child = Bun.spawn(argv, { cwd: run.workspace, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const frames: JsonObject[] = [];
	let out = "";
	let err = "";
	let consumed = 0;
	const take = () => {
		const pending = out.slice(consumed);
		const lines = pending.split("\n");
		consumed += pending.length - (lines.pop() ?? "").length;
		for (const line of lines) {
			if (!line.trim().startsWith("{")) continue;
			const frame = asObject(JSON.parse(line) as unknown);
			if (frame) frames.push(frame);
		}
	};
	const pumping = Promise.all([
		(async () => {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done: finished, value } = await reader.read();
				if (finished) return;
				out += decoder.decode(value, { stream: true });
				take();
			}
		})(),
		(async () => {
			const reader = child.stderr.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done: finished, value } = await reader.read();
				if (finished) return;
				err += decoder.decode(value, { stream: true });
			}
		})(),
	]);
	try {
		const deadline = performance.now() + deadlineMs;
		for (const [index, frame] of send.entries()) {
			child.stdin.write(`${JSON.stringify({ id: `cmd-${index}`, ...frame })}\n`);
			while (performance.now() < deadline && !done(frames)) await Bun.sleep(100);
		}
		const settle = performance.now() + NOTIFY_GRACE_MS;
		while (performance.now() < settle && !done(frames)) await Bun.sleep(100);
		take();
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		await pumping;
	}
	if (err.length > 0) frames.push({ type: "harness_stderr", text: err.slice(0, 600) });
	return { frames };
}

function stateOf(frames: JsonObject[]): JsonObject | undefined {
	return frames.find((frame) => frame.type === "response" && frame.command === "get_state" && frame.success === true);
}

function statusOf(frames: JsonObject[]): Array<[string, string | undefined]> {
	const statuses: Array<[string, string | undefined]> = [];
	for (const frame of frames) {
		if (frame.type === "extension_ui_request" && frame.method === "setStatus") {
			statuses.push([String(frame.statusKey), frame.statusText === undefined ? undefined : String(frame.statusText)]);
		}
	}
	return statuses;
}

function ackOf(frames: JsonObject[]): JsonObject | undefined {
	return frames.find(
		(frame) =>
			(frame.type === "prompt_result" && frame.agentInvoked === false) ||
			(frame.type === "response" && frame.command === "prompt" && frame.success === true && asObject(frame.data)?.agentInvoked === false),
	);
}

function notificationOf(frames: JsonObject[], marker: string): JsonObject | undefined {
	return frames.find((frame) => frame.type === "extension_ui_request" && String(frame.message ?? "").includes(marker));
}

type RegistryProbe = { tools: string[]; commands: string[]; statuses: Array<[string, string | undefined]>; schema: JsonObject | null; description: string | null };

async function probeRegistry(extensionPath: string, jev: string, tools: string[]): Promise<RegistryProbe> {
	const run = makeIsolatedRun(`probe-${jev}-${tools.length}`, PLACEHOLDER_MODELS);
	const argv = [
		"omp",
		"--mode",
		"rpc",
		"--no-session",
		"--no-title",
		"--no-skills",
		"--no-rules",
		"--model",
		MAIN_MODEL,
		"--no-extensions",
		"-e",
		extensionPath,
		"--tools",
		tools.join(","),
	];
	try {
		const { frames } = await driveRpc(argv, run, childEnv(run, { jev, openRouterKey: "sk-or-v1-placeholder-not-a-credential" }), [{ type: "get_state" }], (seen) =>
			Boolean(stateOf(seen)),
		);
		const state = stateOf(frames);
		if (!state) throw new Error(`the rpc probe never answered get_state: ${JSON.stringify(frames).slice(0, 400)}`);
		const dump = asObject(state.data)?.dumpTools;
		if (!Array.isArray(dump)) throw new Error("get_state returned no dumpTools");
		const entries = dump.map((tool) => asObject(tool) ?? {});
		const own = entries.find((tool) => textOf(tool.name) === TOOL_NAME);
		const commands = new Set<string>();
		for (const frame of frames) {
			if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
				for (const command of frame.commands) {
					const name = textOf(asObject(command)?.name);
					if (name) commands.add(name);
				}
			}
		}
		return {
			tools: entries.map((tool) => textOf(tool.name) ?? ""),
			commands: [...commands].sort(),
			statuses: statusOf(frames),
			schema: asObject(own?.parameters) ?? null,
			description: textOf(own?.description),
		};
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- stage 1

type Stage1Call = {
	callId: string;
	/** HTTP status and rate-limit hints: the product reports every non-2xx as `http_error`, so without
	 *  these a whole invalid batch cannot be told apart from a quota wall. */
	httpStatus?: number | null;
	retryAfter?: string | null;
	rateRemaining?: string | null;
	/** Bounded sample of the response body, kept only when the validator rejected the answer. */
	responseBody?: string | null;
	/** TypeSafe confidence, recorded alongside probability for the v5 parallel-gate sweep. */
	confidence?: number | null;
	fork: string;
	/** Branch point kind, so a threshold can be decided per kind the way the product gates them. */
	kind?: string;
	/** Which repetition of this fork produced the call; v3 splits train (1-2) from hold-out (3) on it. */
	repeat?: number;
	oracle?: string;
	view: "select" | "score" | "score-permuted";
	status: string | null;
	reason: string | null;
	candidateId: string | null;
	topScoreIds: string[] | null;
	/** What the product chose and what it believed, recorded even when it refused to commit. */
	argmax?: string | null;
	argmaxProbability?: number | null;
	probability?: number | null;
	probabilities?: Record<string, number> | null;
	oracleIsSoleTop: boolean;
	picked: boolean;
	committed: boolean;
	latencyMs: number | null;
	costUsd: number | null;
	model: string | null;
	requestCount: number;
	requestBytes: number;
	questionCount: number;
};

function redactCallBodies(calls: Stage1Call[], secrets: string[]): Stage1Call[] {
	return calls.map((call) => call.responseBody ? { ...call, responseBody: redact(call.responseBody, secrets) } : call);
}

function stage1ExtensionSource(
	cases: CaseFile,
	permuted: string[],
	rubric: string[],
	selectRepeats = 1,
	order: "fork" | "repeat" = "fork",
	healthFirst = 0,
	failFast = 0,
): string {
	const forks = cases.dossiers.flatMap((dossier) => dossier.forks);
	const selectEntry = (fork: Fork, repeat: number) => ({
		fork: fork.id,
		kind: fork.kind,
		repeat,
		view: "select",
		mode: "select",
		goal: fork.goal,
		state: fork.state,
		candidates: fork.candidates,
		rubric: null,
	});
	const scoreEntry = (fork: Fork) => ({
		fork: fork.id,
		kind: fork.kind,
		repeat: 1,
		view: "score",
		mode: "score",
		goal: fork.goal,
		state: fork.state,
		candidates: fork.candidates,
		rubric,
	});
	const permutedEntry = (fork: Fork) => ({
		fork: fork.id,
		kind: fork.kind,
		repeat: 1,
		view: "score-permuted",
		mode: "score",
		goal: fork.goal,
		state: fork.state,
		candidates: [...fork.candidates].reverse(),
		rubric,
	});
	// "repeat" interleaves by repetition so a contiguous outage thins every kind proportionally instead of
	// deleting one kind's whole hold-out; "fork" is the v2 layout, kept byte-identical for that protocol.
	const plan =
		order === "repeat"
			? [
					...Array.from({ length: selectRepeats }, (_unused, index) => forks.map((fork) => selectEntry(fork, index + 1))).flat(),
					...forks.map(scoreEntry),
				]
			: forks.flatMap((fork) => [
					...Array.from({ length: selectRepeats }, (_unused, index) => selectEntry(fork, index + 1)),
					scoreEntry(fork),
					...(permuted.includes(fork.id) ? [permutedEntry(fork)] : []),
				]);
	return `/** Generated by the protocol-2 runner: direct decide() calls, no agent, no session policy. */
import { decide } from ${JSON.stringify(EXTENSION)};

const PLAN = ${JSON.stringify(plan)};
const PACE_MS = ${PACE_MS};
/** How many opening calls must be clean before the rest of the batch is worth sending. */
const HEALTH_FIRST = ${healthFirst};
/** Consecutive provider failures that end the batch early instead of burning the tail. */
const FAIL_FAST = ${failFast};
const ORACLES = ${JSON.stringify(Object.fromEntries(cases.dossiers.flatMap((dossier) => dossier.forks).map((fork) => [fork.id, fork.oracle])))};
const MARKER = "jev-stage1-result";

export default function stage1Extension(pi) {
  pi.registerCommand("jev-cases", {
    description: "Run the frozen case list through decide()",
    handler: async (_args, ctx) => {
      // Deliberately larger than the plugin's 5-call session quota: this measures the model, not the
      // session policy, and the protocol states that explicitly.
      const budget = { remaining: PLAN.length };
      const resolveApiKey = async (signal) =>
        await ctx.modelRegistry.getApiKeyForProvider("openrouter", ctx.sessionManager.getSessionId(), { signal });
      const results = [];
      let index = 0;
      let streak = 0;
      let aborted = null;
      for (const entry of PLAN) {
        const bucket = { requests: 0, requestBytes: 0, questionCount: 0, status: null, retryAfter: null, rateRemaining: null };
        const wrapped = async (url, init) => {
          bucket.requests += 1;
          const body = typeof init?.body === "string" ? init.body : "";
          bucket.requestBytes = new TextEncoder().encode(body).length;
          try {
            bucket.questionCount = Object.keys(JSON.parse(body).questions ?? {}).length;
          } catch {
            bucket.questionCount = -1;
          }
          // Only the status and rate-limit headers are read: the body the product is about to cancel
          // must stay untouched, and the product collapses every non-2xx into one http_error reason.
          const response = await globalThis.fetch(url, init);
          bucket.status = response.status;
          bucket.retryAfter = response.headers.get("retry-after");
          bucket.rateRemaining = response.headers.get("x-ratelimit-remaining");
          // A clone is kept so a response the validator rejects can still be inspected afterwards: the
          // product cancels the original body, and "the endpoint sent a wrong shape" cannot be told from
          // "our validator is too strict" without the bytes. Only a bounded sample survives.
          let clone = null;
          try {
            clone = response.clone();
          } catch {
            clone = null;
          }
          wrapped.clone = clone;
          return response;
        };
        const input = entry.mode === "select"
          ? { mode: "select", goal: entry.goal, state: entry.state, candidates: entry.candidates }
          : { mode: "score", goal: entry.goal, state: entry.state, candidates: entry.candidates, rubric: entry.rubric };
        const result = await decide(input, { fetch: wrapped, budget, resolveApiKey });
        // Only a rejected answer needs its bytes kept: that is the one case where the reason alone cannot
        // say whether the endpoint broke the contract or the validator is too strict.
        let responseBody = null;
        if (result.reason === "invalid_response" && wrapped.clone !== null) {
          try {
            const text = await wrapped.clone.text();
            responseBody = text.length > 2000 ? text.slice(0, 2000) : text;
          } catch {
            responseBody = null;
          }
        }
        const tops = result.scores === null ? null : result.scores.filter((s) => s.score === Math.max(...result.scores.map((x) => x.score))).map((s) => s.candidateId);
        const oracle = ORACLES[entry.fork];
        const probabilities = result.probabilities ?? (result.scores === null ? null : Object.fromEntries(result.scores.map((s) => [s.candidateId, s.score])));
        let argmax = null;
        if (entry.mode === "select" && probabilities) {
          let best = -1;
          for (const [id, value] of Object.entries(probabilities)) if (value > best) { best = value; argmax = id; }
        }
        results.push({
          fork: entry.fork,
          kind: entry.kind,
          repeat: entry.repeat,
          oracle,
          argmax,
          argmaxProbability: argmax !== null && probabilities ? probabilities[argmax] : null,
          probability: result.probability,
          confidence: result.confidence,
          probabilities,
          view: entry.view,
          status: result.status,
          reason: result.reason,
          candidateId: result.candidateId,
          topScoreIds: tops,
          oracleIsSoleTop: entry.view === "select" ? result.candidateId === oracle : Boolean(tops && tops.length === 1 && tops[0] === oracle),
          picked: entry.view === "select" ? result.candidateId === oracle : Boolean(tops && tops.length === 1 && tops[0] === oracle),
          committed: result.status === "selected" || result.status === "scored",
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
          model: result.model,
          requestCount: bucket.requests,
          requestBytes: bucket.requestBytes,
          questionCount: bucket.questionCount,
          httpStatus: bucket.status,
          retryAfter: bucket.retryAfter,
          rateRemaining: bucket.rateRemaining,
          responseBody,
        });
        // A call that never reached the network (missing credential, exhausted quota, rejected input) has no
        // status at all, and reading that as a provider outage would stop a batch for a client reason. Only a
        // request that was actually sent can be unhealthy, and only a sent request advances the streak.
        const sent = bucket.requests > 0;
        const faultClass = bucket.status === null || bucket.status >= 500 ? "health" : "rejected";
        const nonOk = sent && (bucket.status === null || bucket.status >= 400);
        streak = nonOk ? streak + 1 : 0;
        if (HEALTH_FIRST > 0 && index + 1 <= HEALTH_FIRST && nonOk) {
          aborted = { at: index, kind: faultClass, status: bucket.status, reason: result.reason };
          break;
        }
        if (FAIL_FAST > 0 && streak >= FAIL_FAST) {
          aborted = { at: index, kind: faultClass, status: bucket.status, reason: result.reason };
          break;
        }
        index += 1;
        if (index < PLAN.length) await Bun.sleep(PACE_MS);
      }
      ctx.ui.notify(MARKER + " " + JSON.stringify({ results, aborted }), "info");
    },
  });
}
`;
}

type NotifyPayload = { calls: Stage1Call[]; aborted: { at: number; kind: string; status: number | null; reason: string | null } | null };

/** Accepts both notify shapes: the bare array v2 stored, and the {results, aborted} v3 sends. */
function parseNotify(raw: string): NotifyPayload {
	const parsed = JSON.parse(raw) as unknown;
	if (Array.isArray(parsed)) return { calls: parsed as Stage1Call[], aborted: null };
	const holder = asObject(parsed) ?? {};
	const results = Array.isArray(holder.results) ? (holder.results as Stage1Call[]) : [];
	return { calls: results, aborted: (asObject(holder.aborted) as NotifyPayload["aborted"]) ?? null };
}

async function stage1(runDir: string, cases: CaseFile, secrets: string[], key: string): Promise<{ calls: Stage1Call[]; frames: JsonObject[] }> {
	const run = makeIsolatedRun("stage1", buildModelsYmlFile());
	const probePath = join(run.root, "stage1-extension.ts");
	writeFileSync(probePath, stage1ExtensionSource(cases, PERMUTED_FORKS, cases.rubric), "utf8");
	const argv = [
		"omp",
		"--mode",
		"rpc",
		"--no-session",
		"--no-title",
		"--no-skills",
		"--no-rules",
		"--model",
		MAIN_MODEL,
		"--no-extensions",
		"-e",
		probePath,
		"--tools",
		BASELINE_TOOLS.join(","),
	];
	try {
		const marker = "jev-stage1-result";
		const { frames } = await driveRpc(
			argv,
			run,
			childEnv(run, { jev: "1", openRouterKey: key }),
			[{ type: "prompt", message: "/jev-cases" }],
			(seen) => Boolean(ackOf(seen)) && Boolean(notificationOf(seen, marker)),
			STAGE1_DEADLINE_MS,
		);
		writeFileSync(join(runDir, "stage1.frames.jsonl"), redact(frames.map((frame) => JSON.stringify(frame)).join("\n"), secrets), "utf8");
		const notified = notificationOf(frames, marker);
		const raw = textOf(notified?.message) ?? "";
		const parsed = parseNotify(raw.slice(marker.length + 1));
		return { calls: parsed.calls, frames };
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- stage 2

type ForkAnswer = { fork: string; answer: string | null; correct: boolean };

type SessionRecord = {
	dossier: string;
	repeat: number;
	arm: Arm;
	agentMs: number;
	agentExitCode: number;
	agentTimedOut: boolean;
	publicCheck: "passed" | "failed";
	grader: "passed" | "failed";
	answers: ForkAnswer[];
	forksCorrect: number;
	mainModels: string[];
	turns: number;
	missingToolEnds: string[];
	extensionErrors: number;
	realCalls: number;
	controlCalls: number;
	calledBeforeFirstWrite: boolean;
	callsByFork: Array<{ callIndex: number; mode: string | null; questions: number | null; toolInputBytes: number | null; reason: string | null; pickedOracle: boolean | null }>;
	realDeferred: number;
	realUncertain: number;
	controlAnswers: number;
	failures: string[];
	authoringFailures: string[];
	jevLatencyMs: number[];
	jevCostUsd: Array<number | null>;
	mainCostUsd: number | null;
	totalCostUsd: number | null;
	costStatus: "reported" | "unknown";
	totalTokens: number | null;
	briefUnmodified: boolean;
	testsUnmodified: boolean;
	graderUnmodified: boolean;
	controlLog: number;
	transcriptPath: string;
	envKeys: string[];
};

async function runSession(
	order: { dossier: string; repeat: number; arm: Arm },
	runDir: string,
	cases: CaseFile,
	secrets: string[],
	key: string,
): Promise<{ record: SessionRecord; violation: string | null }> {
	const dossier = cases.dossiers.find((entry) => entry.id === order.dossier);
	if (!dossier) throw new Error(`unknown dossier: ${order.dossier}`);
	const label = `${dossier.id}-${order.repeat}${order.arm}`;
	const run = makeIsolatedRun(label, buildModelsYmlFile());
	const policyPath = join(run.root, "policy.txt");
	const overlayPath = join(run.root, "overlay.yml");
	const graderPath = join(run.root, "grader.mjs");
	writeTree(run.workspace, workspaceTreeOf(dossier, null));
	writeFileSync(policyPath, order.arm === "B" ? COMMON_POLICY : `${COMMON_POLICY}\n${shippedPolicyAppend()}`, "utf8");
	writeFileSync(
		overlayPath,
		`tools:\n  approval:\n    ${TOOL_NAME}: allow\nbash:\n  allowCompoundCommands: false\n  patterns:\n    - match: "bun ${PUBLIC_TEST}"\n      approval: allow\n`,
		"utf8",
	);
	writeFileSync(graderPath, graderOf(dossier), "utf8");

	const extensionPath = order.arm === "E" ? STUB_EXTENSION : EXTENSION;
	const tools = order.arm === "B" ? BASELINE_TOOLS : TREATMENT_TOOLS;
	const briefPath = join(run.workspace, "brief.json");
	const answersPath = join(run.workspace, "src/answers.json");
	const testPath = join(run.workspace, PUBLIC_TEST);
	const controlLogPath = join(run.home, ".omp/agent/control-calls.jsonl");
	const briefHash = hashFile(briefPath);
	const testHash = hashFile(testPath);
	const graderHash = hashOf(readFileSync(graderPath, "utf8"));
	const argv = [
		"omp",
		"-p",
		"--mode",
		"json",
		"--no-session",
		"--no-title",
		"--model",
		"@default",
		"--max-time",
		SESSION_MAX_TIME,
		"--no-extensions",
		"-e",
		extensionPath,
		"--no-skills",
		"--no-rules",
		"--approval-mode",
		"write",
		"--tools",
		tools.join(","),
		"--config",
		overlayPath,
		"--append-system-prompt",
		policyPath,
		promptFor(dossier),
	];
	// The credential is invisible to the agent; arm B gets none because it has no tool that could use one.
	const env = order.arm === "B" ? childEnv(run, { jev: "0" }) : childEnv(run, { jev: "1", openRouterKey: key });

	try {
		const agent = await runProcess(argv, run.workspace, SESSION_TIMEOUT_MS, env);
		const metrics = summarizeTranscript(agent.stdout);
		const publicRun = await runProcess(["bun", PUBLIC_TEST], run.workspace, CHECK_TIMEOUT_MS, checkEnv(run));
		const graderRun = await runProcess(["bun", graderPath, run.workspace], run.root, CHECK_TIMEOUT_MS, checkEnv(run));
		let parsedAnswers: Record<string, unknown> = {};
		try {
			parsedAnswers = JSON.parse(readFileSync(answersPath, "utf8")) as Record<string, unknown>;
		} catch {
			parsedAnswers = {};
		}
		const answers: ForkAnswer[] = dossier.forks.map((fork) => {
			const answer = textOf(parsedAnswers[fork.id]);
			return { fork: fork.id, answer, correct: answer === fork.oracle };
		});
		const real = metrics.decisions.filter((decision) => !decision.fabricated);
		// Adoption is only comparable on the first fork: in arm E the agent can learn within the session
		// that the tool never helps and stop calling it, so later calls are a decay curve. Calls are not
		// tagged with a fork id, so this uses the observable proxy the protocol names - the tool was called
		// before anything was written down.
		const firstWrite = metrics.toolCallSequence.findIndex((name) => name === "write" || name === "edit");
		const callIndexInSequence = metrics.toolCallSequence.findIndex((name) => name === TOOL_NAME);
		const calledBeforeFirstWrite = callIndexInSequence >= 0 && (firstWrite < 0 || callIndexInSequence < firstWrite);

		const transcriptPath = join(runDir, `${label}.jsonl`);
		writeFileSync(transcriptPath, redact(agent.stdout, secrets), "utf8");
		const stderrTail = redact(agent.stderr, secrets).trim().slice(-400);
		if (stderrTail.length > 0) writeFileSync(join(runDir, `${label}.stderr.txt`), stderrTail, "utf8");
		let controlLog = 0;
		if (order.arm === "E" && existsSync(controlLogPath)) {
			const logText = readFileSync(controlLogPath, "utf8").trim();
			controlLog = logText.length === 0 ? 0 : logText.split("\n").length;
			writeFileSync(join(runDir, `${label}.control-calls.jsonl`), redact(logText, secrets), "utf8");
		}

		let violation: string | null = null;
		if (metrics.missingToolEnds.length > 0) violation = "a tool call never returned an end event";
		else if (metrics.extensionErrors > 0) violation = `the extension reported ${metrics.extensionErrors} error(s)`;
		else if (hashFile(briefPath) !== briefHash) violation = "brief.json was modified";
		else if (hashFile(testPath) !== testHash) violation = `the public check was modified`;
		else if (hashOf(readFileSync(graderPath, "utf8")) !== graderHash) violation = "the private grader was modified";
		else if (order.arm === "B" && metrics.decisions.length > 0) violation = "the baseline arm called the tool";
		else if (order.arm === "B" && metrics.toolCounts[TOOL_NAME] !== undefined) violation = "the baseline arm saw the tool";
		else if (order.arm === "E" && metrics.decisions.some((decision) => !decision.fabricated)) violation = "the control arm reached the real tool";
		else if (order.arm === "J" && metrics.decisions.some((decision) => decision.fabricated)) violation = "the treatment arm reached the control tool";
		else if (metrics.mainModels.length > 0 && metrics.mainModels.some((model) => model !== `${MAIN_PROVIDER}/${MAIN_MODEL_ID}`))
			violation = `the session ran on ${metrics.mainModels.join(",")} instead of ${MAIN_PROVIDER}/${MAIN_MODEL_ID}`;

		const jevCosts = real.map((decision) => decision.costUsd);
		const totalKnown = metrics.mainCostUsd !== null && jevCosts.every((value) => value !== null);
		const record: SessionRecord = {
			dossier: dossier.id,
			repeat: order.repeat,
			arm: order.arm,
			agentMs: agent.ms,
			agentExitCode: agent.code,
			agentTimedOut: agent.timedOut,
			publicCheck: publicRun.code === 0 ? "passed" : "failed",
			grader: graderRun.code === 0 ? "passed" : "failed",
			answers,
			forksCorrect: answers.filter((entry) => entry.correct).length,
			mainModels: metrics.mainModels,
			turns: metrics.turns,
			missingToolEnds: metrics.missingToolEnds,
			extensionErrors: metrics.extensionErrors,
			realCalls: metrics.realCalls,
			controlCalls: metrics.controlCalls,
			calledBeforeFirstWrite,
			callsByFork: metrics.decisions.map((decision, index) => ({
				callIndex: index,
				mode: decision.requestedMode,
				questions: decision.questionCount,
				toolInputBytes: decision.toolInputBytes,
				reason: decision.reason,
				pickedOracle: decision.topScoreIds
					? decision.topScoreIds.length === 1 && dossier.forks.some((fork) => fork.oracle === decision.topScoreIds?.[0])
						? true
						: false
					: decision.candidateId !== null
						? dossier.forks.some((fork) => fork.oracle === decision.candidateId)
						: null,
			})),
			realDeferred: metrics.realDeferred,
			realUncertain: metrics.realUncertain,
			controlAnswers: metrics.controlAnswers,
			failures: metrics.failures,
			authoringFailures: metrics.authoringFailures,
			jevLatencyMs: metrics.jevLatencyMs,
			jevCostUsd: jevCosts,
			mainCostUsd: metrics.mainCostUsd,
			totalCostUsd: totalKnown ? Number(((metrics.mainCostUsd as number) + jevCosts.reduce((total, value) => total + (value as number), 0)).toFixed(6)) : null,
			costStatus: metrics.costStatus,
			totalTokens: metrics.totalTokens,
			briefUnmodified: hashFile(briefPath) === briefHash,
			testsUnmodified: hashFile(testPath) === testHash,
			graderUnmodified: hashOf(readFileSync(graderPath, "utf8")) === graderHash,
			controlLog,
			transcriptPath: transcriptPath.replace(REPO, "<repo>"),
			envKeys: Object.keys(env).sort(),
		};
		return { record, violation };
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- freeze

function freezeManifest(cases: CaseFile, phase: string): Record<string, unknown> {
	const dossiers = cases.dossiers.filter((dossier) => STAGE2_DOSSIERS.includes(dossier.id));
	return {
		protocol: "jev-effective-protocol-2",
		phase,
		frozenAt: new Date().toISOString(),
		hashes: {
			runner: hashFile(RUNNER_PATH),
			cases: hashFile(CASES_PATH),
			stubExtension: hashFile(STUB_EXTENSION),
			decisionMaker: hashFile(EXTENSION),
			shippedRules: hashFile(RULES_PATH),
			metricRules: hashOf(JSON.stringify(METRIC_RULES)),
			commonPolicy: hashOf(COMMON_POLICY),
			shippedPolicyAppend: hashOf(shippedPolicyAppend()),
			agentsMd: hashOf(AGENTS_MD),
			dossierBriefs: Object.fromEntries(dossiers.map((dossier) => [dossier.id, hashOf(briefOf(dossier))])),
			dossierPrompts: Object.fromEntries(dossiers.map((dossier) => [dossier.id, hashOf(promptFor(dossier))])),
			publicChecks: Object.fromEntries(dossiers.map((dossier) => [dossier.id, hashOf(publicCheckOf(dossier))])),
			privateGraders: Object.fromEntries(dossiers.map((dossier) => [dossier.id, hashOf(graderOf(dossier))])),
			order: hashOf(JSON.stringify(ORDERS.stage2)),
		},
		caseIds: cases.dossiers.flatMap((dossier) => dossier.forks.map((fork) => `${fork.id}:${fork.oracle}`)),
		permutedForks: PERMUTED_FORKS,
		mainModel: MAIN_MODEL,
	};
}

// ---------------------------------------------------------------- reports

type RunFile = {
	generatedAt: string;
	phase: "stage1" | "stage2";
	runDir?: string;
	versions: { omp: string; bun: string };
	credentialSource: string;
	credentialVisibleToChild: boolean | null;
	freeze: Record<string, unknown>;
	stage1?: {
		calls: Stage1Call[];
		summary: Record<string, unknown>;
		/** The bars the run actually applied, with the code hash that computed them. */
		thresholds?: { usefulItems: number; stopItems: number; commitCalls: number; forks: number; calls: number; clientFailureLimit: number; runnerHash: string };
	};
	stage2?: { sessions: SessionRecord[]; preflight: SessionRecord | null; summary: Record<string, unknown> };
	gate: Record<string, unknown>;
};

function stage1Summary(calls: Stage1Call[], cases: CaseFile): Record<string, unknown> {
	const forks = cases.dossiers.flatMap((dossier) => dossier.forks);
	const byFork = forks.map((fork) => {
		const views = calls.filter((call) => call.fork === fork.id);
		const select = views.find((view) => view.view === "select");
		const score = views.find((view) => view.view === "score");
		const permuted = views.find((view) => view.view === "score-permuted");
		return {
			fork: fork.id,
			oracle: fork.oracle,
			selectPicked: select?.picked ?? null,
			scorePicked: score?.picked ?? null,
			tied: score ? score.topScoreIds !== null && score.topScoreIds.length > 1 : null,
			itemCorrect: Boolean(select?.picked) && Boolean(score?.picked),
			positionFlip: permuted ? Boolean(score?.picked) !== Boolean(permuted.picked) : null,
		};
	});
	const itemsCorrect = byFork.filter((entry) => entry.itemCorrect).length;
	const committedCalls = calls.filter((call) => call.committed).length;
	// `invalid_input` never reaches the resolver or the network, so it is an authoring error rather than an
	// endpoint failure: keeping the two apart stops a fixture typo from reading as a broken endpoint.
	const clientFailures = calls.filter((call) => call.reason !== null && PRODUCT_FAILURE_REASONS.includes(call.reason)).length;
	const authoringErrors = calls.filter((call) => call.reason === "invalid_input").length;
	const nameOf = (call: Stage1Call) => `${call.fork}:${call.view}:${call.reason}`;
	const clientFailureCalls = calls.filter((call) => call.reason !== null && PRODUCT_FAILURE_REASONS.includes(call.reason)).map(nameOf);
	const authoringCalls = calls.filter((call) => call.reason === "invalid_input").map(nameOf);
	const failedCalls = [...clientFailureCalls, ...authoringCalls];
	const flips = byFork.filter((entry) => entry.positionFlip === true).length;
	const perView = (view: string) => {
		const own = calls.filter((call) => call.view === view);
		return {
			calls: own.length,
			picked: own.filter((call) => call.picked).length,
			committed: own.filter((call) => call.committed).length,
			tied: own.filter((call) => call.topScoreIds !== null && call.topScoreIds.length > 1).length,
			latencyMs: own.map((call) => call.latencyMs),
			costUsd: own.map((call) => call.costUsd),
			requestCounts: own.map((call) => call.requestCount),
			requestBytes: own.map((call) => call.requestBytes),
			questionCounts: own.map((call) => call.questionCount),
			singleRequest: own.every((call) => call.requestCount === 1),
		};
	};
	const rate = (part: number, whole: number) => (whole === 0 ? null : Number((part / whole).toFixed(4)));
	return {
		forks: forks.length,
		itemsCorrect,
		itemRate: rate(itemsCorrect, forks.length),
		itemInterval: wilson(itemsCorrect, forks.length),
		committedCalls,
		commitRate: rate(committedCalls, calls.length),
		commitInterval: wilson(committedCalls, calls.length),
		accuracyAmongCommits: rate(calls.filter((call) => call.committed && call.picked).length, committedCalls),
		clientFailures,
		authoringErrors,
		clientFailureCalls,
		authoringCalls,
		failedCalls,
		positionFlips: flips,
		byFork,
		views: { select: perView("select"), score: perView("score"), "score-permuted": perView("score-permuted") },
	};
}

function stage2Summary(sessions: SessionRecord[], cases: CaseFile): Record<string, unknown> {
	const perArm = ARMS.map((arm) => {
		const own = sessions.filter((session) => session.arm === arm);
		const decisions = own.reduce((total, session) => total + session.answers.length, 0);
		const correct = own.reduce((total, session) => total + session.forksCorrect, 0);
		const firstForkCalls = own.filter((session) => session.calledBeforeFirstWrite).length;
		return {
			arm,
			sessions: own.length,
			forkDecisions: decisions,
			forkCorrect: correct,
			forkAccuracy: decisions === 0 ? null : Number((correct / decisions).toFixed(4)),
			interval: wilson(correct, decisions),
			firstForkCallRate: own.length === 0 ? null : Number((firstForkCalls / own.length).toFixed(4)),
			calls: own.reduce((total, session) => total + session.realCalls, 0),
			controlCalls: own.reduce((total, session) => total + session.controlCalls, 0),
			realDeferred: own.reduce((total, session) => total + session.realDeferred, 0),
			realUncertain: own.reduce((total, session) => total + session.realUncertain, 0),
			controlAnswers: own.reduce((total, session) => total + session.controlAnswers, 0),
			agentMs: own.map((session) => session.agentMs),
			medianAgentMs: own.length === 0 ? null : median(own.map((session) => session.agentMs)),
			totalCostUsd: own.map((session) => session.totalCostUsd),
			medianTokens: own.length === 0 ? null : median(own.map((session) => session.totalTokens ?? 0)),
		};
	});
	const pairs = STAGE2_DOSSIERS.flatMap((dossier) =>
		STAGE2_REPEATS.map((repeat) => {
			const baseline = sessions.find((session) => session.dossier === dossier && session.repeat === repeat && session.arm === "B");
			const treatment = sessions.find((session) => session.dossier === dossier && session.repeat === repeat && session.arm === "J");
			const control = sessions.find((session) => session.dossier === dossier && session.repeat === repeat && session.arm === "E");
			if (!baseline) return null;
			const delta = (other?: SessionRecord) => (other ? Number((other.agentMs - baseline.agentMs).toFixed(1)) : null);
			return {
				dossier,
				repeat,
				baselineAgentMs: baseline.agentMs,
				treatmentAgentMs: treatment?.agentMs ?? null,
				controlAgentMs: control?.agentMs ?? null,
				deltaJ: delta(treatment),
				deltaE: delta(control),
				forkAccuracyJ: treatment?.forksCorrect ?? null,
				forkAccuracyE: control?.forksCorrect ?? null,
				forkAccuracyB: baseline.forksCorrect,
			};
		}),
	).filter((pair): pair is NonNullable<typeof pair> => pair !== null);
	const medianDeltaJ = median(pairs.map((pair) => pair.deltaJ).filter((value): value is number => value !== null));
	const medianDeltaE = median(pairs.map((pair) => pair.deltaE).filter((value): value is number => value !== null));
	return {
		perArm,
		pairs,
		medianDeltaJ,
		medianDeltaE,
		attribution: Number((medianDeltaJ - medianDeltaE).toFixed(1)),
		dossierCount: STAGE2_DOSSIERS.length,
	};
}

function renderReport(results: RunFile): string {
	const lines: string[] = [];
	const dossiers = casesCache?.dossiers.filter((dossier) => STAGE2_DOSSIERS.includes(dossier.id)) ?? [];
	lines.push(`# Protocol v2 — ${results.phase === "stage1" ? "Stage 1: phán đoán trực tiếp" : "Stage 2: ba arm"}`);
	lines.push("");
	lines.push(
		`Sinh lúc ${results.generatedAt}${results.runDir ? `, run dir \`${results.runDir}\`` : ""}. ` +
			`omp ${results.versions.omp}, bun ${results.versions.bun}. Nguồn credential: \`${results.credentialSource}\` (không ghi giá trị). ` +
			`Freeze: runner \`${String((results.freeze.hashes as Record<string, string>).runner).slice(0, 12)}\`, cases \`${String((results.freeze.hashes as Record<string, string>).cases).slice(0, 12)}\`, metric rules \`${String((results.freeze.hashes as Record<string, string>).metricRules).slice(0, 12)}\`.`,
	);
	lines.push("");
	if (results.stage1) {
		const s = results.stage1.summary as Record<string, any>;
		lines.push("## 1. Chức năng");
		lines.push("");
		lines.push(
			`- ${(s.views.select as Record<string, any>).calls + (s.views.score as Record<string, any>).calls + (s.views["score-permuted"] as Record<string, any>).calls} call trực tiếp, mỗi call đúng **một** HTTP request: select ${String((s.views.select as Record<string, any>).singleRequest)}, score ${String((s.views.score as Record<string, any>).singleRequest)}, permuted ${String((s.views["score-permuted"] as Record<string, any>).singleRequest)}.`,
		);
		const clientCalls = clientNames(s);
		const authoringCalls = authoringNames(s);
		lines.push(
			`- Client failure: **${String(s.clientFailures)}** (trần đã đóng băng ${String(CLIENT_FAILURE_LIMIT)}; vượt trần mới làm batch vô hiệu)${clientCalls.length > 0 ? ` — ${clientCalls.join(", ")}` : ""}. Lỗi authoring (\`invalid_input\`, không tính là client failure): **${String(s.authoringErrors)}**${authoringCalls.length > 0 ? ` — ${authoringCalls.join(", ")}` : ""}.`,
		);
		lines.push("");
		lines.push("## 2. Độ chính xác phán đoán");
		lines.push("");
		lines.push(`- Hạng mục đúng (cả select và score đều chỉ đúng oracle): **${String(s.itemsCorrect)}/${String(s.forks)}** (khoảng Wilson ${JSON.stringify(s.itemInterval)}).`);
		lines.push(`- Tỉ lệ ra quyết định (committed): **${String(s.committedCalls)}** call (${String(s.commitRate)}, khoảng ${JSON.stringify(s.commitInterval)}); trong số đó đúng **${String(s.accuracyAmongCommits)}**.`);
		lines.push(`- Hoà ở đỉnh: ${(s.views.score as Record<string, any>).tied} call score. Đảo thứ tự candidate làm đổi kết quả ở **${String(s.positionFlips)}** ngã rẽ.`);
		lines.push("");
		lines.push("| Ngã rẽ | Oracle | select đúng | score đúng | hoà | hạng mục | đảo thứ tự |");
		lines.push("|---|---|---|---|---|---|---|");
		for (const row of s.byFork as Array<Record<string, any>>) {
			lines.push(`| ${row.fork} | ${row.oracle} | ${row.selectPicked} | ${row.scorePicked} | ${row.tied} | ${row.itemCorrect} | ${row.positionFlip ?? "n/a"} |`);
		}
		lines.push("");
		lines.push("## 3. Thời gian và chi phí");
		lines.push("");
		for (const view of ["select", "score", "score-permuted"] as const) {
			const own = s.views[view] as Record<string, any>;
			lines.push(
				`- ${view}: latency ${list((own.latencyMs as Array<number | null>).filter((value): value is number => value !== null))} ms, cost ${list(own.costUsd as Array<number | null>)} USD, ${own.requestBytes.join("/")} byte, câu hỏi/call ${own.questionCounts.join("/")}.`,
			);
		}
		lines.push("- Latency là số mô tả, không phải hằng số theo mode: cùng một shape đã dao động khoảng 10% giữa các lần và tới ~50% giữa hai lần chạy của cùng một batch score.");
		lines.push("");
		lines.push("## 4. Kết luận theo quy tắc đã đóng băng");
		lines.push("");
		// Read-only over the artifact: the bars printed are the ones the run stored, never recomputed from
		// constants that may have moved since. A render must not be able to rewrite an old run's rule.
		const thresholds = (results.stage1 as Record<string, any>).thresholds as Record<string, unknown> | undefined;
		if (thresholds) {
			lines.push(
				`- Ngưỡng **đã áp lúc chạy** (lấy từ \`results.json\`, không tính lại): hữu ích nếu hạng mục ≥ ${String(thresholds.usefulItems)}/${String(thresholds.forks)} **và** commit ≥ ${String(thresholds.commitCalls)}/${String(thresholds.calls)} **call** (đơn vị call, không phải fork) **và** client failure ≤ ${String(thresholds.clientFailureLimit)}; dừng nếu hạng mục ≤ ${String(thresholds.stopItems)}/${String(thresholds.forks)}. Runner sinh ra chúng: \`${String(thresholds.runnerHash).slice(0, 12)}…\`. Kết quả: **${String(results.gate.stage1Verdict)}**.`,
			);
		} else {
			lines.push(
				`- Ngưỡng: **lần chạy này không lưu ngưỡng đã áp** (trường \`thresholds\` ra đời sau nó), nên báo cáo không được phép tính lại: con số nằm trong note đã lưu ngay dưới đây. Sửa code sau lần chạy chỉ đổi phần in, không đổi phán quyết — xem \`report-errata.md\` cùng run dir.`,
			);
		}
		lines.push(`- ${String(results.gate.stage1Note)}`);
	} else if (results.stage2) {
		const s = results.stage2.summary as Record<string, any>;
		lines.push("## 1. Chức năng và adoption");
		lines.push("");
		for (const arm of s.perArm as Array<Record<string, any>>) {
			lines.push(
				`- Arm ${arm.arm}: ${arm.sessions} phiên, ${arm.forkDecisions} quyết định, ${arm.forkCorrect} đúng (${arm.forkAccuracy}, khoảng ${JSON.stringify(arm.interval)}); **proxy "tool được gọi trước lần ghi đầu tiên"** ${arm.firstForkCallRate} (đếm từ thứ tự tool call trong transcript — proxy cho adoption ở fork đầu, không phải số theo mã fork); tool call thật ${arm.calls}, câu trả lời rỗng ${arm.controlCalls} (đếm từ \`control-calls.jsonl\` do stub ghi); deferred thật ${arm.realDeferred}, uncertain thật ${arm.realUncertain}.`,
			);
		}
		const eSample = (s.perArm as Array<Record<string, any>>).find((arm) => arm.arm === "E")?.sessions ?? 0;
		lines.push(
			`- Pre-flight: ${(results.stage2 as Record<string, any>).preflight ? `một phiên arm E đã chạy trước 18 phiên và không vào mẫu (mẫu còn ${String(eSample)} phiên E)` : "không ghi nhận"}; tốn ~0,03 USD và 0 request JEV.`,
		);
		lines.push("- Arm E trả `reason: \"control\"`: đó là câu trả lời **bịa**, không phải model từ chối. Bộ đếm deferred/uncertain của E được in riêng, không gộp với J.");
		lines.push("- `latencyMs`/`costUsd` của arm E là hằng số của stub (0), không so trực tiếp với latency thật của J như một phát hiện về tốc độ.");
		lines.push("");
		lines.push("## 2. Thời gian và phần quy cho phán đoán");
		lines.push("");
		lines.push("| Dossier | Repeat | B (ms) | J (ms) | E (ms) | ΔJ | ΔE |");
		lines.push("|---|---|---|---|---|---|---|");
		for (const pair of s.pairs as Array<Record<string, any>>) {
			lines.push(`| ${pair.dossier} | ${pair.repeat} | ${pair.baselineAgentMs} | ${pair.treatmentAgentMs ?? "n/a"} | ${pair.controlAgentMs ?? "n/a"} | ${pair.deltaJ ?? "n/a"} | ${pair.deltaE ?? "n/a"} |`);
		}
		lines.push(`- median ΔJ = ${String(s.medianDeltaJ)} ms, median ΔE = ${String(s.medianDeltaE)} ms ⇒ **phần quy cho phán đoán = ${String(s.attribution)} ms** (âm nghĩa là phán đoán rẻ hơn việc bị bắt gọi).`);
		lines.push("- Arm E đo chi phí *gọi + phơi nhiễm placebo*, không phải chi phí gọi thuần: trong một phiên agent có thể học rằng tool rỗng và ngừng gọi. Đó là giới hạn đã ghi trong protocol.");
		lines.push("");
		lines.push("## 3. Kết luận theo quy tắc đã đóng băng");
		lines.push("");
		lines.push(`- ${String(results.gate.stage2Verdict)}`);
		lines.push(`- ${String(results.gate.stage2Note)}`);
		lines.push(`- ${dossiers.length} dossier × 3 fork × 3 repeat; n=18 quyết định/arm nên mọi so sánh chỉ là mô tả, khoảng Wilson in kèm, không dùng chữ "significance".`);
	}
	lines.push("");
	lines.push("## Giới hạn");
	lines.push("");
	lines.push(`- ${String(results.gate.limitations)}`);
	return `${lines.join("\n")}\n`;
}

let casesCache: CaseFile | null = null;
function renderFromResults(resultsPath: string, outPath: string): number {
	let stored: RunFile;
	try {
		stored = JSON.parse(readFileSync(resultsPath, "utf8")) as RunFile;
	} catch (error) {
		console.error(`cannot read results: ${resultsPath} (${error instanceof Error ? error.message : String(error)})`);
		return 1;
	}
	if (existsSync(outPath)) {
		console.error(`refusing to overwrite an existing report: ${outPath}`);
		return 1;
	}
	casesCache = loadCases();
	mkdirSync(dirname(outPath), { recursive: true });
	// Two artifact shapes live in this tree: the arm/arm A-B report and the sweep report. Render whichever
	// one the file actually is, instead of assuming the older shape and crashing on the newer.
	const sweep = stored as unknown as SweepResults;
	const body = sweep.decision === undefined ? renderReport(stored) : sweepReport(sweep);
	writeFileSync(outPath, body, { encoding: "utf8", flag: "wx" });
	console.log(`report: ${outPath}`);
	return 0;
}

// ---------------------------------------------------------------- live drivers

async function versionPair(): Promise<{ omp: string; bun: string }> {
	const run = makeIsolatedRun("version", PLACEHOLDER_MODELS);
	try {
		const [omp, bun] = await Promise.all([
			runProcess(["omp", "--version"], run.workspace, 60_000, childEnv(run, {})),
			runProcess(["bun", "--version"], run.workspace, 30_000, childEnv(run, {})),
		]);
		return { omp: omp.stdout.trim() || "unknown", bun: bun.stdout.trim() || "unknown" };
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

async function preflight(): Promise<{ key: string; source: CredentialSource; secrets: string[]; versions: { omp: string; bun: string } } | null> {
	const secrets: string[] = [];
	let models: string;
	try {
		models = buildModelsYmlFile();
	} catch (error) {
		console.error(`blocked before any paid work: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	secrets.push(models, ...modelSecrets(models));
	let credential: { source: CredentialSource; key: string };
	try {
		credential = resolveCredential();
	} catch (error) {
		console.error(`blocked: no usable openrouter credential - ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	secrets.push(credential.key);
	if (!(await confirmChildCredential(credential.key))) {
		console.error("blocked: the isolated child cannot resolve the credential; no paid request was started.");
		return null;
	}
	return { key: credential.key, source: credential.source, secrets, versions: await versionPair() };
}

/** Frozen in METRIC_RULES: more than three product client failures invalidates a stage, in both stages. */
const CLIENT_FAILURE_LIMIT = 3;

/**
 * The two failure classes carry their own name lists, and both readers fall back to the combined
 * `failedCalls` a run stored before this split existed, so an older results.json still renders correctly.
 */
function clientNames(summary: Record<string, any>): string[] {
	if (Array.isArray(summary.clientFailureCalls)) return summary.clientFailureCalls as string[];
	return ((summary.failedCalls as string[]) ?? []).filter((entry) => !entry.endsWith(":invalid_input"));
}

function authoringNames(summary: Record<string, any>): string[] {
	if (Array.isArray(summary.authoringCalls)) return summary.authoringCalls as string[];
	return ((summary.failedCalls as string[]) ?? []).filter((entry) => entry.endsWith(":invalid_input"));
}

function stage1Verdict(summary: Record<string, any>): { verdict: string; note: string } {
	const items = summary.itemsCorrect as number;
	const forks = summary.forks as number;
	const commits = summary.committedCalls as number;
	const calls = (summary.views.select.calls as number) + (summary.views.score.calls as number) + (summary.views["score-permuted"].calls as number);
	// The bar comes from the frozen ratios (24/30 and 19/30), not from a rounded constant.
	const usefulItems = Math.round((forks * 24) / 30);
	const stopItems = Math.round((forks * 19) / 30);
	// Same unit the frozen rules name: the bar counts CALLS, and 20/70 is the frozen ratio, not 0.667.
	const commitTarget = Math.ceil(calls * (20 / 70));
	const tolerated =
		summary.clientFailures > 0
			? ` ${summary.clientFailures} client failure (≤ trần ${CLIENT_FAILURE_LIMIT}) được tính là không chọn được oracle và không ra quyết định; batch vẫn hợp lệ.`
			: "";
	if (summary.authoringErrors > 0)
		return {
			verdict: "không kết luận được: case file có lỗi authoring",
			note: `${summary.authoringErrors} call trả invalid_input (${authoringNames(summary).join(", ")}): đây là lỗi của fixture chứ không phải của endpoint. Sửa case file rồi chạy lại; phần còn lại không dùng để kết luận.`,
		};
	if (summary.clientFailures > CLIENT_FAILURE_LIMIT)
		return {
			verdict: "không kết luận được: quá nhiều client failure",
			note: `${summary.clientFailures} call lỗi vượt trần đã đóng băng ${CLIENT_FAILURE_LIMIT} (${clientNames(summary).join(", ")}): batch vô hiệu, chạy lại với endpoint sạch, không hạ ngưỡng để bù.`,
		};
	if (items <= stopItems)
		return { verdict: "dừng — không chi Stage 2", note: `Hạng mục ${items}/${forks} ≤ ${stopItems}: phán đoán không đủ tin cho dạng câu hỏi này, bất kể trigger.${tolerated}` };
	if (items >= usefulItems && commits >= commitTarget)
		return {
			verdict: "đủ tin để chạy Stage 2",
			note: `Hạng mục ${items}/${forks} và commit ${commits}/${calls} call đạt ngưỡng đã đóng băng (commit ≥ ${commitTarget}/${calls} call).${tolerated}`,
		};
	if (items >= usefulItems && commits < commitTarget)
		return {
			verdict: "model chọn đúng nhưng ngưỡng 0.90/0.95 chặn",
			note: `Hạng mục ${items}/${forks} nhưng chỉ ${commits}/${calls} call ra quyết định (ngưỡng ${commitTarget}/${calls} call): đây là kết quả, không phải lý do hạ ngưỡng trong batch này.${tolerated}`,
		};
	return { verdict: "không kết luận", note: `Hạng mục ${items}/${forks} nằm giữa hai ngưỡng đã đóng băng; báo cáo là inconclusive.${tolerated}` };
}

async function runStage1(): Promise<number> {
	const cases = loadCases();
	const problems = validateCases(cases);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`invalid case file: ${problem}`);
		return 1;
	}
	casesCache = cases;
	const pre = await preflight();
	if (!pre) return 1;
	mkdirSync(ARTIFACTS, { recursive: true });
	const runDir = mkdtempSync(join(ARTIFACTS, "run-"));
	const freeze = freezeManifest(cases, "stage1");
	writeFileSync(join(runDir, "freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
	const { calls } = await stage1(runDir, cases, pre.secrets, pre.key);
	const summary = stage1Summary(calls, cases) as Record<string, any>;
	const { verdict, note } = stage1Verdict(summary);
	const results: RunFile = {
		generatedAt: new Date().toISOString(),
		phase: "stage1",
		runDir: runDir.replace(REPO, "<repo>"),
		versions: pre.versions,
		credentialSource: pre.source,
		credentialVisibleToChild: true,
		freeze,
		stage1: {
			calls,
			summary,
			thresholds: {
				usefulItems: Math.round((cases.dossiers.flatMap((dossier) => dossier.forks).length * 24) / 30),
				stopItems: Math.round((cases.dossiers.flatMap((dossier) => dossier.forks).length * 19) / 30),
				commitCalls: Math.ceil(calls.length * (20 / 70)),
				forks: cases.dossiers.flatMap((dossier) => dossier.forks).length,
				calls: calls.length,
				clientFailureLimit: CLIENT_FAILURE_LIMIT,
				runnerHash: hashFile(RUNNER_PATH),
			},
		},
		gate: {
			stage1Verdict: verdict,
			stage1Note: note,
			limitations:
				"Stage 1 đo phán đoán của model, không đo adoption: nó gọi decide() trực tiếp nên bỏ qua câu hỏi agent có chịu gọi hay không. Ba view của cùng một ngã rẽ không độc lập, nên đơn vị đếm là ngã rẽ chứ không phải call. Không có kết luận nhân quả nào ở đây.",
		},
	};
	writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
	writeFileSync(join(runDir, "report.md"), renderReport(results), "utf8");
	console.log(`stage1: ${calls.length} calls, items ${String(summary.itemsCorrect)}/${String(summary.forks)}, commits ${String(summary.committedCalls)}`);
	console.log(`verdict: ${verdict}`);
	console.log(`results: ${join(runDir, "results.json")}`);
	// The exit code follows the same rule the verdict text used: an authoring error or a breach of the
	// frozen client-failure limit invalidates the stage; an isolated failure does not.
	return summary.authoringErrors > 0 || summary.clientFailures > CLIENT_FAILURE_LIMIT ? 1 : 0;
}

async function runStage2(): Promise<number> {
	const cases = loadCases();
	const problems = validateCases(cases);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`invalid case file: ${problem}`);
		return 1;
	}
	casesCache = cases;
	const pre = await preflight();
	if (!pre) return 1;
	mkdirSync(ARTIFACTS, { recursive: true });
	const runDir = mkdtempSync(join(ARTIFACTS, "run-"));
	const freeze = freezeManifest(cases, "stage2");
	writeFileSync(join(runDir, "freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, "utf8");

	// Pre-flight: one arm-E session before any paid Stage-2 session. It spends zero JEV requests and
	// exercises the whole session path - argv, brief, policy append, tool exposure, graders, transcript
	// parse, `control-calls.jsonl` copy and record assembly - which is exactly where the previous batch lost
	// money to a driver bug no offline check could see. Its result never joins the paired denominators.
	const preflightOrder = { dossier: STAGE2_DOSSIERS[0], repeat: 0, arm: "E" as Arm };
	let preflightRecord: SessionRecord | null = null;
	try {
		const { record, violation } = await runSession(preflightOrder, runDir, cases, pre.secrets, pre.key);
		preflightRecord = record;
		console.log(`preflight ${record.dossier}-${record.repeat}${record.arm} (không vào mẫu): forks ${record.forksCorrect}/${record.answers.length}, calls ${record.realCalls}+${record.controlCalls}ctl`);
		if (violation) {
			console.error(`aborted before any paid Stage-2 session: preflight ${violation}`);
			writeFileSync(join(runDir, "preflight-blocked.json"), `${JSON.stringify({ aborted: `preflight: ${violation}`, record }, null, 2)}\n`, "utf8");
			return 1;
		}
		// When the agent did call the tool, the two things the driver could get wrong about the control are
		// checked here rather than trusted: the answer must be the fabricated `control` result, and the stub's
		// call log must be where the reader looks for it. When the agent did not call, that is recorded as
		// "not exercised" - this pre-flight proves the session path, it cannot force a call, and adoption is
		// what Stage 2 measures.
		const preflightNotes: string[] = [];
		if (record.controlCalls > 0) {
			if (record.controlAnswers !== record.controlCalls) {
				console.error(`aborted before any paid Stage-2 session: preflight saw ${record.controlCalls} control calls but ${record.controlAnswers} control answers`);
				writeFileSync(join(runDir, "preflight-blocked.json"), `${JSON.stringify({ aborted: "preflight: control answers do not match control calls", record }, null, 2)}\n`, "utf8");
				return 1;
			}
			if (record.controlLog !== record.controlCalls) {
				console.error(`aborted before any paid Stage-2 session: preflight saw ${record.controlCalls} control calls but ${record.controlLog} lines in control-calls.jsonl`);
				writeFileSync(join(runDir, "preflight-blocked.json"), `${JSON.stringify({ aborted: "preflight: the stub call log was not written where the reader looks", record }, null, 2)}\n`, "utf8");
				return 1;
			}
			preflightNotes.push(`control tool exercised: ${record.controlCalls} call, ${record.controlAnswers} answer \`control\`, ${record.controlLog} dòng log`);
		} else {
			preflightNotes.push("control tool không được gọi trong pre-flight (không exercise được câu trả lời `control`); adoption là việc của 18 phiên");
		}
		preflightNotes.push(`public check ${record.publicCheck}, grader ${record.grader}, main model ${record.mainModels.join(",") || "none"}, turns ${record.turns}`);
		writeFileSync(join(runDir, "preflight.json"), `${JSON.stringify({ notes: preflightNotes, record }, null, 2)}\n`, "utf8");
		console.log(`preflight: ${preflightNotes.join(" | ")}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`aborted before any paid Stage-2 session: preflight threw - ${message}`);
		writeFileSync(join(runDir, "preflight-blocked.json"), `${JSON.stringify({ aborted: `preflight threw: ${message}` }, null, 2)}\n`, "utf8");
		return 1;
	}

	const sessions: SessionRecord[] = [];
	let aborted: string | null = null;
	let clientFailures = 0;
	let authoringFailures = 0;
	for (const entry of ORDERS.stage2) {
		try {
			const { record, violation } = await runSession(entry, runDir, cases, pre.secrets, pre.key);
			sessions.push(record);
			clientFailures += record.failures.length;
			authoringFailures += record.authoringFailures.length;
			console.log(
				`${record.dossier}-${record.repeat}${record.arm}: agentMs ${record.agentMs}, forks ${record.forksCorrect}/${record.answers.length}, calls ${record.realCalls}+${record.controlCalls}ctl`,
			);
			if (violation) {
				aborted = violation;
				break;
			}
			if (clientFailures > CLIENT_FAILURE_LIMIT) {
				// Pre-registered: more than three client failures is a contract problem, not a data point.
				aborted = `${clientFailures} cumulative client failures exceeded the frozen limit of ${CLIENT_FAILURE_LIMIT}`;
				break;
			}
		} catch (error) {
			aborted = `${entry.dossier}-${entry.repeat}${entry.arm} failed inside the harness: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
	}

	const summary = stage2Summary(sessions, cases);
	const perArm = summary.perArm as Array<Record<string, any>>;
	const accuracy = Object.fromEntries(perArm.map((arm) => [arm.arm, arm.forkAccuracy ?? 0]));
	const firstForkRates = Object.fromEntries(perArm.map((arm) => [arm.arm, arm.firstForkCallRate ?? 0]));
	const attribution = summary.attribution as number;
	const complete = aborted === null && sessions.length === ORDERS.stage2.length;
	let verdict = "không kết luận được: batch chưa hoàn tất";
	let note = aborted ? `Dừng sớm: ${aborted}. Số đã thu vẫn được giữ nguyên.` : "";
	if (complete) {
		if (accuracy.J <= accuracy.B && Math.abs(accuracy.E - accuracy.B) <= 1 / 18) {
			verdict = "dừng đầu tư: không có lợi ích quy cho phán đoán";
			note = `forkAccuracy J ${accuracy.J} ≤ B ${accuracy.B} và E ${accuracy.E} ≈ B: phán đoán không tạo khác biệt.`;
		} else if (accuracy.J > accuracy.B && attribution >= 0) {
			verdict = "phán đoán tốt hơn nhưng chưa đáng bật mặc định";
			note = `J ${accuracy.J} > B ${accuracy.B}, nhưng attribution ${attribution} ms ≥ 0: giá phải trả không nhỏ hơn đối chứng rỗng.`;
		} else {
			verdict = "có dấu hiệu dương, cần batch lớn hơn";
			note = `J ${accuracy.J} vs B ${accuracy.B}, attribution ${attribution} ms. n=18 quyết định/arm: mô tả, không phải kiểm định.`;
		}
		if (firstForkRates.J < 3 / 6) {
			note += ` Gọi ở fork đầu chỉ ${firstForkRates.J}: cơ chế trigger là nút chặn, bước tiếp theo phải là hook tự động chứ không phải hạ ngưỡng.`;
		}
	}
	const results: RunFile = {
		generatedAt: new Date().toISOString(),
		phase: "stage2",
		runDir: runDir.replace(REPO, "<repo>"),
		versions: pre.versions,
		credentialSource: pre.source,
		credentialVisibleToChild: true,
		freeze,
		stage2: { sessions, preflight: preflightRecord, summary },
		gate: {
			aborted,
			complete,
			sessionsRun: sessions.length,
			sessionsExpected: ORDERS.stage2.length,
			clientFailures,
			authoringFailures,
			stage2Verdict: verdict,
			stage2Note: note,
			limitations:
				"Arm E đo chi phí gọi + phơi nhiễm placebo, không phải chi phí gọi thuần. n=18 quyết định/arm: mọi khác biệt là mô tả. Policy phát kèm được append nguyên văn cho cả J và E, nên khác biệt duy nhất giữa hai arm là câu trả lời của tool. KHÔNG dùng chữ significance.",
		},
	};
	writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
	writeFileSync(join(runDir, "report.md"), renderReport(results), "utf8");
	console.log(`results: ${join(runDir, "results.json")}`);
	console.log(`verdict: ${verdict}`);
	return complete ? 0 : 1;
}



// ---------------------------------------------------------------- v3: threshold sweep

/**
 * The grid and the decision rule are copied from `docs/research/jev-effective-protocol-3/protocol.md`
 * §4. They are frozen: the sweep decides one threshold per kind, on train (repeats 1-2) with a hold-out
 * (repeat 3), and refuses to move when either test fails.
 */
type SweepAxis = "probability" | "confidence";
type SweepParams = {
	grid: number[];
	confidenceGrid?: number[];
	selectRepeats: number;
	holdoutRepeats: number[];
	minTrainCommitted: number;
	minHoldoutVolume: number;
};
const V3_KINDS = ["read", "edit", "check"] as const;
const V3_PRECISION_TRAIN = 0.95;
const V3_PRECISION_HOLDOUT = 0.9;
const SWEEP_V3: SweepParams = { grid: Array.from({ length: 50 }, (_u, i) => Number((0.5 + i * 0.01).toFixed(2))), confidenceGrid: Array.from({ length: 50 }, (_u, i) => Number((0.2 + i * 0.01).toFixed(2))), selectRepeats: 3, holdoutRepeats: [3], minTrainCommitted: 5, minHoldoutVolume: 5 };
const SWEEP_V4: SweepParams = { grid: Array.from({ length: 60 }, (_u, i) => Number((0.4 + i * 0.01).toFixed(2))), confidenceGrid: Array.from({ length: 80 }, (_u, i) => Number((0.2 + i * 0.01).toFixed(2))), selectRepeats: 5, holdoutRepeats: [4, 5], minTrainCommitted: 5, minHoldoutVolume: 8 };
const SWEEP_V5: SweepParams = { grid: Array.from({ length: 60 }, (_u, i) => Number((0.4 + i * 0.01).toFixed(2))), confidenceGrid: Array.from({ length: 80 }, (_u, i) => Number((0.2 + i * 0.01).toFixed(2))), selectRepeats: 6, holdoutRepeats: [5, 6], minTrainCommitted: 5, minHoldoutVolume: 8 };

type SweepRow = { tau: number; committed: number; correct: number; precision: number | null; recall: number | null };

function sweepRows(calls: Stage1Call[], kind: string, params: SweepParams, axis: SweepAxis = "probability"): { rows: SweepRow[]; points: number; correctPoints: number } {
	const value = (call: Stage1Call) => axis === "confidence" ? call.confidence : call.probability;
	const points = calls.filter((call) => call.view === "select" && call.kind === kind && typeof value(call) === "number");
	const correctPoints = points.filter((call) => call.argmax === call.oracle).length;
	const grid = axis === "confidence" ? (params.confidenceGrid ?? params.grid) : params.grid;
	const rows = grid.map((tau) => {
		const admitted = points.filter((call) => (value(call) as number) >= tau);
		const admittedCorrect = admitted.filter((call) => call.argmax === call.oracle).length;
		return { tau, committed: admitted.length, correct: admittedCorrect, precision: admitted.length === 0 ? null : Number((admittedCorrect / admitted.length).toFixed(4)), recall: correctPoints === 0 ? null : Number((admittedCorrect / correctPoints).toFixed(4)) };
	});
	return { rows, points: points.length, correctPoints };
}

type KindDecision = { kind: string; axis?: SweepAxis; trainPoints: number; trainCorrect: number; holdoutPoints: number; currentThreshold: number; current: { precision: number | null; recall: number | null; committed: number; correct: number }; chosenTau: number | null; chosenTrain: SweepRow | null; holdout: { precision: number | null; recall: number | null; committed: number; correct: number } | null; accepted: boolean; reason: string; rows: SweepRow[] };

function decidedFor(kind: (typeof V3_KINDS)[number], calls: Stage1Call[], params: SweepParams, axis: SweepAxis): KindDecision { 
	const train = calls.filter((call) => !params.holdoutRepeats.includes(call.repeat ?? 1));
	const holdout = calls.filter((call) => params.holdoutRepeats.includes(call.repeat ?? 1));
	const currentThreshold = axis === "confidence" ? 0.5 : PROBABILITY_THRESHOLDS[kind];
	const trainSweep = sweepRows(train, kind, params, axis);
	const current = trainSweep.rows.find((row) => Math.abs(row.tau - currentThreshold) < 1e-9) ?? { tau: currentThreshold, committed: 0, correct: 0, precision: null, recall: null };
	const grid = axis === "confidence" ? (params.confidenceGrid ?? params.grid) : params.grid;
	const valid = trainSweep.rows.filter((row) => row.committed >= params.minTrainCommitted && row.precision !== null && row.precision >= V3_PRECISION_TRAIN && row.tau > grid[0]);
	const chosenTrain = valid.length > 0 ? valid.reduce((best, row) => row.tau < best.tau ? row : best) : null;
	const holdSweep = sweepRows(holdout, kind, params, axis);
	const holdRow = chosenTrain ? (holdSweep.rows.find((row) => Math.abs(row.tau - chosenTrain.tau) < 1e-9) ?? null) : null;
	const holdCurrent = holdSweep.rows.find((row) => Math.abs(row.tau - currentThreshold) < 1e-9) ?? null;
	const precisionOk = holdRow !== null && holdRow.committed >= params.minHoldoutVolume && holdRow.correct >= params.minHoldoutVolume && holdRow.precision !== null && holdRow.precision >= V3_PRECISION_HOLDOUT;
	const baselineCommitted = holdCurrent?.committed ?? 0;
	const recallImproves = baselineCommitted === 0 ? null : holdRow?.recall !== null && holdRow?.recall !== undefined && (holdCurrent?.recall ?? 0) < holdRow.recall;
	const accepted = Boolean(chosenTrain) && precisionOk && recallImproves === true;
	let reason = "đạt các điều kiện hold-out";
	if (!chosenTrain) reason = trainSweep.rows.some((row) => row.tau <= grid[0] && row.committed >= params.minTrainCommitted && row.precision !== null && row.precision >= V3_PRECISION_TRAIN) ? "dữ liệu muốn một ngưỡng dưới sàn lưới — protocol này không quyết được" : "không τ nào hợp lệ trên tập huấn luyện";
	else if (!precisionOk) reason = `hold-out không đủ bằng chứng (committed ${String(holdRow?.committed)}, correct ${String(holdRow?.correct)}, precision ${String(holdRow?.precision)})`;
 	else if (recallImproves === null) reason = "hold-out không có call nào dưới ngưỡng hiện tại nên không so được recall (so sánh vô nghĩa từ mốc 0)";
	else if (!recallImproves) reason = `hold-out recall ${String(holdRow?.recall)} không cao hơn ngưỡng hiện tại ${String(holdCurrent?.recall)}`;
	return { kind, axis, trainPoints: trainSweep.points, trainCorrect: trainSweep.correctPoints, holdoutPoints: holdSweep.points, currentThreshold, current, chosenTau: chosenTrain?.tau ?? null, chosenTrain, holdout: holdRow ? { precision: holdRow.precision, recall: holdRow.recall, committed: holdRow.committed, correct: holdRow.correct } : null, accepted, reason, rows: trainSweep.rows };
}


function sweepReport(results: SweepResults): string {
	const lines: string[] = [];
	const d = results.decision;
	const accepted = d.perKind.filter((entry) => entry.accepted);
 	lines.push(`# ${results.protocol} — ngưỡng \`select\` theo precision/recall`);
	lines.push("");
	lines.push(
		`Sinh lúc ${results.generatedAt}, run dir \`${results.runDir}\`. ${results.calls.length} call, ` +
			`${list(results.calls.map((call) => call.latencyMs))} — median ${String(median(results.calls.map((call) => call.latencyMs).filter((v): v is number => v !== null)))} ms. ` +
			`Cost tổng ${String(sumOrNull(results.calls.map((call) => call.costUsd)))} USD. ` +
			`Client failure ${String(d.clientFailures)}, lỗi authoring ${String(d.authoringErrors)}.`,
	);
	lines.push("");
	lines.push("## Kết luận");
	lines.push("");
	lines.push(
		accepted.length === 0
			? `- **Không đổi ngưỡng nào.** ${d.perKind.map((entry) => `${entry.kind}: ${entry.reason}`).join("; ")}.`
			: `- **Chấp nhận:** ${accepted.map((entry) => `${entry.kind} → ${String(entry.chosenTau)}`).join(", ")} (đã kiểm chứng trên hold-out).`,
	);
	for (const entry of d.perKind) {
		if (!entry.accepted) lines.push(`- ${entry.kind}: giữ ${String(entry.currentThreshold)} — ${entry.reason}.`);
	}
	lines.push("");
 	const sweepMeta = results.freeze.sweep as Record<string, unknown>;
	lines.push(`## Đường cong (train = repeats khác ${JSON.stringify(sweepMeta.holdoutRepeats)}, hold-out = ${JSON.stringify(sweepMeta.holdoutRepeats)})`);
	for (const entry of d.perKind) {
		lines.push("");
		lines.push(`### ${entry.kind} — ngưỡng hiện tại ${String(entry.currentThreshold)}, ${String(entry.trainCorrect)}/${String(entry.trainPoints)} call đúng oracle`);
		lines.push("");
		lines.push("| τ | commit | đúng | precision | recall |");
		lines.push("|---|---|---|---|---|");
		for (const row of entry.rows.filter((row) => row.committed > 0)) {
			lines.push(`| ${row.tau.toFixed(2)} | ${String(row.committed)} | ${String(row.correct)} | ${row.precision === null ? "n/a" : row.precision.toFixed(2)} | ${row.recall === null ? "n/a" : row.recall.toFixed(2)} |`);
		}
	}
	lines.push("");
 	lines.push(`## Hold-out = repeats ${JSON.stringify(sweepMeta.holdoutRepeats)}`);
	lines.push("");
	lines.push("| kind | ngưỡng hiện tại: precision / recall | ngưỡng đề xuất | hold-out: precision / recall | chấp nhận |");
	lines.push("|---|---|---|---|---|");
	for (const entry of d.perKind) {
		const hold = entry.holdout;
		lines.push(
			`| ${entry.kind} | ${entry.current.precision ?? "n/a"} / ${entry.current.recall ?? "n/a"} | ${entry.chosenTau === null ? "none" : entry.chosenTau.toFixed(2)} | ${hold ? `${hold.precision ?? "n/a"} / ${hold.recall ?? "n/a"}` : "n/a"} | ${entry.accepted ? "có" : "không"} |`,
		);
	}
	if (d.confidencePerKind) {
		lines.push("");
		lines.push("## Confidence axis (v5 descriptive parallel gate)");
		lines.push("");
		lines.push("| kind | current confidence 0.50 | τ confidence | hold-out precision / recall | accepted as product gate |");
		lines.push("|---|---|---|---|---|");
		for (const entry of d.confidencePerKind) {
			const hold = entry.holdout;
			lines.push(`| ${entry.kind} | ${entry.current.precision ?? "n/a"} / ${entry.current.recall ?? "n/a"} | ${entry.chosenTau === null ? "none" : entry.chosenTau.toFixed(2)} | ${hold ? `${hold.precision ?? "n/a"} / ${hold.recall ?? "n/a"}` : "n/a"} | không — confidence chỉ là trục so sánh v5 |`);
		}
		lines.push("- Confidence được chạy song song để so đường cong, nhưng v5 **không** coi nó là verdict shippable: thay đổi product gate theo confidence cần protocol chấp nhận riêng.");
	}
	lines.push("");
	// The rejected bodies are the point of the v4 instrumentation, so the report prints them instead of
	// leaving them buried in results.json: a claim nobody checks is how three invalid batches got read as
	// "the endpoint was down" when one of them was our own validator.
	const rejected = results.calls.filter((call) => call.reason === "invalid_response");
	lines.push("");
	lines.push(`## Body của ${String(rejected.length)} call bị từ chối`);
	lines.push("");
	if (rejected.length === 0) {
		lines.push("- Không có call nào trả `invalid_response` trong batch này.");
	} else {
		for (const call of rejected) {
			lines.push(`### ${call.fork}/${call.view}/r${String(call.repeat)} — HTTP ${String(call.httpStatus)}, reason \`${String(call.reason)}\``);
			lines.push("");
			lines.push(call.responseBody === undefined || call.responseBody === null ? "- (không giữ được body)" : "```json\n" + call.responseBody + "\n```");
			lines.push("");
		}
	}
	lines.push("## Giới hạn");
	lines.push("");
	lines.push(`- ${d.limitation}`);
	return `${lines.join("\n")}\n`;
}

type SweepResults = {
	generatedAt: string;
	runDir: string;
	protocol: string;
	versions: { omp: string; bun: string };
	credentialSource: string;
	freeze: Record<string, unknown>;
	calls: Stage1Call[];
 	decision: {
		perKind: KindDecision[];
		/** v5 runs both axes; v3/v4 leave this absent. Confidence never writes product gates by itself. */
		confidencePerKind?: KindDecision[];
		clientFailures: number;
		authoringErrors: number;
		aborted: { at: number; kind: string; status: number | null; reason: string | null } | null;
		limitation: string;
	};
};

const SWEEPS = {
	v3: { params: SWEEP_V3, artifacts: V3_ARTIFACTS, dir: V3_DIR, protocolId: "3" },
	v4: { params: SWEEP_V4, artifacts: V4_ARTIFACTS, dir: V4_DIR, protocolId: "4" },
	v5: { params: SWEEP_V5, artifacts: V5_ARTIFACTS, dir: V5_DIR, protocolId: "5" },
} as const;

function sweepFreeze(cfg: (typeof SWEEPS)[keyof typeof SWEEPS], cases: CaseFile, params: SweepParams, planSize: number): Record<string, unknown> {
	return {
		protocol: `jev-effective-protocol-${cfg.protocolId}`,
		frozenAt: new Date().toISOString(),
		hashes: {
			runner: hashFile(RUNNER_PATH),
			casesV2: hashFile(CASES_PATH),
			protocolDoc: hashFile(join(cfg.dir, "protocol.md")),
			protocolId: cfg.protocolId,
			metricRules: hashOf(JSON.stringify(METRIC_RULES)),
			currentThresholds: hashOf(JSON.stringify(PROBABILITY_THRESHOLDS)),
		},
		grid: params.grid,
		sweep: params,
		capturesRejectedBodies: true,
		rule: {
			train: `repeats other than ${JSON.stringify(params.holdoutRepeats)}`,
			holdout: `repeats ${JSON.stringify(params.holdoutRepeats)}`,
			trainValidity: `committed >= ${String(params.minTrainCommitted)} and precision >= ${String(V3_PRECISION_TRAIN)} and tau > grid floor`,
			choose: "smallest valid tau, ties to the larger tau",
			holdoutAcceptance: `committed >= ${String(params.minHoldoutVolume)} and correct >= ${String(params.minHoldoutVolume)} and precision >= ${String(V3_PRECISION_HOLDOUT)} and recall > recall(current threshold), with a zero baseline treated as undecidable`,
			onFailure: "keep the current threshold, change no code",
		},
		currentThresholds: PROBABILITY_THRESHOLDS,
		planSize,
	};
}


async function runSweep(phase: keyof typeof SWEEPS): Promise<number> {
	const cfg = Object.hasOwn(SWEEPS, phase) ? SWEEPS[phase] : null;
	if (!cfg) {
		console.error(`no sweep parameters or artifact directory are frozen for phase "${phase}"`);
		return 1;
	}
	const cases = loadCases();
	const problems = validateCases(cases);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`invalid case file: ${problem}`);
		return 1;
	}
	const params = cfg.params;
	const artifacts = cfg.artifacts;
	const pre = await preflight();
	if (!pre) return 1;
	mkdirSync(artifacts, { recursive: true });
	const runDir = mkdtempSync(join(artifacts, "run-"));
	const run = makeIsolatedRun(`v${cfg.protocolId}`, buildModelsYmlFile());
	const probePath = join(run.root, `v${cfg.protocolId}-extension.ts`);
	writeFileSync(
		probePath,
		stage1ExtensionSource(cases, [], cases.rubric, params.selectRepeats, "repeat", V3_HEALTH_FIRST, V3_FAIL_FAST),
		"utf8",
	);
	const planSize = cases.dossiers.flatMap((dossier) => dossier.forks).length * (params.selectRepeats + 1);
 const freeze = sweepFreeze(cfg, cases, params, planSize);
	writeFileSync(join(runDir, "freeze.json"), `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
	const argv = [
		"omp",
		"--mode",
		"rpc",
		"--no-session",
		"--no-title",
		"--no-skills",
		"--no-rules",
		"--model",
		MAIN_MODEL,
		"--no-extensions",
		"-e",
		probePath,
		"--tools",
		BASELINE_TOOLS.join(","),
	];
	let calls: Stage1Call[] = [];
	let aborted: NotifyPayload["aborted"] = null;
	try {
		const marker = "jev-stage1-result";
		const { frames } = await driveRpc(
			argv,
			run,
			childEnv(run, { jev: "1", openRouterKey: pre.key }),
			[{ type: "prompt", message: "/jev-cases" }],
			(seen) => Boolean(ackOf(seen)) && Boolean(notificationOf(seen, marker)),
			STAGE1_DEADLINE_MS,
		);
		writeFileSync(join(runDir, "calls.frames.jsonl"), redact(frames.map((frame) => JSON.stringify(frame)).join("\n"), pre.secrets), "utf8");
		const notified = notificationOf(frames, marker);
		const parsed = parseNotify((textOf(notified?.message) ?? "").slice(marker.length + 1));
          calls = redactCallBodies(parsed.calls, pre.secrets);
		aborted = parsed.aborted;
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}

	const clientFailures = calls.filter((call) => call.reason !== null && PRODUCT_FAILURE_REASONS.includes(call.reason)).length;
	const authoringErrors = calls.filter((call) => call.reason === "invalid_input").length;
	// A verdict is only meaningful at the frozen coverage, so the gate is applied to the counts the run
	// actually produced: 20 train and 10 hold-out points per kind, no substitutions.
 	const forksPerKind = cases.dossiers.flatMap((dossier) => dossier.forks).filter((fork) => fork.kind === "read").length;
	const expectedTrain = forksPerKind * (params.selectRepeats - params.holdoutRepeats.length);
	const expectedHoldout = forksPerKind * params.holdoutRepeats.length;
	const makeDecisions = (axis: SweepAxis) => V3_KINDS.map((kind) => {
		const decision = decidedFor(kind, calls, params, axis);
		if (decision.trainPoints !== expectedTrain || decision.holdoutPoints !== expectedHoldout) {
			return { ...decision, accepted: false, reason: `coverage không đạt kế hoạch (train ${decision.trainPoints}/${expectedTrain}, hold-out ${decision.holdoutPoints}/${expectedHoldout}) — không có phán quyết` };
		}
		return decision;
	});
	const perKind = makeDecisions("probability");
	const confidencePerKind = phase === "v5" ? makeDecisions("confidence") : undefined;
	const results: SweepResults = {
		generatedAt: new Date().toISOString(),
		runDir: runDir.replace(REPO, "<repo>"),
 		protocol: `jev-effective-protocol-${cfg.protocolId}`, 
		versions: pre.versions,
		credentialSource: pre.source,
		freeze,
		calls,
 		decision: {
 			perKind,
 			confidencePerKind,
 			clientFailures,
 			authoringErrors,
 			aborted,
 			limitation:
 				`Sweep phase ${phase}: ${String(expectedTrain)} train and ${String(expectedHoldout)} hold-out points per kind. Probability is the only axis that can produce a shippable product verdict; confidence is descriptive in v5 unless separately accepted by a future protocol.`,
 		},
	};
	writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
	writeFileSync(join(runDir, "report.md"), sweepReport(results), "utf8");
	const accepted = perKind.filter((entry) => entry.accepted);
	console.log(
		`${phase}: ${calls.length} calls (${planSize} planned), clientFailures ${clientFailures}, authoringErrors ${authoringErrors}` +
			(aborted ? ` | DUNG SOM: ${aborted.kind} tai call #${aborted.at} (HTTP ${String(aborted.status)}, ${String(aborted.reason)})` : ""),
	);
	for (const entry of perKind) console.log(`  ${entry.kind}: current ${entry.currentThreshold} -> ${entry.chosenTau ?? "keep"} (${entry.reason})`);
	console.log(`decision: ${accepted.length === 0 ? "giữ nguyên mọi ngưỡng" : accepted.map((entry) => `${entry.kind}=${entry.chosenTau}`).join(", ")}`);
	console.log(`results: ${join(runDir, "results.json")}`);
	if (authoringErrors > 0 || clientFailures > CLIENT_FAILURE_LIMIT || calls.length !== planSize || aborted !== null) return 1;
	return 0;
}

// ---------------------------------------------------------------- self-check

async function selfCheck(): Promise<number> {
	let failures = 0;
	const fail = (message: string) => {
		failures += 1;
		console.error(`not ok - ${message}`);
	};
	const pass = (message: string) => console.log(`ok - ${message}`);

	// 1. The case file is the protocol's evidence: every oracle must be derivable from its own brief.
	const cases = loadCases();
	const problems = validateCases(cases);
	if (problems.length > 0) for (const problem of problems) fail(`case file: ${problem}`);
	else pass(`case file: ${cases.dossiers.length} dossier, ${cases.dossiers.flatMap((d) => d.forks).length} fork, mọi contract nằm nguyên văn trong state`);

	// 2. Fixtures: seed fails, oracle passes, every non-winner passes publicly and fails privately.
	for (const dossier of cases.dossiers.filter((entry) => STAGE2_DOSSIERS.includes(entry.id))) {
		const run = makeIsolatedRun(`selfcheck-${dossier.id}`, PLACEHOLDER_MODELS);
		try {
			const graderPath = join(run.root, "grader.mjs");
			writeFileSync(graderPath, graderOf(dossier), "utf8");
			const check = async (answers: Record<string, string> | null) => {
				writeTree(run.workspace, workspaceTreeOf(dossier, answers));
				const pub = await runProcess(["bun", PUBLIC_TEST], run.workspace, CHECK_TIMEOUT_MS, checkEnv(run));
				const priv = await runProcess(["bun", graderPath, run.workspace], run.root, CHECK_TIMEOUT_MS, checkEnv(run));
				return { pub: pub.code === 0, priv: priv.code === 0 };
			};
			const seed = await check(null);
			if (seed.pub || seed.priv) fail(`${dossier.id}: the seeded answers passed a check`);
			const oracle = await check(Object.fromEntries(dossier.forks.map((fork) => [fork.id, fork.oracle])));
			if (!oracle.pub || !oracle.priv) fail(`${dossier.id}: the oracle answers failed`);
			let wrongClean = true;
			for (const fork of dossier.forks) {
				for (const candidate of fork.candidates.filter((entry) => entry.id !== fork.oracle)) {
					const answers = Object.fromEntries(dossier.forks.map((entry) => [entry.id, entry.oracle]));
					answers[fork.id] = candidate.id;
					const result = await check(answers);
					if (!result.pub || result.priv) {
						wrongClean = false;
						fail(`${dossier.id}: ${fork.id}/${candidate.id} was not (public pass, private fail)`);
					}
				}
			}
			const malformed = await check({ broken: "yes" } as unknown as Record<string, string>);
			if (malformed.pub) fail(`${dossier.id}: a malformed answer file passed the public check`);
			if (seed.pub === false && oracle.pub && oracle.priv && wrongClean) pass(`${dossier.id}: seed fails, oracle passes, mọi non-winner pass public và fail private`);
		} finally {
			rmSync(run.root, { recursive: true, force: true });
		}
	}

	// 3. The parser: a control answer is fabricated, never a client failure, and never merged with J's refusals.
	const synthetic = [
		JSON.stringify({ type: "turn_start" }),
		JSON.stringify({ type: "message_start", message: { role: "assistant", provider: MAIN_PROVIDER, model: MAIN_MODEL_ID } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.004 } } } }),
		JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: TOOL_NAME, args: { mode: "score", candidates: new Array(4).fill({ id: "x" }) } }),
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: TOOL_NAME,
			result: { details: { status: "main", candidateId: null, reason: "control", latencyMs: 0, costUsd: 0, scores: null } },
		}),
		JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: TOOL_NAME, args: { mode: "score", candidates: new Array(4).fill({ id: "x" }) } }),
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "c2",
			toolName: TOOL_NAME,
			result: { details: { status: "main", candidateId: null, reason: "deferred", latencyMs: 400, costUsd: 0.00003, scores: null } },
		}),
	].join("\n");
	const parsed = summarizeTranscript(synthetic);
	if (parsed.controlAnswers !== 1 || parsed.realCalls !== 1) fail(`control/real split is wrong (${parsed.controlAnswers}/${parsed.realCalls})`);
	if (parsed.failures.length !== 0) fail(`a control answer was classified as a client failure: ${parsed.failures.join(",")}`);
	if (parsed.realDeferred !== 1 || parsed.controlAnswers !== 1) fail("fabricated and real refusals were merged");
	if (parsed.mainCostUsd !== 0.004) fail(`main cost ${parsed.mainCostUsd}`);
	if (parsed.decisions[0]?.questionCount !== 4) fail("derived question count is wrong");
	if (parsed.turns !== 1) fail("turns were not counted");
	if (parsed.missingToolEnds.length !== 0) fail("a matched pair was reported as missing");
	pass("parser: control is fabricated, not a client failure, and never merged with J's refusals");

	const missingEnd = summarizeTranscript(synthetic.replace('"tool_execution_end","toolCallId":"c2"', '"tool_execution_end","toolCallId":"c9"'));
	if (missingEnd.missingToolEnds.length === 0) fail("an unmatched tool start was not reported");
	pass("parser: an unmatched tool start is reported, not dropped");

	// 4. The two tools must be indistinguishable to the model: same schema, same description.
	const control = await probeRegistry(STUB_EXTENSION, "1", TREATMENT_TOOLS);
	const real = await probeRegistry(EXTENSION, "1", TREATMENT_TOOLS);
	if (!control.tools.includes(TOOL_NAME) || !real.tools.includes(TOOL_NAME)) fail("a tool is missing from its registry probe");
	if (JSON.stringify(control.schema) !== JSON.stringify(real.schema)) fail("the control tool's schema differs from the real one");
	if (control.description !== real.description) fail("the control tool's description differs from the real one");
	const baseline = await probeRegistry(EXTENSION, "0", BASELINE_TOOLS);
	if (baseline.tools.includes(TOOL_NAME)) fail("the baseline tool set exposes the decision maker");
	// The probe exists to prove the plugin's readiness label, so assert the label on the real extension
	// rather than counting frames. The control registers no status line on purpose: the host UI is not part
	// of the model's input, so it cannot change what arm E sees, and a stub has no readiness to report.
	const labelOf = (probe: RegistryProbe) => probe.statuses.at(-1)?.[1] ?? "";
	if (!labelOf(real).endsWith("JEV on")) fail(`the opted-in probe reported "${labelOf(real)}" instead of the JEV on label`);
	if (!labelOf(baseline).endsWith("JEV off")) fail(`the opted-out probe reported "${labelOf(baseline)}" instead of the JEV off label`);
	if (control.statuses.length > 0) fail("the control tool registered a status line; it must not claim readiness");
	pass(`schema parity: real and control offer the same parameters and description (${JSON.stringify(control.schema).length} bytes of schema)`);

	// 5. Freeze manifest: every input the protocol names is present and hashed.
	const freeze = freezeManifest(cases, "self-check");
	const hashes = freeze.hashes as Record<string, unknown>;
	for (const key of ["runner", "cases", "stubExtension", "decisionMaker", "shippedRules", "metricRules", "commonPolicy", "shippedPolicyAppend", "order"]) {
		if (typeof hashes[key] !== "string" || (hashes[key] as string).length !== 64) fail(`freeze.json has no usable hash for ${key}`);
	}
	if ((freeze.caseIds as string[]).length !== cases.dossiers.flatMap((d) => d.forks).length) fail("freeze.json does not list every fork with its oracle");
	pass(`freeze: ${Object.keys(hashes).length} hash groups, ${(freeze.caseIds as string[]).length} fork oracles`);

	// 6. The sweep rule decides a product threshold, so it is proven on synthetic curves with known
	//    answers rather than trusted. Five paths: accept, floor-only, thin hold-out, hold-out that rejects
	//    precision, and a zero baseline that cannot be compared.
	const point = (repeat: number, probability: number, correct: boolean): Stage1Call => {
		const call = { fork: "synthetic", kind: "read", repeat, oracle: "o", view: "select", probability, argmax: correct ? "o" : "w" };
		return call as unknown as Stage1Call;
	};
	const many = (repeat: number, count: number, probability: number, correct: boolean) => [...Array(count)].map(() => point(repeat, probability, correct));
	// Accept: train wants 0.56 (wrong points at 0.55/0.52 sit just under it), the current 0.90 gate does
	// commit one hold-out call so the recall baseline exists, and the chosen tau admits 5/5 correct there.
	const acceptCurve = [...many(1, 10, 0.9, true), ...many(2, 10, 0.85, true), ...many(1, 10, 0.55, false), ...many(2, 10, 0.52, false)];
	const acceptCase = decidedFor("read", [...acceptCurve, ...many(3, 1, 0.95, true), ...many(3, 4, 0.85, true), ...many(3, 5, 0.55, false)], SWEEP_V3, "probability");
	if (!acceptCase.accepted || acceptCase.chosenTau !== 0.56) {
		fail(`the sweep did not accept tau 0.56 on the accept curve (chosen ${String(acceptCase.chosenTau)}, accepted ${String(acceptCase.accepted)}, ${acceptCase.reason})`);
	}
	// Floor-only: every valid tau sits at the grid floor, so the data wants a threshold this grid cannot
	// express and the rule must refuse rather than ship 0.50 as a measured result.
	const floorCurve = [...many(1, 10, 0.5, true), ...many(2, 10, 0.5, true), ...many(1, 10, 0.2, false), ...many(2, 10, 0.2, false)];
	const floorCase = decidedFor("read", [...floorCurve, ...many(3, 5, 0.9, true), ...many(3, 5, 0.1, false)], SWEEP_V3, "probability");
	if (floorCase.accepted || floorCase.chosenTau !== null || !String(floorCase.reason).includes("sàn lưới")) {
		fail(`the sweep did not refuse a floor-only curve (chosen ${String(floorCase.chosenTau)}, reason ${floorCase.reason})`);
	}
	// Thin hold-out: one committed call at precision 1.0 is not evidence, so the volume floor refuses it.
	const thinCase = decidedFor("read", [...acceptCurve, ...many(3, 1, 0.95, true)], SWEEP_V3, "probability");
	if (thinCase.accepted || !String(thinCase.reason).includes("không đủ bằng chứng")) {
		fail(`the sweep accepted a thin hold-out (committed ${String(thinCase.holdout?.committed)}, reason ${thinCase.reason})`);
	}
	// Hold-out precision: the same curve, but the hold-out admits five wrong calls at the chosen tau.
	const rejectCase = decidedFor("read", [...acceptCurve, ...many(3, 1, 0.95, true), ...many(3, 4, 0.85, true), ...many(3, 5, 0.57, false)], SWEEP_V3, "probability");
	if (rejectCase.accepted || !String(rejectCase.reason).includes("không đủ bằng chứng")) {
		fail(`the sweep accepted a threshold the hold-out rejected (reason ${rejectCase.reason})`);
	}
	// Zero baseline: the current gate commits nothing on the hold-out, so "recall improved" is meaningless.
	const zeroBaselineCase = decidedFor("read", [...acceptCurve, ...many(3, 5, 0.8, true), ...many(3, 5, 0.1, false)], SWEEP_V3, "probability");
	if (zeroBaselineCase.accepted || !String(zeroBaselineCase.reason).includes("mốc 0")) {
		fail(`the sweep compared against a zero baseline (reason ${zeroBaselineCase.reason})`);
	}
	// Nothing valid at all: no call clears the grid, so there is no candidate tau to discuss.
	const emptyCase = decidedFor("read", many(1, 10, 0.3, true).concat(many(2, 10, 0.3, true)), SWEEP_V3, "probability");
	if (emptyCase.chosenTau !== null || emptyCase.accepted) fail("the sweep invented a threshold with no call above the grid floor");
 	pass("sweep rule: accepts 0.56 on a clean curve; refuses floor-only, thin hold-out, rejected hold-out precision, zero baseline and nothing-valid");
 	const v3Cases = loadCases();
	const generated = stage1ExtensionSource(v3Cases, [], v3Cases.rubric, 1, "fork", V3_HEALTH_FIRST, V3_FAIL_FAST);
	const generatedFields = ["argmax", "probability", "confidence", "probabilities", "kind", "repeat", "view", "responseBody"];
	const pushStart = generated.indexOf("results.push({");
	const pushEnd = generated.indexOf("});", pushStart);
	const pushBlock = pushStart >= 0 && pushEnd >= 0 ? generated.slice(pushStart, pushEnd) : "";
	const pushLines = pushBlock.split("\n").map((line) => line.trim());
	const bareFields = new Set(["argmax", "probabilities", "responseBody"]);
	const pushedField = (field: string, sourceLines: string[]) => sourceLines.some((line) => bareFields.has(field) ? line === `${field},` : line.startsWith(`${field}:`));
	for (const field of generatedFields) if (!pushedField(field, pushLines)) fail(`results.push does not carry ${field}`);
	if (pushedField("argmax", pushLines.filter((line) => line !== "argmax,"))) fail("pushed-field guard is vacuous for argmax");
	if (!generated.includes("nonOk") || !generated.includes('"rejected"')) fail("generated health gate lacks nonOk/rejected labels");
	const planted = redactCallBodies([{ responseBody: "provider says TOP_SECRET" } as Stage1Call], ["TOP_SECRET"])[0].responseBody;
	if (planted !== "provider says [redacted]") fail(`body redaction failed: ${String(planted)}`);

	// 7. Plan shape and v5 axes are frozen: these assertions run before any CLI child is spawned.
	const forkCount = v3Cases.dossiers.flatMap((dossier) => dossier.forks).length;
	const v3PlanSize = forkCount * (SWEEP_V3.selectRepeats + 1);
	const v4PlanSize = forkCount * (SWEEP_V4.selectRepeats + 1);
	const v5PlanSize = forkCount * (SWEEP_V5.selectRepeats + 1);
	if (v3PlanSize !== 120) fail(`the v3 plan is ${v3PlanSize} calls, not the frozen 120`);
	if (v4PlanSize !== 180) fail(`the v4 plan is ${v4PlanSize} calls, not the frozen 180`);
	if (v5PlanSize !== 210) fail(`the v5 plan is ${v5PlanSize} calls, not the frozen 210`);
	if (SWEEP_V3.grid.length !== 50 || SWEEP_V3.grid[0] !== 0.5 || SWEEP_V3.grid[SWEEP_V3.grid.length - 1] !== 0.99) fail("the v3 grid is not 0.50..0.99 by 0.01");
	if (SWEEP_V4.grid.length !== 60 || SWEEP_V4.grid[0] !== 0.4 || SWEEP_V4.grid[SWEEP_V4.grid.length - 1] !== 0.99) fail("the v4 grid is not 0.40..0.99 by 0.01");
	if (SWEEP_V4.minHoldoutVolume !== 8 || SWEEP_V4.holdoutRepeats.length !== 2) fail("the v4 hold-out is not 2 repeats with a volume floor of 8");
	if (SWEEP_V5.selectRepeats !== 6 || JSON.stringify(SWEEP_V5.holdoutRepeats) !== JSON.stringify([5, 6]) || SWEEP_V5.grid[0] !== 0.4 || SWEEP_V5.confidenceGrid?.[0] !== 0.2) fail("the v5 repeat split or parallel grids are not frozen");

	// 8. CLI guards run before anything with a side effect. The throwaway HOME is removed here: a guard
	// subprocess needs one, and leaving one behind per self-check run would litter the temp dir.
	const guardHome = guardEnv();
	try {
		const beforeRuns = existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS).length : 0;
		const usageCases: Array<[string[], string]> = [
			[["--stage1", "extra"], "an over-long stage1"],
			[["--stage2", "extra"], "an over-long stage2"],
			[["--render"], "a render with no paths"],
			[["--render", join(ARTIFACTS, "a.json")], "a render with no out path"],
			[["--nonsense"], "an unknown mode"],
		];
		for (const [argv, label] of usageCases) {
			const result = await runProcess(["bun", RUNNER_PATH, ...argv], REPO, 30_000, guardHome);
			if (result.code !== 1) fail(`${label} exited ${result.code} instead of 1`);
			if (!result.stderr.includes("usage:")) fail(`${label} did not print the usage line`);
		}
		const missingRender = await runProcess(["bun", RUNNER_PATH, "--render", join(ARTIFACTS, "does-not-exist.json"), join(ARTIFACTS, "out.md")], REPO, 30_000, guardHome);
		if (missingRender.code !== 1 || !missingRender.stderr.includes("does-not-exist.json")) fail("a render of a missing file did not name it");
		if ((existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS).length : 0) !== beforeRuns) fail("a refused CLI call created artifacts");
 	pass(`plans: v3 ${v3PlanSize}, v4 ${v4PlanSize}, v5 ${v5PlanSize}; grids and health/body guards present`);
	} finally {
		rmSync(guardHome.HOME ?? "", { recursive: true, force: true });
	}

	console.log(failures === 0 ? "self-check passed (no inference calls made)" : `self-check failed: ${failures} check(s)`);
	return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- dispatch

const mode = process.argv[2] ?? "";
const args = process.argv.slice(3);
const refuse = (): 1 => (console.error(USAGE), 1);
let code = 1;
if (mode === "--self-check") code = args.length === 0 ? await selfCheck() : refuse();
else if (mode === "--stage1") code = args.length === 0 ? await runStage1() : refuse();
else if (mode === "--stage2") code = args.length === 0 ? await runStage2() : refuse();
else if (mode === "--v3") code = args.length === 0 ? await runSweep("v3") : refuse();
else if (mode === "--v4") code = args.length === 0 ? await runSweep("v4") : refuse();
else if (mode === "--v5") code = args.length === 0 ? await runSweep("v5") : refuse();
else if (mode === "--render") code = args.length === 2 ? renderFromResults(args[0], args[1]) : refuse();
else refuse();
process.exit(code);
