/**
 * JEV Decision Maker benchmark — 3 fixtures x 2 arms x 2 repeats = 12 omp sessions.
 *
 *   bun scripts/benchmark-decision-maker.ts --self-check
 *       No inference: each fixture's seeded workspace must fail its own checks,
 *       the oracle repair must pass every check, and the run primitives must work.
 *
 *   bun scripts/benchmark-decision-maker.ts
 *       Live run. `OPENROUTER_API_KEY` must be supplied by the operator in this process
 *       environment - sourcing it from a credential store is outside protocol and invalidates
 *       the batch (see the correction in docs/research/jev-decision-maker.md). The runner aborts
 *       before the first session when it is missing, and needs a usable main-model credential.
 *       Sessions run strictly in sequence (B/J/J/B per fixture); each one is a fresh temp
 *       workspace copied from the fixture seed.
 *
 * Arm B: same extension file loaded, JEV_DECISION_MAKER=0 (tool absent, no network).
 * Arm J: JEV_DECISION_MAKER=1 and the tool is offered.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const EXTENSION = join(REPO, "src", "decision-maker.ts");
const RESEARCH_DIR = join(REPO, "docs", "research");
const TRANSCRIPT_DIR = join(RESEARCH_DIR, "jev-runs");
const RESULTS_PATH = join(RESEARCH_DIR, "jev-decision-maker-results.json");
const SESSION_TIMEOUT_MS = 190_000;
const SESSION_MAX_TIME = "3m";
const GRADER_TIMEOUT_MS = 10_000;
const PUBLIC_TEST = "tests/check.mjs";

const AGENTS_MD = `# Benchmark fixture

Fix the reported defect under \`src/\`. \`${PUBLIC_TEST}\` is the acceptance check: keep it
exactly as it is and make it pass with \`bun ${PUBLIC_TEST}\`.
`;

const COMMON_POLICY = `Work only on the current task in this workspace.

- Edit files under \`src/\` only; leave \`${PUBLIC_TEST}\` exactly as it is.
- Verify with \`bun ${PUBLIC_TEST}\` (that exact command is pre-approved; other shell commands may be refused).
- No git, no dependency installs, no network beyond the tools you are given.
- If a \`decision_maker\` tool is available and you face a real fork between two or more distinct next
  steps, supply 2-5 short candidates with the evidence you already have, then carry out the selected
  candidate with your normal tools, or keep going on your own when it returns \`main\`.
  Never invent options just to call it, and never call it for a step that is obvious or required.
`;

const OVERLAY = `tools:
  approval:
    decision_maker: allow
bash:
  allowCompoundCommands: false
  patterns:
    - match: "bun ${PUBLIC_TEST}"
      approval: allow
`;

const TTL_GRADER = `import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
// The workspace path only exists at run time, so the module specifier must be dynamic.
const { getEntry } = await import(pathToFileURL(join(workspace, "src/cache.mjs")).href);
const { readName, readQuota } = await import(pathToFileURL(join(workspace, "src/consumers.mjs")).href);

const live = { value: "alice", expiresAt: 100 };

assert.equal(getEntry(live, 99), "alice", "shared helper serves a live entry");
assert.equal(getEntry(live, 100), undefined, "shared helper expires exactly at expiresAt");
assert.equal(getEntry(live, 101), undefined, "shared helper expires past expiresAt");
assert.equal(getEntry(null, 0), undefined, "shared helper tolerates a missing entry");

assert.equal(readName(live, 99), "alice");
assert.equal(readName(live, 100), "guest", "name falls back exactly at the expiry instant");
assert.equal(readName(live, 101), "guest");
assert.equal(readName(undefined, 10), "guest", "missing entry falls back");

assert.equal(readQuota({ value: 0, expiresAt: 100 }, 99), 0, "a live zero is not a fallback");
assert.equal(readQuota({ value: 0, expiresAt: 100 }, 100), 10, "an expired zero falls back");
assert.equal(readQuota({ value: 7, expiresAt: 100 }, 101), 10);
assert.equal(readQuota(undefined, 5), 10);
console.log("ttl-cache grader passed");
`;

const PAGINATION_GRADER = `import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
// The workspace path only exists at run time, so the module specifier must be dynamic.
const { collectPages } = await import(pathToFileURL(join(workspace, "src/pages.mjs")).href);

const page = (items, nextCursor) => ({ items, nextCursor });
const paged = (pages) => async (cursor) => {
	assert.ok(pages.has(cursor), "unexpected cursor: " + String(cursor));
	return pages.get(cursor);
};

assert.deepEqual(
	await collectPages(
		paged(
			new Map([
				[null, page(["a"], "p2")],
				["p2", page([], "p3")],
				["p3", page(["b", "c"], null)],
			]),
		),
	),
	["a", "b", "c"],
	"string cursors continue through an empty page",
);

assert.deepEqual(
	await collectPages(
		paged(
			new Map([
				[null, page(["a"], 0)],
				[0, page(["b"], null)],
			]),
		),
	),
	["a", "b"],
	"cursor 0 continues",
);

assert.deepEqual(
	await collectPages(
		paged(
			new Map([
				[null, page(["a"], "")],
				["", page(["b"], null)],
			]),
		),
	),
	["a", "b"],
	"empty-string cursor continues",
);

assert.deepEqual(await collectPages(async () => page(["only"], null)), ["only"], "single page terminates");

const cursors = [];
const recorded = async (cursor) => {
	cursors.push(cursor);
	return cursor === null ? page([], 0) : page([], null);
};
assert.deepEqual(await collectPages(recorded), []);
assert.deepEqual(cursors, [null, 0], "cursors pass through unchanged");

const failing = async (cursor) => {
	if (cursor === null) return page(["a"], "p2");
	throw new Error("page 2 failed");
};
await assert.rejects(async () => await collectPages(failing), /page 2 failed/, "rejection propagates");
console.log("cursor-pagination grader passed");
`;

const SETTINGS_GRADER = `import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
// The workspace path only exists at run time, so the module specifier must be dynamic.
const { mergeSettings } = await import(pathToFileURL(join(workspace, "src/settings.mjs")).href);
const { uiConfig, workerConfig } = await import(pathToFileURL(join(workspace, "src/consumers.mjs")).href);

const base = { theme: "dark", retries: 3, verbose: true, name: "base" };
const withOverride = (override) => ({ ...base, ...override });

assert.deepEqual(mergeSettings(base, { verbose: false }), withOverride({ verbose: false }), "false overrides");
assert.deepEqual(mergeSettings(base, { retries: 0 }), withOverride({ retries: 0 }), "0 overrides");
assert.deepEqual(mergeSettings(base, { name: "" }), withOverride({ name: "" }), "empty string overrides");
assert.deepEqual(mergeSettings(base, { theme: null }), withOverride({ theme: null }), "null overrides");
assert.deepEqual(mergeSettings(base, { extra: false }), withOverride({ extra: false }), "new key keeps false");
assert.deepEqual(mergeSettings(base, { extra: 0 }), withOverride({ extra: 0 }), "new key keeps 0");
assert.deepEqual(mergeSettings(base, {}), base, "missing override keeps base");
assert.deepEqual(mergeSettings(base, { retries: 9 }), withOverride({ retries: 9 }), "truthy override wins");

const frozenBase = { ...base };
const override = { verbose: false, extra: null };
const merged = mergeSettings(frozenBase, override);
assert.deepEqual(frozenBase, base, "base is not mutated");
assert.deepEqual(override, { verbose: false, extra: null }, "override is not mutated");
assert.notEqual(merged, frozenBase, "result is a new object");

assert.deepEqual(uiConfig(base, { verbose: false, retries: 0 }), withOverride({ verbose: false, retries: 0 }));
assert.deepEqual(workerConfig(base, { name: "", extra: false }), withOverride({ name: "", extra: false }));
assert.deepEqual(uiConfig(base, {}), base);
console.log("settings-override grader passed");
`;

type Fixture = {
	name: string;
	prompt: string;
	seed: Record<string, string>;
	oracle: Record<string, string>;
	grader: string;
};

const FIXTURES: Fixture[] = [
	{
		name: "ttl-cache",
		prompt:
			"Trong `src/` có một cache TTL dùng chung. Hiện entry vẫn được phục vụ ngay tại đúng thời điểm hết hạn: " +
			"với `expiresAt = 100`, thời điểm `now = 100` vẫn trả về giá trị cũ. Sửa hàm dùng chung trong `src/` để entry " +
			"hết hạn đúng tại mốc `expiresAt`; không đổi chữ ký hàm và không đổi hành vi phục vụ của các caller trong " +
			"`src/consumers.mjs`. Chạy `bun tests/check.mjs` để kiểm tra.",
		seed: {
			"src/cache.mjs": `export function getEntry(entry, now) {
	if (!entry) return undefined;
	if (now > entry.expiresAt) return undefined;
	return entry.value;
}
`,
			"src/consumers.mjs": `import { getEntry } from "./cache.mjs";

export function readName(entry, now) {
	return getEntry(entry, now) ?? "guest";
}

export function readQuota(entry, now) {
	return getEntry(entry, now) ?? 10;
}
`,
			[PUBLIC_TEST]: `import assert from "node:assert/strict";
import { readName, readQuota } from "../src/consumers.mjs";

const live = { value: "alice", expiresAt: 100 };

assert.equal(readName(live, 99), "alice", "a live entry keeps its value");
assert.equal(readName(live, 100), "guest", "the entry is gone exactly at its expiry instant");
assert.equal(readName(live, 101), "guest", "the entry is gone past its expiry instant");
assert.equal(readName(undefined, 10), "guest", "a missing entry falls back");
assert.equal(readQuota({ value: 0, expiresAt: 100 }, 99), 0, "a live zero is not a fallback");
assert.equal(readQuota({ value: 0, expiresAt: 100 }, 100), 10, "an expired zero falls back");
assert.equal(readQuota({ value: 5, expiresAt: 100 }, 101), 10, "an expired quota falls back");
console.log("ttl-cache checks passed");
`,
		},
		oracle: {
			"src/cache.mjs": `export function getEntry(entry, now) {
	if (!entry) return undefined;
	if (now >= entry.expiresAt) return undefined;
	return entry.value;
}
`,
		},
		grader: TTL_GRADER,
	},
	{
		name: "cursor-pagination",
		prompt:
			"Backend phân trang trả `nextCursor` và kết thúc bằng `null`; cursor hợp lệ có thể là số `0` hoặc chuỗi rỗng " +
			"`\"\"`. `collectPages` trong `src/pages.mjs` đang bỏ mất các trang đó. Sửa để chỉ dừng khi `nextCursor` là " +
			"`null`, giữ nguyên chữ ký hàm và hành vi lỗi hiện tại (reject phải nổi lên, không trả kết quả một phần). " +
			"Chạy `bun tests/check.mjs` để kiểm tra.",
		seed: {
			"src/pages.mjs": `export async function collectPages(fetchPage) {
	const items = [];
	let cursor = null;
	do {
		const page = await fetchPage(cursor);
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}
`,
			[PUBLIC_TEST]: `import assert from "node:assert/strict";
import { collectPages } from "../src/pages.mjs";

const page = (items, nextCursor) => ({ items, nextCursor });
const paged = (pages) => async (cursor) => {
	assert.ok(pages.has(cursor), "unexpected cursor: " + String(cursor));
	return pages.get(cursor);
};

assert.deepEqual(
	await collectPages(
		paged(
			new Map([
				[null, page(["a", "b"], "p2")],
				["p2", page(["c"], 0)],
				[0, page(["d"], "")],
				["", page(["e"], null)],
			]),
		),
	),
	["a", "b", "c", "d", "e"],
	"every page is collected",
);
assert.deepEqual(await collectPages(paged(new Map([[null, page(["only"], null)]]))), ["only"]);
assert.deepEqual(
	await collectPages(
		paged(
			new Map([
				[null, page([], 0)],
				[0, page(["tail"], null)],
			]),
		),
	),
	["tail"],
);
console.log("cursor-pagination checks passed");
`,
		},
		oracle: {
			"src/pages.mjs": `export async function collectPages(fetchPage) {
	const items = [];
	let cursor = null;
	do {
		const page = await fetchPage(cursor);
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== null);
	return items;
}
`,
		},
		grader: PAGINATION_GRADER,
	},
	{
		name: "settings-override",
		prompt:
			"`mergeSettings` trong `src/settings.mjs` đang thay các giá trị falsy tường minh (`false`, `0`, `''`, `null`) " +
			"bằng giá trị mặc định của `base`. Sửa hàm dùng chung để mọi key có trong `override` được ghi đè nguyên giá " +
			"trị, key không có trong override giữ nguyên `base`, key mới nhận đúng giá trị của nó, và hàm không sửa đổi " +
			"tham số đầu vào. Không special-case từng key ở caller. Chạy `bun tests/check.mjs` để kiểm tra.",
		seed: {
			"src/settings.mjs": `export function mergeSettings(base, override) {
	const result = { ...base };
	for (const key of Object.keys(override)) {
		result[key] = override[key] || base[key];
	}
	return result;
}
`,
			"src/consumers.mjs": `import { mergeSettings } from "./settings.mjs";

export function uiConfig(base, override) {
	return mergeSettings(base, override);
}

export function workerConfig(base, override) {
	return mergeSettings(base, override);
}
`,
			[PUBLIC_TEST]: `import assert from "node:assert/strict";
import { uiConfig, workerConfig } from "../src/consumers.mjs";

const base = { theme: "dark", retries: 3, verbose: true, name: "base" };

assert.deepEqual(uiConfig(base, { verbose: false }), { theme: "dark", retries: 3, verbose: false, name: "base" });
assert.deepEqual(uiConfig(base, { retries: 0 }), { theme: "dark", retries: 0, verbose: true, name: "base" });
assert.deepEqual(workerConfig(base, { name: "" }), { theme: "dark", retries: 3, verbose: true, name: "" });
assert.deepEqual(workerConfig(base, { extra: false }), {
	theme: "dark",
	retries: 3,
	verbose: true,
	name: "base",
	extra: false,
});
assert.deepEqual(workerConfig(base, {}), base);

const untouched = { ...base };
const override = { verbose: false };
workerConfig(untouched, override);
assert.deepEqual(untouched, base, "base must not be mutated");
assert.deepEqual(override, { verbose: false }, "override must not be mutated");
console.log("settings-override checks passed");
`,
		},
		oracle: {
			"src/settings.mjs": `export function mergeSettings(base, override) {
	const result = { ...base };
	for (const key of Object.keys(override)) {
		result[key] = override[key];
	}
	return result;
}
`,
		},
		grader: SETTINGS_GRADER,
	},
];

type Arm = "B" | "J";

/** Fixed order: two paired repeats per fixture, two baseline / two treatment. */
const ORDER: Array<{ fixture: string; repeat: number; arm: Arm }> = [
	{ fixture: "ttl-cache", repeat: 1, arm: "B" },
	{ fixture: "ttl-cache", repeat: 1, arm: "J" },
	{ fixture: "ttl-cache", repeat: 2, arm: "J" },
	{ fixture: "ttl-cache", repeat: 2, arm: "B" },
	{ fixture: "cursor-pagination", repeat: 1, arm: "J" },
	{ fixture: "cursor-pagination", repeat: 1, arm: "B" },
	{ fixture: "cursor-pagination", repeat: 2, arm: "B" },
	{ fixture: "cursor-pagination", repeat: 2, arm: "J" },
	{ fixture: "settings-override", repeat: 1, arm: "B" },
	{ fixture: "settings-override", repeat: 1, arm: "J" },
	{ fixture: "settings-override", repeat: 2, arm: "J" },
	{ fixture: "settings-override", repeat: 2, arm: "B" },
];

const CLIENT_FAILURE_REASONS = ["missing_key", "cancelled", "timeout", "http_error", "invalid_response", "network_error"];

type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; ms: number };

async function runProcess(
	argv: string[],
	cwd: string,
	timeoutMs: number,
	env?: Record<string, string>,
): Promise<ProcessResult> {
	const started = performance.now();
	const process_ = Bun.spawn(argv, {
		cwd,
		env: env ? { ...(globalThis.process.env as Record<string, string>), ...env } : globalThis.process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		process_.kill("SIGKILL");
	}, timeoutMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(process_.stdout).text(),
		new Response(process_.stderr).text(),
		process_.exited,
	]);
	clearTimeout(timer);
	return { code, stdout, stderr, timedOut, ms: Number((performance.now() - started).toFixed(1)) };
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [relative, content] of Object.entries(files)) {
		const target = join(root, relative);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
}

function hashOf(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

type DecisionSample = {
	status: string;
	reason: string;
	candidateId: string | null;
	model: string | null;
	probability: number | null;
	latencyMs: number | null;
	costUsd: number | null;
};

type TranscriptSummary = {
	mainModels: string[];
	decisionCalls: number;
	decisions: DecisionSample[];
	extensionErrors: number;
};

function summarizeTranscript(stdout: string): TranscriptSummary {
	const decisions: DecisionSample[] = [];
	const mainModels = new Set<string>();
	let decisionCalls = 0;
	let extensionErrors = 0;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type === "extension_error") {
			extensionErrors += 1;
			continue;
		}
		if (event.type === "message_start") {
			const message = event.message as Record<string, unknown> | undefined;
			if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
				mainModels.add(`${message.provider}/${message.model}`);
			}
			continue;
		}
		if (event.toolName !== "decision_maker") continue;
		if (event.type === "tool_execution_start") {
			decisionCalls += 1;
			continue;
		}
		if (event.type !== "tool_execution_end") continue;
		const result = event.result as Record<string, unknown> | undefined;
		const details = result?.details as Record<string, unknown> | undefined;
		if (typeof details?.reason !== "string") continue;
		decisions.push({
			status: typeof details.status === "string" ? details.status : "unknown",
			reason: details.reason,
			candidateId: typeof details.candidateId === "string" ? details.candidateId : null,
			model: typeof details.model === "string" ? details.model : null,
			probability: typeof details.probability === "number" ? details.probability : null,
			latencyMs: typeof details.latencyMs === "number" ? details.latencyMs : null,
			costUsd: typeof details.costUsd === "number" ? details.costUsd : null,
		});
	}
	return { mainModels: [...mainModels].sort(), decisionCalls, decisions, extensionErrors };
}

type FixtureRun = {
	fixture: string;
	repeat: number;
	arm: Arm;
	workspace: string;
	wallMs: number;
	agentMs: number;
	graderMs: number;
	agentExitCode: number;
	agentTimedOut: boolean;
	publicCheck: "passed" | "failed";
	grader: "passed" | "failed";
	testsUnmodified: boolean;
	passed: boolean;
	failure: string | null;
	mainModels: string[];
	decisionCalls: number;
	decisionSamples: DecisionSample[];
	selected: number;
	deferred: number;
	uncertain: number;
	clientFailures: number;
	jevModels: string[];
	reportedCostUsd: number | null;
	extensionErrors: number;
};

/** Builds one session workspace outside the repo and runs both check layers on it. */
async function runSession(order: { fixture: string; repeat: number; arm: Arm }): Promise<FixtureRun> {
	const fixture = FIXTURES.find((entry) => entry.name === order.fixture);
	if (!fixture) throw new Error(`Unknown fixture: ${order.fixture}`);
	const runRoot = await mkdtemp(join(tmpdir(), `jev-run-${fixture.name}-${order.repeat}${order.arm}-`));
	const workspace = join(runRoot, "workspace");
	const overlayPath = join(runRoot, "overlay.yml");
	const policyPath = join(runRoot, "common-policy.txt");
	const graderPath = join(runRoot, "grader.mjs");
	await writeTree(workspace, { ...fixture.seed, "AGENTS.md": AGENTS_MD });
	await writeFile(overlayPath, OVERLAY, "utf8");
	await writeFile(policyPath, COMMON_POLICY, "utf8");
	await writeFile(graderPath, fixture.grader, "utf8");

	const testPath = join(workspace, PUBLIC_TEST);
	const testHash = hashOf(await readFile(testPath, "utf8"));
	const tools = ["read", "grep", "glob", "edit", "write", "bash"];
	if (order.arm === "J") tools.push("decision_maker");
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

	const started = performance.now();
	const agent = await runProcess(argv, workspace, SESSION_TIMEOUT_MS, {
		JEV_DECISION_MAKER: order.arm === "J" ? "1" : "0",
	});
	await writeFile(join(TRANSCRIPT_DIR, `${fixture.name}-${order.repeat}-${order.arm}.jsonl`), agent.stdout, "utf8");

	const afterHash = hashOf(await readFile(testPath, "utf8").catch(() => ""));
	const testsUnmodified = afterHash === testHash;
	const publicRun = await runProcess(["bun", PUBLIC_TEST], workspace, GRADER_TIMEOUT_MS);
	const graderRun = await runProcess(["bun", graderPath, workspace], runRoot, GRADER_TIMEOUT_MS);
	const wallMs = Number((performance.now() - started).toFixed(1));

	const summary = summarizeTranscript(agent.stdout);
	const selected = summary.decisions.filter((entry) => entry.reason === "selected").length;
	const deferred = summary.decisions.filter((entry) => entry.reason === "deferred").length;
	const uncertain = summary.decisions.filter((entry) => entry.reason === "uncertain").length;
	const clientFailures = summary.decisions.filter((entry) => CLIENT_FAILURE_REASONS.includes(entry.reason)).length;
	const publicCheck = publicRun.code === 0 ? "passed" : "failed";
	const grader = graderRun.code === 0 ? "passed" : "failed";
	const costs = summary.decisions
		.map((entry) => entry.costUsd)
		.filter((value): value is number => typeof value === "number");

	let failure: string | null = null;
	if (agent.timedOut) failure = "agent exceeded the session timeout";
	else if (agent.code !== 0) failure = `agent exited ${agent.code}`;
	else if (!testsUnmodified) failure = "public checks were modified or removed";
	else if (publicCheck === "failed") failure = "public checks failed";
	else if (grader === "failed") failure = "grader failed";
	else if (summary.extensionErrors > 0) failure = "extension reported an error";
	else if (order.arm === "J" && summary.decisionCalls > 0 && summary.decisions.length === 0) {
		failure = "decision calls produced no structured result";
	}

	return {
		fixture: fixture.name,
		repeat: order.repeat,
		arm: order.arm,
		workspace,
		wallMs,
		agentMs: agent.ms,
		graderMs: Number((graderRun.ms + publicRun.ms).toFixed(1)),
		agentExitCode: agent.code,
		agentTimedOut: agent.timedOut,
		publicCheck,
		grader,
		testsUnmodified,
		passed: failure === null,
		failure,
		mainModels: summary.mainModels,
		decisionCalls: summary.decisionCalls,
		decisionSamples: summary.decisions,
		selected,
		deferred,
		uncertain,
		clientFailures,
		jevModels: [...new Set(summary.decisions.map((entry) => entry.model).filter((value): value is string => !!value))].sort(),
		reportedCostUsd: costs.length > 0 ? Number(costs.reduce((total, value) => total + value, 0).toFixed(6)) : null,
		extensionErrors: summary.extensionErrors,
	};
}

async function selfCheck(): Promise<number> {
	const probe = await runProcess(["sleep", "5"], tmpdir(), 300);
	if (!probe.timedOut) {
		console.error("self-check: the runner timeout did not interrupt a sleep");
		return 1;
	}
	const quick = await runProcess(["sleep", "0"], tmpdir(), 5_000);
	if (quick.timedOut || quick.code !== 0) {
		console.error("self-check: a trivial process did not complete");
		return 1;
	}
	let failures = 0;
	for (const fixture of FIXTURES) {
		const root = await mkdtemp(join(tmpdir(), `jev-selfcheck-${fixture.name}-`));
		const workspace = join(root, "workspace");
		const graderPath = join(root, "grader.mjs");
		await writeTree(workspace, { ...fixture.seed, "AGENTS.md": AGENTS_MD });
		await writeFile(graderPath, fixture.grader, "utf8");

		const seedPublic = await runProcess(["bun", PUBLIC_TEST], workspace, GRADER_TIMEOUT_MS);
		const seedGrader = await runProcess(["bun", graderPath, workspace], root, GRADER_TIMEOUT_MS);
		const seedFails = seedPublic.code !== 0 && seedGrader.code !== 0;

		await writeTree(workspace, fixture.oracle);
		const oraclePublic = await runProcess(["bun", PUBLIC_TEST], workspace, GRADER_TIMEOUT_MS);
		const oracleGrader = await runProcess(["bun", graderPath, workspace], root, GRADER_TIMEOUT_MS);
		const oraclePasses = oraclePublic.code === 0 && oracleGrader.code === 0;

		if (seedFails && oraclePasses) {
			console.log(`ok - ${fixture.name}: seed fails both checks, oracle passes both`);
		} else {
			failures += 1;
			console.error(`not ok - ${fixture.name}`);
			console.error(`    seed: public=${seedPublic.code} grader=${seedGrader.code}`);
			console.error(`    oracle: public=${oraclePublic.code} grader=${oracleGrader.code}`);
			console.error(`    seed grader: ${(seedGrader.stderr || seedGrader.stdout).trim().split("\n")[0] ?? ""}`);
			console.error(`    oracle grader: ${(oracleGrader.stderr || oracleGrader.stdout).trim().split("\n")[0] ?? ""}`);
		}
		await rm(root, { recursive: true, force: true });
	}
	console.log(failures === 0 ? "self-check passed (no inference calls made)" : `self-check failed: ${failures}`);
	return failures === 0 ? 0 : 1;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function benchmark(): Promise<number> {
	if (!globalThis.process.env.OPENROUTER_API_KEY?.trim()) {
		console.error("OPENROUTER_API_KEY is not set; the live benchmark was not started (no sessions spent).");
		return 1;
	}
	const version = await runProcess(["omp", "--version"], REPO, 30_000);
	await mkdir(TRANSCRIPT_DIR, { recursive: true });
	const sessions: FixtureRun[] = [];
	let aborted: string | null = null;

	for (const order of ORDER) {
		console.log(`running ${order.fixture} repeat ${order.repeat} arm ${order.arm} ...`);
		const record = await runSession(order);
		sessions.push(record);
		console.log(
			`  ${record.passed ? "passed" : `failed (${record.failure})`} wall=${record.wallMs}ms ` +
				`jevCalls=${record.decisionCalls} selected=${record.selected} main=${record.deferred + record.uncertain} ` +
				`clientFailures=${record.clientFailures} model=${record.mainModels.join("|")}`,
		);
		if (order.arm === "J" && aborted === null) {
			const contractBroken =
				record.extensionErrors > 0 ||
				(record.decisionCalls > 0 && record.selected + record.deferred + record.uncertain === 0);
			if (contractBroken) {
				aborted = `${order.fixture} repeat ${order.repeat}: the JEV contract never produced an answer`;
				console.error(`aborting the paid batch: ${aborted}`);
				break;
			}
		}
	}

	const pairs: Array<{
		fixture: string;
		repeat: number;
		baselineMs: number;
		treatmentMs: number;
		ratio: number;
		treatmentFaster: boolean;
	}> = [];
	for (const fixture of FIXTURES) {
		for (const repeat of [1, 2]) {
			const baseline = sessions.find((entry) => entry.fixture === fixture.name && entry.repeat === repeat && entry.arm === "B");
			const treatment = sessions.find((entry) => entry.fixture === fixture.name && entry.repeat === repeat && entry.arm === "J");
			if (!baseline || !treatment) continue;
			pairs.push({
				fixture: fixture.name,
				repeat,
				baselineMs: baseline.wallMs,
				treatmentMs: treatment.wallMs,
				ratio: Number((treatment.wallMs / baseline.wallMs).toFixed(4)),
				treatmentFaster: treatment.wallMs < baseline.wallMs,
			});
		}
	}

	const allPassed = sessions.length === ORDER.length && sessions.every((entry) => entry.passed);
	const exercised = FIXTURES.every((fixture) =>
		sessions.some((entry) => entry.fixture === fixture.name && entry.arm === "J" && entry.selected > 0),
	);
	const baselineModels = [...new Set(sessions.filter((entry) => entry.arm === "B").flatMap((entry) => entry.mainModels))].sort();
	const treatmentModels = [...new Set(sessions.filter((entry) => entry.arm === "J").flatMap((entry) => entry.mainModels))].sort();
	const mainModelStable =
		baselineModels.length === 1 && treatmentModels.length === 1 && baselineModels[0] === treatmentModels[0];
	const jevModels = [...new Set(sessions.flatMap((entry) => entry.jevModels))].sort();
	const ratios = pairs.map((entry) => entry.ratio);
	const medianRatio = ratios.length > 0 ? Number(median(ratios).toFixed(4)) : null;
	const fasterPairs = pairs.filter((entry) => entry.treatmentFaster).length;
	const speedupHolds = medianRatio !== null && medianRatio <= 0.85 && fasterPairs >= 4;

	const report = {
		generatedAt: new Date().toISOString(),
		ompVersion: version.stdout.trim(),
		protocol: {
			fixtureSet: FIXTURES.map((fixture) => fixture.name),
			order: ORDER,
			sessionMaxTime: SESSION_MAX_TIME,
			sessionTimeoutMs: SESSION_TIMEOUT_MS,
			extension: EXTENSION,
			toolsBaseline: "read,grep,glob,edit,write,bash",
			toolsTreatment: "read,grep,glob,edit,write,bash,decision_maker",
			mainModel: "@default",
			jevModel: "typesafe/jev-1.13",
			overlay: OVERLAY,
			commonPolicy: COMMON_POLICY,
		},
		sessions,
		pairs,
		gate: {
			aborted,
			allSessionsPassed: allPassed,
			jevExercised: exercised,
			mainModelsBaseline: baselineModels,
			mainModelsTreatment: treatmentModels,
			mainModelStable,
			jevModels,
			medianRatio,
			fasterPairs,
			speedupHolds,
			achieved: allPassed && exercised && mainModelStable && speedupHolds,
		},
	};
	await writeFile(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.log(`\nresults: ${RESULTS_PATH}`);
	console.log(`gate: ${JSON.stringify(report.gate)}`);
	return report.gate.achieved ? 0 : 1;
}

const mode = process.argv[2] ?? "";
const code = mode === "--self-check" ? await selfCheck() : await benchmark();
process.exit(code);
