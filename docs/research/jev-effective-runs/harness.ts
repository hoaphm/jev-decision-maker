/**
 * JEV effective-judgment harness - session-local, not a product benchmark.
 *
 * bun <this file> --self-check
 *   No inference, no credential, no network: every fixture's seeded answer must fail its own checks, the
 *   oracle answer must pass them, every non-winner must pass the public check and fail the private one,
 *   the transcript parser must be proven on a synthetic transcript, and the CLI guards must refuse before
 *   touching anything.
 *
 * bun <this file> --batch judgment
 *   The paid run. 12 omp sessions (2 fixtures x 3 paired repeats, baseline arm interleaved in the same
 *   batch) preceded by one zero-inference smoke that proves the two modes really travel as ONE HTTP
 *   request each. The plugin resolves its credential through omp, so the key is handed to the child env
 *   only for the treatment arm; the baseline child never sees it.
 *
 * bun <this file> --render <results.json> <out.md>
 *   Re-renders a finished run from its stored JSON. The output path is required, must not exist, and is
 *   created exclusively: no default file, no overwrite, no rescan of another run.
 *
 * What is measured: task quality (private oracle winner), paired agentMs, and paired total session cost
 * (main model + decision maker) on the same denominator. Nothing is retried, no pair is re-run, and no
 * prompt, rubric or threshold is edited after results are seen.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const RUNNER_PATH = import.meta.path;
const LOCAL_DIR = dirname(RUNNER_PATH);
const REPO = "/Users/hoaphm/jev-decision-maker";
const EXTENSION = join(REPO, "src", "decision-maker.ts");
const ARTIFACTS = join(LOCAL_DIR, "jev-effective-results");
const REAL_AGENT_DIR = join(process.env.HOME ?? "", ".omp", "agent");
const REAL_MODELS_YML = join(REAL_AGENT_DIR, "models.yml");
const REAL_AGENT_DB = join(REAL_AGENT_DIR, "agent.db");

const MAIN_PROVIDER = "9router";
const MAIN_MODEL_ID = "cx/gpt-5.6-terra";
const MAIN_MODEL = `${MAIN_PROVIDER}/${MAIN_MODEL_ID}:high`;
const TOOL_NAME = "decision_maker";
const JEV_MODEL_PREFIX = "typesafe/jev-";

const SESSION_TIMEOUT_MS = 190_000;
const SESSION_MAX_TIME = "3m";
const CHECK_TIMEOUT_MS = 10_000;
const RPC_DEADLINE_MS = 90_000;
const NOTIFY_GRACE_MS = 1_500;

/** Frozen budget: 12 model sessions, 2 smoke requests plus at most 5 calls per treatment session. */
const MAX_PROMPT_SESSIONS = 12;
const MAX_JEV_REQUESTS = 32;
const REPEATS = [1, 2, 3];
const ORDERS: Record<string, Array<{ fixture: string; repeat: number; arm: Arm }>> = {
	judgment: [
		{ fixture: "diagnostic-selection", repeat: 1, arm: "B" },
		{ fixture: "diagnostic-selection", repeat: 1, arm: "J" },
		{ fixture: "diagnostic-selection", repeat: 2, arm: "J" },
		{ fixture: "diagnostic-selection", repeat: 2, arm: "B" },
		{ fixture: "diagnostic-selection", repeat: 3, arm: "B" },
		{ fixture: "diagnostic-selection", repeat: 3, arm: "J" },
		{ fixture: "patch-shortlist", repeat: 1, arm: "J" },
		{ fixture: "patch-shortlist", repeat: 1, arm: "B" },
		{ fixture: "patch-shortlist", repeat: 2, arm: "B" },
		{ fixture: "patch-shortlist", repeat: 2, arm: "J" },
		{ fixture: "patch-shortlist", repeat: 3, arm: "J" },
		{ fixture: "patch-shortlist", repeat: 3, arm: "B" },
	],
};

const USAGE = `usage: bun ${RUNNER_PATH} --self-check | --batch judgment | --render <results.json> <out.md>`;

type Arm = "B" | "J";
const BASELINE_TOOLS = ["read", "write", "bash"];
const TREATMENT_TOOLS = ["read", "write", "bash", TOOL_NAME];

const AGENTS_MD = `# Judgment fixture

The task is stated in the prompt and its data is in \`brief.json\`. Write your answer to
\`src/answer.json\` and nothing else. \`tests/check.mjs\` is the public acceptance check: leave it
exactly as it is and make \`bun tests/check.mjs\` pass.
`;

const COMMON_POLICY = `Work only on the current task in this workspace.

- Read only \`brief.json\`, \`src/answer.json\` and \`tests/check.mjs\`. Write only \`src/answer.json\`.
- Verify with \`bun tests/check.mjs\` (that exact command is pre-approved; other shell commands may be refused).
- No git, no dependency installs, no network beyond the tools you are given.
- If a \`decision_maker\` tool is available and the task really forks between distinct options, use it:
  \`mode: "select"\` to pick one next step, or \`mode: "score"\` with one ordered \`rubric\` to rate every
  proposal in a single call instead of writing out each one yourself. Never invent options just to call
  it, never call it once per candidate, and never call it for a step that is obvious or required.
- Whatever the tool answers is a suggestion, not a verdict: the acceptance check is still the file you
  write, and you are responsible for it.
`;

// ---------------------------------------------------------------- fixtures

type Fixture = {
	name: string;
	mode: "select" | "score";
	prompt: string;
	brief: Record<string, unknown>;
	winner: string;
	ids: string[];
};

const DIAGNOSTIC: Fixture = {
	name: "diagnostic-selection",
	mode: "select",
	winner: "cache-identity",
	ids: ["cache-identity", "service-forwarding", "store-query"],
	brief: {
		goal: "Choose the first read that best distinguishes the cause of cross-tenant cached profiles.",
		evidence:
			"Tenant A reads id 7, then tenant B reads id 7 and receives A's profile. Calling the store directly for B returns B's correct profile. The error occurs only after A warms the cache. A trace already confirmed that the service forwards tenant B and id 7 unchanged to the cache. No source for the cache identity has been inspected yet.",
		candidates: [
			{
				id: "cache-identity",
				kind: "read",
				action: "Read src/cache.mjs to identify the cache key and its tenant/id inputs.",
				expected: "Determine whether cache identity distinguishes tenants sharing an id.",
			},
			{
				id: "service-forwarding",
				kind: "read",
				action: "Read src/service.mjs to inspect forwarding of tenant and id to the cache.",
				expected: "Determine whether the service passes the requested tenant and id.",
			},
			{
				id: "store-query",
				kind: "read",
				action: "Read src/store.mjs to inspect the direct tenant filter.",
				expected: "Determine whether direct store lookup includes the requested tenant.",
			},
		],
	},
	prompt:
		"Read brief.json. Select the first diagnostic read using the supplied evidence and candidates. " +
		'Write only {"candidateId":"<id>"} to src/answer.json. Do not execute the proposed action. ' +
		"Do not change brief.json or tests/check.mjs. Run bun tests/check.mjs.",
};

const SHORTLIST: Fixture = {
	name: "patch-shortlist",
	mode: "score",
	winner: "tuple-key",
	ids: ["tuple-key", "colon-key", "tenant-only", "no-cache", "truthy-cache"],
	brief: {
		goal: "Choose the proposed cache repair that preserves the stated contract.",
		evidence:
			"The current cache uses key=id. Tenants can share ids. Contract: same tenant/id reuses its cached value; different tenant/id pairs never share entries; ids and tenants may contain colons or be empty; undefined is a valid cached result; a throwing loader must not create an entry. Map.has/get/set behavior and loader call order are already correct. Change only the key expression unless a proposal explicitly says otherwise.",
		// Task data, not the answer: the prompt says "the supplied ordered rubric", so it has to be supplied.
		rubric: [
			"Contradicts at least one explicit contract requirement",
			"No contradiction shown, but the proposal provides no support for the required behavior",
			"Partially supported; a required behavior remains unspecified",
			"Supported with a stated unresolved caveat",
			"Directly supported for every stated requirement with no known contradiction",
		],
		candidates: [
			{
				id: "tuple-key",
				kind: "edit",
				action: "Replace only key=id with key=JSON.stringify([tenantId,id]); keep Map.has/get/set and loader ordering.",
				expected: "Cache identity separates tenant/id pairs without changing cache behavior.",
			},
			{
				id: "colon-key",
				kind: "edit",
				action: 'Replace only key=id with key=tenantId+":"+id; keep other logic.',
				expected: "Cache identity uses tenant and id joined by a colon.",
			},
			{
				id: "tenant-only",
				kind: "edit",
				action: "Replace only key=id with key=tenantId; keep other logic.",
				expected: "Each tenant uses a tenant-specific cache entry.",
			},
			{
				id: "no-cache",
				kind: "edit",
				action: "Delete Map storage and call load() for every get.",
				expected: "No request can reuse another request's cached value.",
			},
			{
				id: "truthy-cache",
				kind: "edit",
				action: "Use JSON.stringify([tenantId,id]) as key, but replace Map.has with if (!entries.get(key)) before loading.",
				expected: "Tenant/id pairs use distinct keys and missing values trigger a load.",
			},
		],
	},
	prompt:
		"Read brief.json. Evaluate all five proposed repairs against the supplied ordered rubric, then choose " +
		"the strongest supported repair. " +
		'Write only {"candidateId":"<id>"} to src/answer.json. Do not implement the proposals, ' +
		"do not change brief.json or tests/check.mjs, and run bun tests/check.mjs.",
};

const FIXTURES: Fixture[] = [DIAGNOSTIC, SHORTLIST];

const fixtureByName = (name: string): Fixture => {
	const found = FIXTURES.find((fixture) => fixture.name === name);
	if (!found) throw new Error(`unknown fixture: ${name}`);
	return found;
};

/** The public check knows the candidate ids and nothing else: a non-winner passes it, so it cannot leak. */
function publicCheckOf(fixture: Fixture): string {
	return `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const answer = JSON.parse(readFileSync(join("src", "answer.json"), "utf8"));
const ids = ${JSON.stringify(fixture.ids)};
assert.equal(typeof answer, "object");
assert.notEqual(answer, null);
assert.equal(Array.isArray(answer), false);
assert.ok(ids.includes(answer.candidateId), "answer.candidateId must be one of the supplied candidates");
console.log("${fixture.name} checks passed");
`;
}

/** The private grader runs outside the workspace and is the only place the winner is written down. */
function graderOf(fixture: Fixture): string {
	return `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.argv[2];
const answer = JSON.parse(readFileSync(join(workspace, "src", "answer.json"), "utf8"));
assert.equal(answer.candidateId, ${JSON.stringify(fixture.winner)}, "not the strongest supported candidate");
console.log("${fixture.name} grader passed");
`;
}

function workspaceTreeOf(fixture: Fixture, candidateId: string | null): Record<string, string> {
	return {
		"brief.json": `${JSON.stringify(fixture.brief, null, 2)}\n`,
		"src/answer.json": `${JSON.stringify({ candidateId }, null, 2)}\n`,
		"tests/check.mjs": publicCheckOf(fixture),
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
	for (const secret of secrets) {
		if (secret.length > 0) out = out.split(secret).join("[redacted]");
	}
	return out;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sumOrNull(values: Array<number | null>): number | null {
	if (values.length === 0 || values.some((value) => value === null)) return null;
	return Number(values.reduce((total, value) => total + (value as number), 0).toFixed(6));
}

function list(values: Array<number | null>): string {
	return values.length === 0 ? "none" : values.map((value) => (value === null ? "null" : value)).join(", ");
}

// ---------------------------------------------------------------- isolation

/** Placeholder model config for the offline probes: nothing here is a real endpoint or a real key. */
const PLACEHOLDER_MODELS = Bun.YAML.stringify({
	providers: {
		[MAIN_PROVIDER]: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-responses",
			apiKey: "placeholder-not-a-credential",
			authHeader: true,
			// `discovery` is omitted deliberately: the host validates it as an object, and this probe wants
			// no discovery. The model mirrors the fields the operator's entry carries, minus the endpoint.
			models: [{ id: MAIN_MODEL_ID, input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, contextWindow: 1050000 }],
		},
	},
});

let realModelsYml: string | null = null;

/** The live child config: the one main model, cut out of the operator's own provider entry. */
function buildModelsYmlFile(): string {
	if (realModelsYml) return realModelsYml;
	const parsed = Bun.YAML.parse(readFileSync(REAL_MODELS_YML, "utf8")) as { providers?: Record<string, Record<string, unknown>> };
	const provider = parsed?.providers?.[MAIN_PROVIDER];
	if (!provider) throw new Error(`${REAL_MODELS_YML} has no "${MAIN_PROVIDER}" provider`);
	const trimmed: Record<string, unknown> = {};
	for (const key of ["baseUrl", "api", "apiKey", "authHeader", "discovery"]) {
		if (provider[key] !== undefined) trimmed[key] = provider[key];
	}
	const models = (provider.models as Array<{ id?: string }> | undefined)?.filter((model) => model.id === MAIN_MODEL_ID) ?? [];
	if (models.length !== 1) throw new Error(`expected exactly one ${MAIN_PROVIDER} model "${MAIN_MODEL_ID}", found ${models.length}`);
	trimmed.models = models;
	realModelsYml = Bun.YAML.stringify({ providers: { [MAIN_PROVIDER]: trimmed } });
	return realModelsYml;
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
	const root = mkdtempSync(join(tmpdir(), `jev-eff-${label}-`));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	for (const leaf of [".omp/agent", "xdg-config", "xdg-data/omp", "xdg-state/omp", "xdg-cache/omp"]) {
		mkdirSync(join(home, leaf), { recursive: true, mode: 0o700 });
	}
	mkdirSync(workspace, { recursive: true });
	if (!root.startsWith(tmpdir())) throw new Error(`isolated run escaped the temp dir: ${root}`);
	const path = join(home, ".omp/agent", "models.yml");
	writeFileSync(path, modelsYml, { mode: 0o600 });
	chmodSync(path, 0o600);
	writeFileSync(join(home, ".omp/agent", "config.yml"), `modelRoles:\n  default: ${MAIN_MODEL}\n`, "utf8");
	return { root, home, workspace };
}

/** Allowlist only: nothing from the parent's OMP state rides along. */
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
	// Only the treatment arm is ever given a credential; the baseline child cannot reach the endpoint.
	if (options.openRouterKey !== undefined) env.OPENROUTER_API_KEY = options.openRouterKey;
	return env;
}

function checkEnv(run: IsolatedRun): Record<string, string> {
	return { HOME: run.home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb" };
}

/** Bare env for the guard subprocesses: no credential, no operator HOME. */
function guardEnv(): Record<string, string> {
	const home = mkdtempSync(join(tmpdir(), "jev-eff-guard-"));
	return { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb" };
}

type CredentialSource = "operator-env" | "omp-store-readonly-to-isolated-env";

/**
 * The benchmark's own isolation recipe (never a plugin feature): read-only sqlite, exactly one active
 * row, a literal key. A command reference or an ambiguous store is a blocker, not a reason to choose
 * another credential.
 */
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

/** Zero-inference proof the child really receives the credential; only a boolean and a length survive. */
async function confirmChildCredential(key: string): Promise<boolean> {
	const run = makeIsolatedRun("credential-check", buildModelsYmlFile());
	try {
		const token = await runProcess(["omp", "token", "openrouter"], run.workspace, 60_000, childEnv(run, { jev: "1", openRouterKey: key }));
		return token.code === 0 && token.stdout.trim() === key;
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- transcript parsing

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
 * One decision-maker call. `questionCount` is derived from the tool's own input (a score batch is one
 * request with N questions), never counted as N calls, and `toolInputBytes` is the size of the tool
 * arguments - not the HTTP body, which only the smoke wrapper measures.
 */
type DecisionSample = {
	callId: string;
	requestedMode: string | null;
	candidateCount: number | null;
	questionCount: number | null;
	toolInputBytes: number | null;
	status: string | null;
	reason: string | null;
	candidateId: string | null;
	probability: number | null;
	model: string | null;
	latencyMs: number | null;
	costUsd: number | null;
	scores: Array<{ candidateId: string; score: number }> | null;
	topScoreIds: string[] | null;
	scoreTied: boolean | null;
};

type Usage = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; totalTokens: number | null; reasoningTokens: number | null; costTotal: number | null };

type SessionMetrics = {
	mainModels: string[];
	turns: number;
	toolCounts: Record<string, number>;
	toolCallSequence: string[];
	missingToolEnds: string[];
	extensionErrors: number;
	decisionCalls: number;
	decisions: DecisionSample[];
	selected: number;
	scored: number;
	deferred: number;
	uncertain: number;
	clientFailures: number;
	clientFailureReasons: string[];
	jevLatencyMs: number[];
	jevCostUsd: Array<number | null>;
	usageTotals: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; totalTokens: number | null; reasoningTokens: number | null };
	costStatus: "reported" | "unknown";
	mainCostUsd: number | null;
};

const CLIENT_FAILURE_REASONS = [
	"invalid_input",
	"missing_key",
	"cancelled",
	"timeout",
	"http_error",
	"invalid_response",
	"network_error",
	"call_limit",
];

/** The questions this input should produce, derived from the tool arguments the agent sent. */
function expectedQuestionCount(args: JsonObject | undefined): number | null {
	const mode = textOf(args?.mode);
	const candidates = Array.isArray(args?.candidates) ? args.candidates.length : null;
	if (mode === "select") return 1;
	if (mode === "score") return candidates;
	return null;
}

function readDecision(details: JsonObject, args: JsonObject | undefined, callId: string): DecisionSample {
	const rawScores = Array.isArray(details.scores) ? details.scores : null;
	const scores: Array<{ candidateId: string; score: number }> | null =
		rawScores && rawScores.length > 0
			? (rawScores
					.map((entry) => {
						const record = asObject(entry);
						const candidateId = textOf(record?.candidateId);
						const score = numberOf(record?.score);
						return candidateId && score !== null ? { candidateId, score } : null;
					})
					.filter((entry): entry is { candidateId: string; score: number } => entry !== null) as Array<{
					candidateId: string;
					score: number;
				}>)
			: null;
	let topScoreIds: string[] | null = null;
	let scoreTied: boolean | null = null;
	if (scores && scores.length > 0) {
		const best = Math.max(...scores.map((entry) => entry.score));
		topScoreIds = scores.filter((entry) => entry.score === best).map((entry) => entry.candidateId);
		scoreTied = topScoreIds.length > 1;
	}
	return {
		callId,
		requestedMode: textOf(args?.mode),
		candidateCount: Array.isArray(args?.candidates) ? args.candidates.length : null,
		questionCount: expectedQuestionCount(args),
		toolInputBytes: args === undefined ? null : new TextEncoder().encode(JSON.stringify(args)).length,
		status: textOf(details.status),
		reason: textOf(details.reason),
		candidateId: textOf(details.candidateId),
		probability: numberOf(details.probability),
		model: textOf(details.model),
		latencyMs: numberOf(details.latencyMs),
		costUsd: numberOf(details.costUsd),
		scores,
		topScoreIds,
		scoreTied,
	};
}

/**
 * Reads every event of one `--mode json` transcript. Start/end tool pairs are matched by call id and an
 * unmatched start is reported, never dropped: silently losing an end would also lose its cost.
 */
function summarizeTranscript(stdout: string): SessionMetrics {
	const mainModels = new Set<string>();
	const starts = new Map<string, { name: string; args: JsonObject | undefined }>();
	const order: string[] = [];
	const toolCounts: Record<string, number> = {};
	const decisions: DecisionSample[] = [];
	const usages: Usage[] = [];
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
			usages.push({
				input: numberOf(usage.input),
				output: numberOf(usage.output),
				cacheRead: numberOf(usage.cacheRead),
				cacheWrite: numberOf(usage.cacheWrite),
				totalTokens: numberOf(usage.totalTokens),
				reasoningTokens: numberOf(usage.reasoningTokens),
				costTotal: numberOf(cost.total),
			});
			continue;
		}
		const callId = textOf(event.toolCallId);
		if (!callId) continue;
		const name = textOf(event.toolName);
		if (type === "tool_execution_start" && name) {
			order.push(name);
			toolCounts[name] = (toolCounts[name] ?? 0) + 1;
			starts.set(callId, { name, args: asObject(event.args) });
			continue;
		}
		if (type === "tool_execution_end") {
			const started = starts.get(callId);
			if (started) starts.delete(callId);
			if (started?.name !== TOOL_NAME) continue;
			const details = asObject(asObject(event.result)?.details);
			decisions.push(readDecision(details ?? {}, started.args, callId));
		}
	}

	const reasons = decisions.map((decision) => decision.reason ?? "unknown");
	return {
		mainModels: [...mainModels].sort(),
		turns,
		toolCounts,
		toolCallSequence: order,
		missingToolEnds: [...starts.values()].map((entry) => entry.name),
		extensionErrors,
		decisionCalls: toolCounts[TOOL_NAME] ?? 0,
		decisions,
		selected: reasons.filter((reason) => reason === "selected").length,
		scored: reasons.filter((reason) => reason === "scored").length,
		deferred: reasons.filter((reason) => reason === "deferred").length,
		uncertain: reasons.filter((reason) => reason === "uncertain").length,
		clientFailures: reasons.filter((reason) => CLIENT_FAILURE_REASONS.includes(reason)).length,
		clientFailureReasons: reasons.filter((reason) => CLIENT_FAILURE_REASONS.includes(reason)),
		jevLatencyMs: decisions.map((decision) => decision.latencyMs).filter((value): value is number => value !== null),
		jevCostUsd: decisions.map((decision) => decision.costUsd),
		usageTotals: {
			input: sumOrNull(usages.map((usage) => usage.input)),
			output: sumOrNull(usages.map((usage) => usage.output)),
			cacheRead: sumOrNull(usages.map((usage) => usage.cacheRead)),
			cacheWrite: sumOrNull(usages.map((usage) => usage.cacheWrite)),
			totalTokens: sumOrNull(usages.map((usage) => usage.totalTokens)),
			reasoningTokens: sumOrNull(usages.map((usage) => usage.reasoningTokens)),
		},
		costStatus: usages.length > 0 && usages.every((usage) => usage.costTotal !== null) ? "reported" : "unknown",
		mainCostUsd: usages.every((usage) => usage.costTotal !== null) ? sumOrNull(usages.map((usage) => usage.costTotal)) : null,
	};
}

// ---------------------------------------------------------------- RPC driving

type RpcFrame = { frames: JsonObject[]; text: string };

/**
 * Drives one RPC session with no agent turn: frames are collected until the predicate is satisfied or
 * the deadline passes. Used for the registry probe and for the slash-command smoke.
 */
async function driveRpc(
	argv: string[],
	run: IsolatedRun,
	env: Record<string, string>,
	send: JsonObject[],
	done: (frames: JsonObject[]) => boolean,
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
		const deadline = performance.now() + RPC_DEADLINE_MS;
		for (const [index, frame] of send.entries()) {
			child.stdin.write(`${JSON.stringify({ id: `cmd-${index}`, ...frame })}\n`);
			while (performance.now() < deadline && !done(frames)) await Bun.sleep(100);
		}
		// Notifications trail the acknowledgement, so give them one grace window before deciding.
		const settle = performance.now() + NOTIFY_GRACE_MS;
		while (performance.now() < settle && !done(frames)) await Bun.sleep(100);
		take();
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		await pumping;
	}
	if (err.length > 0) frames.push({ type: "harness_stderr", text: err.slice(0, 400) });
	return { frames, text: out };
}

type RegistryProbe = {
	tools: string[];
	statuses: Array<[string, string | undefined]>;
	commands: string[];
	/** The host's own JSON Schema for `decision_maker`, exactly what the model is offered. */
	schema: JsonObject | null;
};

function stateOf(frames: JsonObject[]): JsonObject | undefined {
	return frames.find((frame) => frame.type === "response" && frame.command === "get_state" && frame.success === true);
}

function collectStatuses(frames: JsonObject[]): Array<[string, string | undefined]> {
	const statuses: Array<[string, string | undefined]> = [];
	for (const frame of frames) {
		if (frame.type === "extension_ui_request" && frame.method === "setStatus") {
			statuses.push([String(frame.statusKey), frame.statusText === undefined ? undefined : String(frame.statusText)]);
		}
	}
	return statuses;
}

/** A real RPC session that never sends a prompt, so no inference can happen. */
async function probeRegistry(jev: string, tools: string[]): Promise<{ probe: RegistryProbe; home: string }> {
	const run = makeIsolatedRun(`probe-${jev}`, PLACEHOLDER_MODELS);
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
		EXTENSION,
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
		const commands = new Set<string>();
		for (const frame of frames) {
			if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
				for (const command of frame.commands) {
					const name = textOf(asObject(command)?.name);
					if (name) commands.add(name);
				}
			}
		}
		const entries = dump.map((tool) => asObject(tool) ?? {});
		const own = entries.find((tool) => textOf(tool.name) === TOOL_NAME);
		return {
			probe: {
				tools: entries.map((tool) => textOf(tool.name) ?? ""),
				statuses: collectStatuses(frames),
				commands: [...commands].sort(),
				schema: asObject(own?.parameters) ?? null,
			},
			home: run.home,
		};
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- smoke (0 main-model turns)

const SMOKE_MARKER = "jev-smoke-result";

/**
 * A temporary extension that calls the real `decide()` twice through the real OMP resolver, with a fetch
 * wrapper that counts requests, measures the UTF-8 body and counts the questions inside it. This is the
 * only place a real HTTP size is observed; the wrapper never exists in the product.
 */
function smokeExtensionSource(fixtureA: Fixture, fixtureB: Fixture): string {
	return `/** Generated by the judgment harness for one zero-inference smoke. */
import decisionMakerExtension, { decide } from ${JSON.stringify(EXTENSION)};

const A = ${JSON.stringify(fixtureA.brief)};
const B = ${JSON.stringify(fixtureB.brief)};
const MARKER = ${JSON.stringify(SMOKE_MARKER)};

const measure = (bucket) => {
  const wrapped = async (url, init) => {
    bucket.requests += 1;
    const body = typeof init?.body === "string" ? init.body : "";
    bucket.requestBytes = new TextEncoder().encode(body).length;
    try {
      bucket.questionCount = Object.keys(JSON.parse(body).questions ?? {}).length;
    } catch {
      bucket.questionCount = -1;
    }
    return await globalThis.fetch(url, init);
  };
  wrapped.calls = () => bucket;
  return wrapped;
};

export default function smokeExtension(pi) {
  const budget = { remaining: 2 };
  pi.registerCommand("jev-smoke", {
    description: "One select request and one score batch through the real resolver",
    handler: async (_args, ctx) => {
      const resolveApiKey = async (signal) =>
        await ctx.modelRegistry.getApiKeyForProvider("openrouter", ctx.sessionManager.getSessionId(), { signal });
      const selectBucket = { requests: 0, requestBytes: 0, questionCount: 0 };
      const scoreBucket = { requests: 0, requestBytes: 0, questionCount: 0 };
      const select = await decide(
        { mode: "select", goal: A.goal, state: A.evidence, candidates: A.candidates },
        { fetch: measure(selectBucket), budget, resolveApiKey },
      );
      const score = await decide(
        { mode: "score", goal: B.goal, state: B.evidence, candidates: B.candidates, rubric: B.rubric },
        { fetch: measure(scoreBucket), budget, resolveApiKey },
      );
      const report = {
        select: { ...selectBucket, status: select.status, reason: select.reason, candidateId: select.candidateId, model: select.model, latencyMs: select.latencyMs, costUsd: select.costUsd },
        score: {
          ...scoreBucket,
          status: score.status,
          reason: score.reason,
          model: score.model,
          latencyMs: score.latencyMs,
          costUsd: score.costUsd,
          scoredIds: score.scores === null ? null : score.scores.map((entry) => entry.candidateId),
          scores: score.scores,
        },
      };
      ctx.ui.notify(MARKER + " " + JSON.stringify(report), "info");
    },
  });
  // The real plugin is loaded too, so the status line and the tool registration stay under test.
  decisionMakerExtension(pi);
}
`;
}

type SmokeResult = {
	passed: boolean;
	reason: string;
	agentTurns: boolean;
	ackWithoutAgentTurn: boolean;
	select: { requests: number; requestBytes: number; questionCount: number; status: string | null; reason: string | null; candidateId: string | null; model: string | null; latencyMs: number | null; costUsd: number | null };
	score: { requests: number; requestBytes: number; questionCount: number; status: string | null; reason: string | null; model: string | null; latencyMs: number | null; costUsd: number | null; scoredIds: string[] | null };
};

const EMPTY_SIDE = { requests: 0, requestBytes: 0, questionCount: 0, status: null, reason: null, candidateId: null, model: null, latencyMs: null, costUsd: null, scoredIds: null as string[] | null };

async function runSmoke(runDir: string, openRouterKey: string, secrets: string[]): Promise<SmokeResult> {
	const run = makeIsolatedRun("smoke", buildModelsYmlFile());
	const probePath = join(run.root, "jev-smoke.ts");
	writeFileSync(probePath, smokeExtensionSource(DIAGNOSTIC, SHORTLIST), "utf8");
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
	const result: SmokeResult = { passed: false, reason: "not run", agentTurns: false, ackWithoutAgentTurn: false, select: { ...EMPTY_SIDE }, score: { ...EMPTY_SIDE } };
	try {
		// The acknowledgement can trail the notification, so wait for both rather than for either.
		// `agentInvoked: false` arrives either inside the prompt response or as its own `prompt_result`.
		const acknowledgement = (seen: JsonObject[]) =>
			seen.find(
				(frame) =>
					(frame.type === "prompt_result" && frame.agentInvoked === false) ||
					(frame.type === "response" && frame.command === "prompt" && frame.success === true && asObject(frame.data)?.agentInvoked === false),
			);
		const notification = (seen: JsonObject[]) =>
			seen.find((frame) => frame.type === "extension_ui_request" && String(frame.message ?? "").includes(SMOKE_MARKER));
		const { frames } = await driveRpc(argv, run, childEnv(run, { jev: "1", openRouterKey }), [{ type: "prompt", message: "/jev-smoke" }], (seen) =>
			Boolean(acknowledgement(seen)) && Boolean(notification(seen)),
		);
		const notified = notification(frames);
		const message = textOf(notified?.message) ?? "";
		let report: JsonObject | undefined;
		try {
			report = asObject(JSON.parse(message.slice(SMOKE_MARKER.length + 1)) as unknown);
		} catch {
			report = undefined;
		}
		const ack = acknowledgement(frames);
		result.agentTurns = frames.some((frame) => frame.type === "agent_start");
		result.ackWithoutAgentTurn = ack !== undefined;
		const select = asObject(report?.select) ?? {};
		const score = asObject(report?.score) ?? {};
		result.select = {
			requests: numberOf(select.requests) ?? 0,
			requestBytes: numberOf(select.requestBytes) ?? 0,
			questionCount: numberOf(select.questionCount) ?? 0,
			status: textOf(select.status),
			reason: textOf(select.reason),
			candidateId: textOf(select.candidateId),
			model: textOf(select.model),
			latencyMs: numberOf(select.latencyMs),
			costUsd: numberOf(select.costUsd),
		};
		result.score = {
			requests: numberOf(score.requests) ?? 0,
			requestBytes: numberOf(score.requestBytes) ?? 0,
			questionCount: numberOf(score.questionCount) ?? 0,
			status: textOf(score.status),
			reason: textOf(score.reason),
			model: textOf(score.model),
			latencyMs: numberOf(score.latencyMs),
			costUsd: numberOf(score.costUsd),
			scoredIds: Array.isArray(score.scoredIds) ? (score.scoredIds as string[]) : null,
		};
		// Evidence goes to the run directory, not the temp root that is deleted on the way out.
		writeFileSync(join(runDir, "smoke.frames.jsonl"), redact(frames.map((frame) => JSON.stringify(frame)).join("\n"), secrets), "utf8");

		let reason = "ok";
		if (result.agentTurns) reason = "the smoke started an agent turn";
		else if (!result.ackWithoutAgentTurn) reason = "the slash command did not answer without an agent turn";
		else if (!report) reason = "no smoke report frame";
		else if (result.select.requests !== 1 || result.select.questionCount !== 1) reason = `select was not exactly one request with one question (${result.select.requests}/${result.select.questionCount})`;
		else if (result.select.requestBytes <= 0) reason = "select sent no measurable body";
		else if (!["selected", "main"].includes(result.select.status ?? "")) reason = `select status was ${result.select.status}`;
		else if (!["selected", "deferred", "uncertain"].includes(result.select.reason ?? "")) reason = `select reason was ${result.select.reason}`;
		else if (result.score.requests !== 1) reason = `the score batch was ${result.score.requests} requests, not one`;
		else if (result.score.questionCount !== SHORTLIST.ids.length) reason = `the score batch carried ${result.score.questionCount} questions, not ${SHORTLIST.ids.length}`;
		else if (result.score.requestBytes <= 0) reason = "score sent no measurable body";
		else if (result.score.status !== "scored") reason = `score status was ${result.score.status}/${result.score.reason}`;
		else if (!result.score.scoredIds || result.score.scoredIds.length !== SHORTLIST.ids.length) reason = "the score batch did not answer every candidate";
		else if (result.score.model === null || !result.score.model.startsWith(JEV_MODEL_PREFIX)) reason = "no versioned Jev model on the score answer";
		result.reason = reason;
		result.passed = reason === "ok";
		return result;
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- sessions

type FixtureRun = {
	fixture: string;
	repeat: number;
	arm: Arm;
	agentMs: number;
	wallMs: number;
	agentExitCode: number;
	agentTimedOut: boolean;
	publicCheck: "passed" | "failed";
	grader: "passed" | "failed";
	taskPassed: boolean;
	failure: string | null;
	briefUnmodified: boolean;
	testsUnmodified: boolean;
	graderUnmodified: boolean;
	mainModels: string[];
	turns: number;
	toolCounts: Record<string, number>;
	toolCallSequence: string[];
	missingToolEnds: string[];
	extensionErrors: number;
	decisionCalls: number;
	decisions: DecisionSample[];
	selected: number;
	scored: number;
	deferred: number;
	uncertain: number;
	clientFailures: number;
	clientFailureReasons: string[];
	jevLatencyMs: number[];
	jevCostUsd: Array<number | null>;
	usageTotals: SessionMetrics["usageTotals"];
	costStatus: "reported" | "unknown";
	mainCostUsd: number | null;
	/** Total session cost on one denominator: main model plus every decision-maker request. */
	totalCostUsd: number | null;
	finalCandidateId: string | null;
	finalMatchesSelection: boolean | null;
	finalInTopScoreSet: boolean | null;
	transcriptPath: string;
	envKeys: string[];
};

async function runSession(order: { fixture: string; repeat: number; arm: Arm }, runDir: string, secrets: string[], openRouterKey: string): Promise<{ record: FixtureRun; violation: string | null }> {
	const fixture = fixtureByName(order.fixture);
	const label = `${fixture.name}-${order.repeat}${order.arm}`;
	const run = makeIsolatedRun(label, buildModelsYmlFile());
	const policyPath = join(run.root, "policy.txt");
	const overlayPath = join(run.root, "overlay.yml");
	const graderPath = join(run.root, "grader.mjs");
	writeTree(run.workspace, workspaceTreeOf(fixture, null));
	writeFileSync(policyPath, COMMON_POLICY, "utf8");
	writeFileSync(overlayPath, `tools:\n  approval:\n    ${TOOL_NAME}: allow\nbash:\n  allowCompoundCommands: false\n  patterns:\n    - match: "bun tests/check.mjs"\n      approval: allow\n`, "utf8");
	writeFileSync(graderPath, graderOf(fixture), "utf8");

	const tools = order.arm === "B" ? BASELINE_TOOLS : TREATMENT_TOOLS;
	const briefPath = join(run.workspace, "brief.json");
	const answerPath = join(run.workspace, "src/answer.json");
	const testPath = join(run.workspace, "tests/check.mjs");
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
		EXTENSION,
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
		fixture.prompt,
	];
	const env = order.arm === "B" ? childEnv(run, { jev: "0" }) : childEnv(run, { jev: "1", openRouterKey });

	try {
		const started = performance.now();
		const agent = await runProcess(argv, run.workspace, SESSION_TIMEOUT_MS, env);
		const metrics = summarizeTranscript(agent.stdout);
		const publicRun = await runProcess(["bun", "tests/check.mjs"], run.workspace, CHECK_TIMEOUT_MS, checkEnv(run));
		const graderRun = await runProcess(["bun", graderPath, run.workspace], run.root, CHECK_TIMEOUT_MS, checkEnv(run));
		const wallMs = Number((performance.now() - started).toFixed(1));
		const finalCandidateId = (() => {
			try {
				return textOf(asObject(JSON.parse(readFileSync(answerPath, "utf8")) as unknown)?.candidateId);
			} catch {
				return null;
			}
		})();
		const lastSelection = [...metrics.decisions].reverse().find((decision) => decision.reason === "selected");
		const lastScores = [...metrics.decisions].reverse().find((decision) => decision.reason === "scored");
		const jevCosts = metrics.jevCostUsd;
		const totalKnown = metrics.mainCostUsd !== null && jevCosts.every((value) => value !== null);

		const transcriptPath = join(runDir, `${label}.jsonl`);
		writeFileSync(transcriptPath, redact(agent.stdout, secrets), "utf8");
		const stderrTail = redact(agent.stderr, secrets).trim().slice(-400);
		if (stderrTail.length > 0) writeFileSync(join(runDir, `${label}.stderr.txt`), stderrTail, "utf8");

		let failure: string | null = null;
		if (agent.timedOut) failure = "the agent exceeded the session timeout";
		else if (agent.code !== 0) failure = `the agent exited ${agent.code}`;
		else if (metrics.missingToolEnds.length > 0) failure = "a tool call never returned an end event";
		else if (metrics.extensionErrors > 0) failure = `the extension reported ${metrics.extensionErrors} error(s)`;
		else if (hashFile(briefPath) !== briefHash) failure = "brief.json was modified";
		else if (hashFile(testPath) !== testHash) failure = "the public check was modified";
		else if (hashOf(readFileSync(graderPath, "utf8")) !== graderHash) failure = "the private grader was modified";
		else if (publicRun.code !== 0) failure = "the public check failed";
		else if (graderRun.code !== 0) failure = "the private grader failed";

		let violation: string | null = null;
		if (order.arm === "B" && metrics.decisionCalls > 0) violation = "the baseline arm called the decision maker";
		else if (order.arm === "B" && metrics.toolCounts[TOOL_NAME] !== undefined) violation = "the baseline arm saw the decision maker";
		else if (order.arm === "J" && metrics.decisions.length < metrics.decisionCalls) violation = "a decision call produced no structured result";
		else if (order.arm === "J" && metrics.clientFailures > 0) violation = `the decision maker failed in the client: ${metrics.clientFailureReasons.join(",")}`;
		else if (metrics.mainModels.length > 0 && metrics.mainModels.some((model) => model !== `${MAIN_PROVIDER}/${MAIN_MODEL_ID}`)) {
			violation = `the session ran on ${metrics.mainModels.join(",")} instead of ${MAIN_PROVIDER}/${MAIN_MODEL_ID}`;
		}

		const record: FixtureRun = {
			fixture: fixture.name,
			repeat: order.repeat,
			arm: order.arm,
			agentMs: agent.ms,
			wallMs,
			agentExitCode: agent.code,
			agentTimedOut: agent.timedOut,
			publicCheck: publicRun.code === 0 ? "passed" : "failed",
			grader: graderRun.code === 0 ? "passed" : "failed",
			taskPassed: finalCandidateId === fixture.winner,
			failure,
			briefUnmodified: hashFile(briefPath) === briefHash,
			testsUnmodified: hashFile(testPath) === testHash,
			graderUnmodified: hashOf(readFileSync(graderPath, "utf8")) === graderHash,
			mainModels: metrics.mainModels,
			turns: metrics.turns,
			toolCounts: metrics.toolCounts,
			toolCallSequence: metrics.toolCallSequence,
			missingToolEnds: metrics.missingToolEnds,
			extensionErrors: metrics.extensionErrors,
			decisionCalls: metrics.decisionCalls,
			decisions: metrics.decisions,
			selected: metrics.selected,
			scored: metrics.scored,
			deferred: metrics.deferred,
			uncertain: metrics.uncertain,
			clientFailures: metrics.clientFailures,
			clientFailureReasons: metrics.clientFailureReasons,
			jevLatencyMs: metrics.jevLatencyMs,
			jevCostUsd: jevCosts,
			usageTotals: metrics.usageTotals,
			costStatus: metrics.costStatus,
			mainCostUsd: metrics.mainCostUsd,
			totalCostUsd: totalKnown ? Number(((metrics.mainCostUsd as number) + jevCosts.reduce((total, value) => total + (value as number), 0)).toFixed(6)) : null,
			finalCandidateId,
			finalMatchesSelection: lastSelection ? finalCandidateId === lastSelection.candidateId : null,
			finalInTopScoreSet: lastScores?.topScoreIds ? lastScores.topScoreIds.includes(finalCandidateId ?? "") : null,
			transcriptPath: transcriptPath.replace(LOCAL_DIR, "<local>"),
			envKeys: Object.keys(env).sort(),
		};
		return { record, violation };
	} finally {
		rmSync(run.root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- results and report

type Pair = { fixture: string; repeat: number; baselineAgentMs: number; treatmentAgentMs: number; agentRatio: number; baselineCostUsd: number | null; treatmentCostUsd: number | null; costRatio: number | null; treatmentFaster: boolean };

type LiveResults = {
	generatedAt: string;
	batch: string;
	runDir?: string;
	versions: { omp: string; bun: string };
	protocol: Record<string, unknown>;
	credentialSource: string;
	credentialVisibleToChild: boolean | null;
	smoke: SmokeResult;
	sessions: FixtureRun[];
	pairs: Pair[];
	perFixture: FixtureSummary[];
	gate: Record<string, unknown>;
};

type FixtureSummary = {
	fixture: string;
	mode: string;
	pairs: number;
	agentMsBaseline: number[];
	agentMsTreatment: number[];
	medianAgentRatio: number | null;
	minAgentRatio: number | null;
	maxAgentRatio: number | null;
	fasterPairs: number;
	costRatioKnownPairs: number;
	medianCostRatio: number | null;
	tasksPassedBaseline: number;
	tasksPassedTreatment: number;
	sessionsBaseline: number;
	sessionsTreatment: number;
	jevRequests: number;
	modesRequested: string[];
	questionCounts: Array<number | null>;
	toolInputBytes: Array<number | null>;
	jevLatencyMs: number[];
	jevCostUsd: Array<number | null>;
	selected: number;
	scored: number;
	deferred: number;
	uncertain: number;
	clientFailures: number;
	finalMatchesSelection: number | null;
	finalInTopScoreSet: number | null;
	costStatus: "reported" | "unknown";
};

function buildPairs(sessions: FixtureRun[]): Pair[] {
	const pairs: Pair[] = [];
	for (const fixture of FIXTURES) {
		for (const repeat of REPEATS) {
			const baseline = sessions.find((session) => session.fixture === fixture.name && session.repeat === repeat && session.arm === "B");
			const treatment = sessions.find((session) => session.fixture === fixture.name && session.repeat === repeat && session.arm === "J");
			if (!baseline || !treatment) continue;
			const costRatio = baseline.totalCostUsd !== null && treatment.totalCostUsd !== null && baseline.totalCostUsd > 0 ? Number((treatment.totalCostUsd / baseline.totalCostUsd).toFixed(4)) : null;
			pairs.push({
				fixture: fixture.name,
				repeat,
				baselineAgentMs: baseline.agentMs,
				treatmentAgentMs: treatment.agentMs,
				agentRatio: Number((treatment.agentMs / baseline.agentMs).toFixed(4)),
				baselineCostUsd: baseline.totalCostUsd,
				treatmentCostUsd: treatment.totalCostUsd,
				costRatio,
				treatmentFaster: treatment.agentMs < baseline.agentMs,
			});
		}
	}
	return pairs;
}

function aggregateFixtures(sessions: FixtureRun[], pairs: Pair[]): FixtureSummary[] {
	return FIXTURES.map((fixture) => {
		const own = sessions.filter((session) => session.fixture === fixture.name);
		const baseline = own.filter((session) => session.arm === "B");
		const treatment = own.filter((session) => session.arm === "J");
		const decisions = treatment.flatMap((session) => session.decisions);
		const ownPairs = pairs.filter((pair) => pair.fixture === fixture.name);
		const ratios = ownPairs.map((pair) => pair.agentRatio);
		const costRatios = ownPairs.map((pair) => pair.costRatio).filter((value): value is number => value !== null);
		const matched = treatment.filter((session) => session.finalMatchesSelection !== null);
		const inTop = treatment.filter((session) => session.finalInTopScoreSet !== null);
		return {
			fixture: fixture.name,
			mode: fixture.mode,
			pairs: ownPairs.length,
			agentMsBaseline: baseline.map((session) => session.agentMs),
			agentMsTreatment: treatment.map((session) => session.agentMs),
			medianAgentRatio: ratios.length > 0 ? Number(median(ratios).toFixed(4)) : null,
			minAgentRatio: ratios.length > 0 ? Math.min(...ratios) : null,
			maxAgentRatio: ratios.length > 0 ? Math.max(...ratios) : null,
			fasterPairs: ownPairs.filter((pair) => pair.treatmentFaster).length,
			costRatioKnownPairs: costRatios.length,
			medianCostRatio: costRatios.length > 0 ? Number(median(costRatios).toFixed(4)) : null,
			tasksPassedBaseline: baseline.filter((session) => session.taskPassed).length,
			tasksPassedTreatment: treatment.filter((session) => session.taskPassed).length,
			sessionsBaseline: baseline.length,
			sessionsTreatment: treatment.length,
			jevRequests: decisions.length,
			modesRequested: [...new Set(decisions.map((decision) => decision.requestedMode ?? "unknown"))].sort(),
			questionCounts: decisions.map((decision) => decision.questionCount),
			toolInputBytes: decisions.map((decision) => decision.toolInputBytes),
			jevLatencyMs: decisions.map((decision) => decision.latencyMs).filter((value): value is number => value !== null),
			jevCostUsd: decisions.map((decision) => decision.costUsd),
			selected: decisions.filter((decision) => decision.reason === "selected").length,
			scored: decisions.filter((decision) => decision.reason === "scored").length,
			deferred: decisions.filter((decision) => decision.reason === "deferred").length,
			uncertain: decisions.filter((decision) => decision.reason === "uncertain").length,
			clientFailures: decisions.filter((decision) => decision.reason !== null && CLIENT_FAILURE_REASONS.includes(decision.reason)).length,
			finalMatchesSelection: matched.length > 0 ? matched.filter((session) => session.finalMatchesSelection).length : null,
			finalInTopScoreSet: inTop.length > 0 ? inTop.filter((session) => session.finalInTopScoreSet).length : null,
			costStatus: [...baseline, ...treatment].every((session) => session.totalCostUsd !== null) ? "reported" : "unknown",
		};
	});
}

function renderReport(results: LiveResults): string {
	const gate = results.gate as Record<string, unknown>;
	const smoke = results.smoke;
	const lines: string[] = [];
	lines.push("# JEV hiệu quả phán đoán — pilot");
	lines.push("");
	lines.push(
		`Sinh lúc ${results.generatedAt} từ \`results.json\` của batch \`${results.batch}\`${results.runDir ? ` (run dir \`${results.runDir}\`)` : ""}. ` +
			`Model chính \`${String((results.protocol as Record<string, unknown>).mainModel)}\`; omp ${results.versions.omp}, bun ${results.versions.bun}. ` +
			`Nguồn credential: \`${results.credentialSource}\` (không ghi giá trị); child điều trị resolve được credential: ${results.credentialVisibleToChild}. ` +
			`Harness: \`${RUNNER_PATH.replace(LOCAL_DIR, "<local>")}\` hash \`${hashOf(readFileSyncSafe(RUNNER_PATH))}\`.`,
	);
	lines.push("");
	lines.push("## 1. Chức năng và giao thức");
	lines.push("");
	lines.push(
		`- Smoke (0 lượt model chính): **${smoke.passed ? "pass" : `fail (${smoke.reason})`}** — select ${smoke.select.requests} request / ${smoke.select.questionCount} câu hỏi / ${smoke.select.requestBytes} byte; ` +
			`score ${smoke.score.requests} request / ${smoke.score.questionCount} câu hỏi / ${smoke.score.requestBytes} byte, ${smoke.score.scoredIds?.length ?? 0} candidate được chấm. ` +
			`Đây là bằng chứng một batch score là **một** HTTP request, không phải suy ra từ số câu hỏi.`,
	);
	lines.push(`- Phiên có prompt: ${String(gate.sessionsRun)}/${String(gate.sessionsExpected)}; request JEV: ${String(gate.jevRequests)}/${String((gate.budget as Record<string, unknown>).maxJevRequests)} (trần), ${String((gate.budget as Record<string, unknown>).maxPromptSessions)} phiên (trần).`);
	if (gate.aborted) lines.push(`- **Batch dừng sớm:** ${String(gate.aborted)}`);
	lines.push("- Hai fixture là hai câu hỏi khác nhau: `diagnostic-selection` (select, negative control — bài rõ ràng thì không gọi tool là hành vi đúng) và `patch-shortlist` (score, 5 phương án một rubric).");
	lines.push("");
	lines.push("## 2. Chất lượng tác vụ");
	lines.push("");
	lines.push("| Fixture | Chế độ | Cặp | winner B | winner J | tool request J | selected | scored | deferred/uncertain | client failure |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|");
	for (const per of results.perFixture) {
		lines.push(
			`| ${per.fixture} | ${per.mode} | ${per.pairs} | ${per.tasksPassedBaseline}/${per.sessionsBaseline} | ${per.tasksPassedTreatment}/${per.sessionsTreatment} | ${per.jevRequests} | ${per.selected} | ${per.scored} | ${per.deferred + per.uncertain} | ${per.clientFailures} |`,
		);
	}
	for (const per of results.perFixture) {
		if (per.jevRequests === 0) {
			lines.push(`- ${per.fixture}: not exercised — tool có mặt nhưng không phiên nào gọi.`);
			continue;
		}
		lines.push(
			`- ${per.fixture}: ${per.finalMatchesSelection ?? "n/a"} phiên điều trị có câu trả lời cuối trùng bước được chọn (select); ${per.finalInTopScoreSet ?? "n/a"} phiên trùng tập điểm cao nhất (score). Đây là **hiệp biến**, không phải chứng minh nhân quả: agent có thể tự đi đến cùng lựa chọn.`,
		);
	}
	lines.push("");
	lines.push("## 3. Thời gian");
	lines.push("");
	lines.push("| Fixture | Cặp | agentMs B | agentMs J | median tỉ lệ J/B | min–max | cặp nhanh hơn |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const per of results.perFixture) {
		lines.push(
			`| ${per.fixture} | ${per.pairs} | ${list(per.agentMsBaseline)} | ${list(per.agentMsTreatment)} | ${per.medianAgentRatio ?? "n/a"} | ${per.minAgentRatio ?? "n/a"}–${per.maxAgentRatio ?? "n/a"} | ${per.fasterPairs}/${per.pairs} |`,
		);
	}
	lines.push("");
	lines.push("- `agentMs` là thời gian phiên model, đã bao gồm mọi round-trip của arm điều trị; không có arm đối chứng 'buộc gọi tool rỗng' nên chưa tách được chi phí của chỉ thị so với chi phí của phán đoán.");
	lines.push("");
	lines.push("## 4. Chi phí");
	lines.push("");
	lines.push("| Fixture | Cặp | tổng cost B (USD) | tổng cost J (USD) | median tỉ lệ cost | cặp có đủ số liệu |");
	lines.push("|---|---|---|---|---|---|");
	for (const per of results.perFixture) {
		const own = results.pairs.filter((pair) => pair.fixture === per.fixture);
		lines.push(
			`| ${per.fixture} | ${per.pairs} | ${list(own.map((pair) => pair.baselineCostUsd))} | ${list(own.map((pair) => pair.treatmentCostUsd))} | ${per.medianCostRatio ?? "n/a"} | ${per.costRatioKnownPairs}/${per.pairs} |`,
		);
	}
	for (const per of results.perFixture) {
		lines.push(
			`- ${per.fixture}: main cost B ${list(results.sessions.filter((s) => s.fixture === per.fixture && s.arm === "B").map((s) => s.mainCostUsd))}, điều trị ${list(results.sessions.filter((s) => s.fixture === per.fixture && s.arm === "J").map((s) => s.mainCostUsd))} USD; JEV ${per.jevRequests} request, latency ${list(per.jevLatencyMs)} ms, cost ${list(per.jevCostUsd)} USD.`,
		);
	}
	lines.push("- Cùng mẫu số ở mọi tỉ lệ chi phí: **tổng cost của cả phiên** (model chính + mọi request JEV). Null giữ nguyên null — thiếu một thành phần thì tổng là unknown, không đổi thành 0.");
	lines.push(`- Trạng thái cost toàn batch: \`${String(gate.costStatus)}\`${gate.knownSubtotalUsd === null ? "" : ` (subtotal đã biết ${String(gate.knownSubtotalUsd)} USD, chưa đầy đủ)`}.`);
	lines.push("");
	lines.push("## 5. Kết luận và giới hạn");
	lines.push("");
	lines.push(`- Collection: ${gate.collectionComplete ? `đủ ${String(gate.sessionsRun)}/${String(gate.sessionsExpected)} phiên, không abort` : `chưa hoàn tất (${String(gate.aborted)})`}.`);
	lines.push(`- Chức năng: ${gate.functionalPass ? "đạt" : "không đạt"} (smoke + đăng ký + cách ly).`);
	lines.push(`- Lợi ích đo được: ${gate.benefit ? "có trên trục đã nêu" : "không có / không đo được"} — xem bảng 3 và 4 theo từng trục riêng.`);
	lines.push("- n=3 cặp/fixture: mô tả, không phải kiểm định. Không suy ra calibration, không so chéo với batch cũ (runtime khác), và không dùng fixture select làm bằng chứng JEV giải được chẩn đoán nhiều bước.");
	lines.push("- Private grader chạy ngoài workspace và hash của nó được đối chiếu trước/sau từng phiên; oracle không nằm trong prompt, tool input hay bất kỳ file nào agent đọc được.");
	return `${lines.join("\n")}\n`;
}

function readFileSyncSafe(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------- modes

function renderFromResults(resultsPath: string, outPath: string): number {
	let stored: LiveResults;
	try {
		stored = JSON.parse(readFileSync(resultsPath, "utf8")) as LiveResults;
	} catch (error) {
		console.error(`cannot read results: ${resultsPath} (${error instanceof Error ? error.message : String(error)})`);
		return 1;
	}
	if (existsSync(outPath)) {
		console.error(`refusing to overwrite an existing report: ${outPath}`);
		return 1;
	}
	// Roll-ups are recomputed from the stored per-session records, so a re-render can never disagree
	// with the metric definitions in this file; the stored records themselves are not rewritten.
	const results: LiveResults = { ...stored, pairs: buildPairs(stored.sessions), perFixture: aggregateFixtures(stored.sessions, buildPairs(stored.sessions)) };
	mkdirSync(dirname(outPath), { recursive: true });
	// Exclusive create: a race that wins the file first must make this run fail, not overwrite.
	const handle = Bun.file(outPath);
	if (handle.size > 0) {
		console.error(`report already exists: ${outPath}`);
		return 1;
	}
	writeFileSync(outPath, renderReport(results), { encoding: "utf8", flag: "wx" });
	console.log(`report: ${outPath}`);
	return 0;
}

async function live(batchName: string): Promise<number> {
	if (!Object.prototype.hasOwnProperty.call(ORDERS, batchName)) {
		console.error(`unknown batch: ${batchName || "(missing)"} (expected ${Object.keys(ORDERS).join(" | ")})\n${USAGE}`);
		return 1;
	}
	const order = ORDERS[batchName];
	const secrets: string[] = [];
	const beforeInputs = inputFingerprint();
	mkdirSync(ARTIFACTS, { recursive: true });
	const runDir = mkdtempSync(join(ARTIFACTS, "run-"));

	let credential: { source: CredentialSource; key: string };
	try {
		const models = buildModelsYmlFile();
		secrets.push(models, ...modelSecrets(models));
		credential = resolveCredential();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeFileSync(join(runDir, "blocked.json"), `${JSON.stringify({ blocked: "credential-or-model", message }, null, 2)}\n`, "utf8");
		console.error(`blocked before any paid work: ${message}`);
		return 1;
	}
	secrets.push(credential.key);
	const credentialVisibleToChild = await confirmChildCredential(credential.key);
	if (!credentialVisibleToChild) {
		writeFileSync(join(runDir, "blocked.json"), `${JSON.stringify({ blocked: "credential-not-visible-in-child", credentialSource: credential.source }, null, 2)}\n`, "utf8");
		console.error("blocked: the isolated child cannot resolve the credential; no paid session was started.");
		return 1;
	}

	const versionRun = makeIsolatedRun("version", PLACEHOLDER_MODELS);
	let ompVersion: ProcessResult;
	let bunVersion: ProcessResult;
	try {
		[ompVersion, bunVersion] = await Promise.all([
			runProcess(["omp", "--version"], versionRun.workspace, 60_000, childEnv(versionRun, {})),
			runProcess(["bun", "--version"], versionRun.workspace, 30_000, childEnv(versionRun, {})),
		]);
	} finally {
		rmSync(versionRun.root, { recursive: true, force: true });
	}

	const protocol = {
		fixtureSet: FIXTURES.map((fixture) => fixture.name),
		order,
		repeats: REPEATS,
		extension: EXTENSION.replace(REPO, "<repo>"),
		mainModel: MAIN_MODEL,
		mainModelRole: "@default",
		jevModelPrefix: JEV_MODEL_PREFIX,
		toolsBaseline: BASELINE_TOOLS.join(","),
		toolsTreatment: TREATMENT_TOOLS.join(","),
		sessionMaxTime: SESSION_MAX_TIME,
		sessionTimeoutMs: SESSION_TIMEOUT_MS,
		commonPolicy: COMMON_POLICY,
		agentsMd: AGENTS_MD,
		prompts: Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, fixture.prompt])),
		briefs: Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, fixture.brief])),
		publicChecks: Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, hashOf(publicCheckOf(fixture))])),
		privateGraders: Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, hashOf(graderOf(fixture))])),
		briefHashes: Object.fromEntries(FIXTURES.map((fixture) => [fixture.name, hashOf(`${JSON.stringify(fixture.brief, null, 2)}\n`)])),
		baselineHasCredential: false,
		budget: { maxPromptSessions: MAX_PROMPT_SESSIONS, maxJevRequests: MAX_JEV_REQUESTS, callLimitPerSession: 5, retries: 0 },
	};
	writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), protocol, beforeInputs }, null, 2)}\n`, "utf8");

	let promptSessions = 0;
	let jevRequests = 0;
	const guard = {
		takeSession() {
			promptSessions += 1;
			if (promptSessions > MAX_PROMPT_SESSIONS) throw new Error(`the ${MAX_PROMPT_SESSIONS}-session cap would be exceeded`);
		},
		takeRequests(count: number) {
			jevRequests += count;
			if (jevRequests > MAX_JEV_REQUESTS) throw new Error(`the ${MAX_JEV_REQUESTS}-request cap would be exceeded`);
		},
	};

	// A smoke fault is recorded, never thrown: the credential is already resolved and the run dir exists,
	// so the evidence has to survive even when the harness itself is what broke.
	let smoke: SmokeResult;
	try {
		smoke = await runSmoke(runDir, credential.key, secrets);
	} catch (error) {
		smoke = { passed: false, reason: `the smoke harness threw: ${error instanceof Error ? error.message : String(error)}`, agentTurns: false, ackWithoutAgentTurn: false, select: { ...EMPTY_SIDE }, score: { ...EMPTY_SIDE } };
	}
	guard.takeRequests(2);
	console.log(`smoke: ${smoke.passed ? "pass" : `fail (${smoke.reason})`}`);
	writeFileSync(join(runDir, "smoke.json"), `${JSON.stringify(smoke, null, 2)}\n`, "utf8");

	const sessions: FixtureRun[] = [];
	let aborted: string | null = smoke.passed ? null : `smoke failed: ${smoke.reason}`;
	if (!aborted) {
		for (const entry of order) {
			// The whole body is guarded: a spawn, parse or write fault must leave the sessions already paid
			// for on disk, which only happens because the tail below always writes `results.json`.
			try {
				guard.takeSession();
				const { record, violation } = await runSession(entry, runDir, secrets, credential.key);
				guard.takeRequests(record.decisionCalls);
				sessions.push(record);
				console.log(`${record.fixture}-${record.repeat}${record.arm}: agentMs ${record.agentMs}, calls ${record.decisionCalls}, winner ${record.taskPassed ? "yes" : "no"}${record.failure ? `, ${record.failure}` : ""}`);
				if (violation) {
					aborted = violation;
					break;
				}
			} catch (error) {
				aborted = `${entry.fixture}-${entry.repeat}${entry.arm} failed inside the harness: ${error instanceof Error ? error.message : String(error)}`;
				break;
			}
		}
	}

	const pairs = buildPairs(sessions);
	const perFixture = aggregateFixtures(sessions, pairs);
	const allCosts = sessions.flatMap((session) => (session.totalCostUsd === null ? [null] : [session.totalCostUsd]));
	const knownSubtotal = allCosts.some((value) => value === null) ? null : sumOrNull(allCosts as number[]);
	const exercised = perFixture.some((per) => per.jevRequests > 0);
	const scoreExercised = perFixture.some((per) => per.mode === "score" && per.scored > 0);
	const collectionComplete = aborted === null && sessions.length === order.length;
	const qualityHolds = perFixture.every((per) => per.tasksPassedTreatment >= per.tasksPassedBaseline);
	const faster = perFixture.every((per) => per.pairs > 0 && per.medianAgentRatio !== null && per.medianAgentRatio < 1);
	const cheaper = perFixture.every((per) => per.pairs > 0 && per.medianCostRatio !== null && per.medianCostRatio < 1);
	const benefit = collectionComplete && exercised && qualityHolds && (faster || cheaper);

	const results: LiveResults = {
		generatedAt: new Date().toISOString(),
		batch: batchName,
		runDir: runDir.replace(LOCAL_DIR, "<local>"),
		versions: { omp: ompVersion.stdout.trim() || "unknown", bun: bunVersion.stdout.trim() || "unknown" },
		protocol,
		credentialSource: credential.source,
		credentialVisibleToChild,
		smoke,
		sessions,
		pairs,
		perFixture,
		gate: {
			aborted,
			collectionComplete,
			sessionsRun: sessions.length,
			sessionsExpected: order.length,
			promptSessions,
			jevRequests,
			budget: protocol.budget,
			costStatus: knownSubtotal === null ? "unknown" : "reported",
			knownSubtotalUsd: knownSubtotal,
			exercised,
			scoreExercised,
			qualityHolds,
			faster,
			cheaper,
			benefit,
			functionalPass: smoke.passed && sessions.every((session) => session.missingToolEnds.length === 0 && session.extensionErrors === 0 && session.briefUnmodified && session.testsUnmodified && session.graderUnmodified),
		},
	};
	writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
	writeFileSync(join(runDir, "report.md"), renderReport(results), "utf8");
	const afterInputs = inputFingerprint();
	const changed = Object.keys({ ...beforeInputs, ...afterInputs }).filter((key) => beforeInputs[key] !== afterInputs[key]);
	writeFileSync(join(runDir, "input-hashes.json"), `${JSON.stringify({ before: beforeInputs, after: afterInputs, changed }, null, 2)}\n`, "utf8");
	console.log(`\nresults: ${join(runDir, "results.json")}`);
	console.log(`gate: ${JSON.stringify(results.gate)}`);
	if (changed.length > 0) console.log(`warning: ${changed.length} tracked input(s) changed during the batch: ${changed.join(", ")}`);
	return collectionComplete ? 0 : 1;
}

/** Hashes of everything the measurement depends on, so a mid-batch edit is visible, not silent. */
function inputFingerprint(): Record<string, string> {
	const paths = [
		EXTENSION,
		join(REPO, "src", "setup-command.ts"),
		join(REPO, "rules", "decision-maker.md"),
		join(REPO, "README.md"),
		join(REPO, "CONTEXT.md"),
		join(REPO, "package.json"),
		join(REPO, ".omp", "config.yml"),
		join(REPO, "scripts", "benchmark-decision-maker.ts"),
		RUNNER_PATH,
	];
	const out: Record<string, string> = {};
	for (const path of paths) out[path.replace(REPO, "<repo>").replace(process.env.HOME ?? "", "<home>")] = hashFile(path);
	return out;
}

// ---------------------------------------------------------------- self-check

async function selfCheck(): Promise<number> {
	let failures = 0;
	const fail = (message: string) => {
		failures += 1;
		console.error(`not ok - ${message}`);
	};
	const pass = (message: string) => console.log(`ok - ${message}`);

	// 1. Every fixture: seed fails, oracle passes, every non-winner passes publicly and fails privately.
	for (const fixture of FIXTURES) {
		const run = makeIsolatedRun(`selfcheck-${fixture.name}`, PLACEHOLDER_MODELS);
		try {
			const graderPath = join(run.root, "grader.mjs");
			writeFileSync(graderPath, graderOf(fixture), "utf8");
			const check = async (candidateId: string | null) => {
				writeTree(run.workspace, workspaceTreeOf(fixture, candidateId));
				const publicRun = await runProcess(["bun", "tests/check.mjs"], run.workspace, CHECK_TIMEOUT_MS, checkEnv(run));
				const privateRun = await runProcess(["bun", graderPath, run.workspace], run.root, CHECK_TIMEOUT_MS, checkEnv(run));
				return { publicPassed: publicRun.code === 0, privatePassed: privateRun.code === 0 };
			};
			const seed = await check(null);
			if (seed.publicPassed || seed.privatePassed) fail(`${fixture.name}: the seeded answer passed a check`);
			const oracle = await check(fixture.winner);
			if (!oracle.publicPassed || !oracle.privatePassed) fail(`${fixture.name}: the oracle answer failed`);
			let wrongOnesClean = true;
			for (const id of fixture.ids.filter((entry) => entry !== fixture.winner)) {
				const result = await check(id);
				if (!result.publicPassed || result.privatePassed) {
					wrongOnesClean = false;
					fail(`${fixture.name}: the non-winner ${id} was not (public pass, private fail)`);
				}
			}
			const unknown = await Promise.all([
				(async () => {
					writeTree(run.workspace, workspaceTreeOf(fixture, "ghost-id"));
					return (await runProcess(["bun", "tests/check.mjs"], run.workspace, CHECK_TIMEOUT_MS, checkEnv(run))).code;
				})(),
				(async () => {
					writeTree(run.workspace, { ...workspaceTreeOf(fixture, fixture.winner), "src/answer.json": "not json" });
					return (await runProcess(["bun", "tests/check.mjs"], run.workspace, CHECK_TIMEOUT_MS, checkEnv(run))).code;
				})(),
			]);
			if (unknown.some((code) => code === 0)) fail(`${fixture.name}: an unknown id or a broken answer file passed the public check`);
			if (seed.publicPassed === false && oracle.publicPassed && wrongOnesClean) pass(`${fixture.name}: seed fails, oracle passes, every non-winner passes publicly and fails privately`);
		} finally {
			rmSync(run.root, { recursive: true, force: true });
		}
	}

	// 2. The transcript parser on a synthetic score batch: five questions must not become five calls.
	const RUBRIC_OF_BRIEF = (SHORTLIST.brief.rubric as string[]) ?? [];
	if (RUBRIC_OF_BRIEF.length < 2) fail("the score fixture brief does not supply a usable rubric");
	const scoreArgs = { mode: "score", goal: "g", state: "s", candidates: SHORTLIST.ids.map((id) => ({ id, kind: "edit", action: `do ${id}`, expected: "done" })), rubric: RUBRIC_OF_BRIEF };
	const scores = SHORTLIST.ids.map((id, index) => ({ candidateId: id, score: index === 0 ? 4 : 1, probabilities: { "0": 0, "1": 1, "2": 0 }, confidence: 0.5 }));
	const synthetic = [
		JSON.stringify({ type: "turn_start" }),
		JSON.stringify({ type: "message_start", message: { role: "assistant", provider: MAIN_PROVIDER, model: MAIN_MODEL_ID } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, reasoningTokens: 0, cost: { total: 0.01 } } } }),
		JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: TOOL_NAME, args: scoreArgs }),
		JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: TOOL_NAME, result: { details: { status: "scored", reason: "scored", candidateId: null, model: "typesafe/jev-1.13-20260917", probability: null, latencyMs: 400, costUsd: 0.00003, scores } } }),
		JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 50, output: 5, totalTokens: 55, cost: { total: 0.005 } } } }),
	].join("\n");
	const parsed = summarizeTranscript(synthetic);
	if (parsed.decisionCalls !== 1) fail(`a five-question batch counted as ${parsed.decisionCalls} calls`);
	if (parsed.clientFailures !== 0) fail("a scored answer was counted as a client failure");
	if (parsed.scored !== 1) fail("the scored reason was not recognised");
	if (parsed.decisions[0]?.questionCount !== 5) fail("the derived question count is wrong");
	if (parsed.decisions[0]?.toolInputBytes === null) fail("the tool input size was not measured");
	if (JSON.stringify(parsed.decisions[0]?.topScoreIds) !== JSON.stringify([SHORTLIST.ids[0]])) fail("the top-score set is wrong");
	if (parsed.mainCostUsd !== 0.015) fail(`main cost total ${parsed.mainCostUsd}`);
	if (parsed.costStatus !== "reported") fail("a fully priced session was not reported");
	if (parsed.turns !== 1) fail("turns were not counted");
	pass("synthetic transcript: one batch is one call, one cost, correct top-score set");

	const unpriced = summarizeTranscript(synthetic.replace('"cost":{"total":0.005}', '"cost":{}'));
	if (unpriced.costStatus !== "unknown" || unpriced.mainCostUsd !== null) fail("a missing cost became zero");
	pass("a missing cost stays unknown, never zero");

	// 3. CLI guards: refused before any filesystem, credential or session work.
	const guardHome = guardEnv();
	const artifactEntries = () => (existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS).length : 0);
	const before = artifactEntries();
	const usageCases: Array<[string[], string]> = [
		[["--batch", "force"], "an unknown batch"],
		[["--batch", "__proto__"], "a prototype key"],
		[["--batch", "constructor"], "a constructor key"],
		[["--batch"], "a missing batch"],
		[["--batch", "judgment", "extra"], "an over-long batch command"],
		[["--render"], "a render with no paths"],
		[["--render", join(ARTIFACTS, "a.json")], "a render with no out path"],
		[["--self-check", "extra"], "an over-long self-check"],
		[["--nonsense"], "an unknown mode"],
	];
	for (const [argv, label] of usageCases) {
		const result = await runProcess(["bun", RUNNER_PATH, ...argv], REPO, 30_000, guardHome);
		if (result.code !== 1) fail(`${label} exited ${result.code} instead of 1`);
		if (!result.stderr.includes("usage:")) fail(`${label} did not print the usage line`);
	}
	// A well-formed render whose input is simply absent reports the reason, naming the path.
	const missingRender = await runProcess(["bun", RUNNER_PATH, "--render", join(ARTIFACTS, "does-not-exist.json"), join(ARTIFACTS, "out.md")], REPO, 30_000, guardHome);
	if (missingRender.code !== 1 || !missingRender.stderr.includes("does-not-exist.json")) fail("a render of a missing file did not name it");
	if (artifactEntries() !== before) fail("a refused CLI call created artifacts");
	if (existsSync(join(ARTIFACTS, "out.md"))) fail("a refused render wrote its output file");
	pass("every CLI refusal happens before credentials, artifacts or sessions");

	// 4. The real registry: the tool appears only when opted in, and the host's own schema for it
	//    carries what the pilot depends on - the mode enum, the rubric, and both `.strict()` objects.
	const off = await probeRegistry("0", BASELINE_TOOLS);
	const on = await probeRegistry("1", TREATMENT_TOOLS);
	if (off.probe.tools.includes(TOOL_NAME)) fail("the baseline tool set exposes the decision maker");
	if (!on.probe.tools.includes(TOOL_NAME)) fail("the opted-in session does not expose the decision maker");
	if (!off.home.startsWith(tmpdir()) || !on.home.startsWith(tmpdir())) fail("a probe home escaped the temp dir");
	if (!off.probe.commands.includes("setup-jev")) fail("the enable command is missing while opted out");
	const schema = on.probe.schema;
	if (!schema) fail("the host reported no parameter schema for decision_maker");
	else {
		const properties = asObject(schema.properties) ?? {};
		const mode = asObject(properties.mode);
		const candidates = asObject(properties.candidates);
		const modeValues = Array.isArray(mode?.enum) ? (mode.enum as unknown[]).map(String) : [];
		if (JSON.stringify(modeValues) !== JSON.stringify(["select", "score"])) fail(`the model was offered mode enum ${JSON.stringify(modeValues)}`);
		if (!properties.rubric) fail("the model was not offered a rubric field");
		if (schema.additionalProperties !== false) fail("the top-level tool schema is not strict");
		if (asObject(candidates?.items)?.additionalProperties !== false) fail("the candidate schema is not strict");
		if (!Array.isArray(schema.required) || !(schema.required as unknown[]).map(String).includes("mode")) fail("mode is not required in the tool schema");
	}
	pass(`registry probe: off=${off.probe.statuses.at(-1)?.[1] ?? "none"}, on=${on.probe.statuses.at(-1)?.[1] ?? "none"}, schema=${schema ? "checked" : "missing"}`);

	console.log(failures === 0 ? "self-check passed (no inference calls made)" : `self-check failed: ${failures} check(s)`);
	return failures === 0 ? 0 : 1;
}

// Every shape error is refused here, before any fingerprint, credential, mkdir or session.
const mode = process.argv[2] ?? "";
const args = process.argv.slice(3);
const refuse = (): 1 => (console.error(USAGE), 1);
let code = 1;
if (mode === "--self-check") {
	code = args.length === 0 ? await selfCheck() : refuse();
} else if (mode === "--batch") {
	code = args.length === 1 ? await live(args[0]) : refuse();
} else if (mode === "--render") {
	code = args.length === 2 ? renderFromResults(args[0], args[1]) : refuse();
} else {
	refuse();
}
process.exit(code);
