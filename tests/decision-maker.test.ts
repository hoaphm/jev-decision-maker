/**
 * Guard checks for the JEV decision maker HTTP boundary.
 *
 * Runnable directly: `bun tests/decision-maker.test.ts`
 * No test framework: a fetch stub is injected at the boundary, so nothing here
 * proves live network behavior — that needs a real omp session (benchmark).
 */

import assert from "node:assert/strict";
import decisionMakerExtension, {
	BUDGET_RESET_REASONS,
	CALL_LIMIT,
	DEFER_ID,
	decide,
	statusLabel,
	type Candidate,
	type DecisionInput,
	type DecisionResult,
	type StatusState,
} from "../src/decision-maker.ts";

const KEY = "test-openrouter-key";
const CANDIDATES: Candidate[] = [
	{ id: "repair", kind: "edit", action: "Fix the shared comparison", expected: "Boundary case returns the default" },
	{ id: "inspect", kind: "read", action: "Read both callers", expected: "Both callers route through the shared helper" },
	{ id: "rerun", kind: "check", action: "Re-run the checks", expected: "The checks pass" },
];

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
	return {
		goal: "Fix the shared expiry comparison",
		state: "The seeded helper serves a value exactly at expiresAt",
		candidates: CANDIDATES,
		...overrides,
	};
}

/** A full criteria distribution: every caller id plus the reserved defer id. */
function distribution(entries: Record<string, number>): Record<string, number> {
	return { repair: 0, inspect: 0, rerun: 0, [DEFER_ID]: 0, ...entries };
}

function payload(answer: Record<string, unknown> = {}, top: Record<string, unknown> = {}): unknown {
	return {
		id: "gen-test",
		model: "typesafe/jev-1.13-20260917",
		provider: "TypeSafe",
		answers: { next_step: { type: "choice", confidence: 0.93, ...answer } },
		usage: { input_tokens: 120, output_tokens: 12, cost: 0.00003 },
		...top,
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const impl = (async (url: unknown, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		return await handler(call);
	}) as typeof globalThis.fetch;
	return { calls, impl };
}

function neverSettles(): typeof globalThis.fetch {
	return (async (_url: unknown, init?: RequestInit) => {
		const { promise, reject } = Promise.withResolvers<Response>();
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		if (init?.signal?.aborted) abort();
		else init?.signal?.addEventListener("abort", abort, { once: true });
		return await promise;
	}) as typeof globalThis.fetch;
}

type RegisteredTool = {
	approval: string;
	loadMode: string;
	execute: (
		toolCallId: string,
		params: DecisionInput,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: unknown[]; details: DecisionResult }>;
	onSession?: (event: unknown) => void;
};

type Handler = (event: unknown, ctx: unknown) => unknown;
type Registration = { tool: RegisteredTool | null; handlers: Map<string, Handler[]> };

/** Pinned because slot order on the shared status line is decided by this key. */
const STATUS_KEY = "jev";
const STATUS_EVENTS = ["session_start", "session_switch", "session_branch", "session_tree"];

type RegistrationOptions = { optIn?: string; hasKey?: boolean; activeTools?: string[] };

/**
 * Runs the real factory against a stub and holds the environment it reads in place for the whole
 * body: the extension samples the credential when it renders the status line, so the state under
 * test has to survive until the handlers run.
 */
async function withRegistration<T>(options: RegistrationOptions, body: (registration: Registration) => Promise<T> | T): Promise<T> {
	const handlers = new Map<string, Handler[]>();
	let tool: RegisteredTool | null = null;
	const previousFlag = process.env.JEV_DECISION_MAKER;
	const previousKey = process.env.OPENROUTER_API_KEY;
	if (options.optIn === undefined) delete process.env.JEV_DECISION_MAKER;
	else process.env.JEV_DECISION_MAKER = options.optIn;
	if (options.hasKey === false) delete process.env.OPENROUTER_API_KEY;
	const stub = {
		zod: { object: () => ({}), string: () => ({}), array: () => ({}) },
		registerTool: (definition: RegisteredTool) => {
			tool = definition;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools: () => options.activeTools ?? ["read"],
	};
	try {
		decisionMakerExtension(stub as unknown as Parameters<typeof decisionMakerExtension>[0]);
		return await body({ tool, handlers });
	} finally {
		if (previousFlag === undefined) delete process.env.JEV_DECISION_MAKER;
		else process.env.JEV_DECISION_MAKER = previousFlag;
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
	}
}

/** A session-context stub that records status writes instead of painting a terminal. */
function statusSink() {
	const writes: Array<[string, string | undefined]> = [];
	return {
		writes,
		ctx: { ui: { setStatus: (key: string, text: string | undefined) => void writes.push([key, text]) } },
	};
}

/** Drives one lifecycle event and returns what the extension wrote to the status line. */
function statusWrites(registration: Registration, event: string): Array<[string, string | undefined]> {
	const sink = statusSink();
	for (const handler of registration.handlers.get(event) ?? []) handler({ reason: event.slice(8) }, sink.ctx);
	return sink.writes;
}

async function labelsFor(options: RegistrationOptions): Promise<string[]> {
	return withRegistration(options, (registration) => {
		const seen: string[] = [];
		for (const event of STATUS_EVENTS) {
			const writes = statusWrites(registration, event);
			assert.ok(writes.length > 0, `no status write for ${event}`);
			for (const [key, text] of writes) {
				assert.equal(key, STATUS_KEY, `unexpected status key for ${event}`);
				assert.ok(typeof text === "string", `status was cleared during ${event}`);
				seen.push(text);
			}
		}
		return seen;
	});
}

const failures: string[] = [];
let ran = 0;

async function test(name: string, body: () => Promise<void>): Promise<void> {
	ran += 1;
	try {
		await body();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures.push(name);
		console.error(`not ok - ${name}`);
		console.error(`    ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function main(): Promise<void> {
	const previousKey = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = KEY;
	try {
		await test("request carries the capped payload and the key only in the header", async () => {
			const { calls, impl } = stubFetch(() => json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) })));
			const result = await decide(input(), { fetch: impl });
			assert.equal(result.status, "selected");
			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, "https://openrouter.ai/api/v1/systemone");
			assert.equal(calls[0].init.method, "POST");
			assert.equal(calls[0].init.redirect, "error");
			const headers = calls[0].init.headers as Record<string, string>;
			assert.equal(headers.authorization, `Bearer ${KEY}`);
			const sent = JSON.parse(String(calls[0].init.body)) as Record<string, any>;
			assert.equal(sent.model, "typesafe/jev-1.13");
			assert.deepEqual(Object.keys(sent.questions.next_step.criteria).sort(), ["__defer__", "inspect", "repair", "rerun"]);
			assert.deepEqual(
				sent.state.candidates.map((entry: Candidate) => entry.id),
				["repair", "inspect", "rerun"],
			);
			assert.equal(String(calls[0].init.body).includes(KEY), false);
		});

		await test("clear choice returns the caller's own candidate id", async () => {
			const { impl } = stubFetch(() => json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) })));
			const result = await decide(input(), { fetch: impl });
			assert.equal(result.status, "selected");
			assert.equal(result.reason, "selected");
			assert.equal(result.candidateId, "repair");
			assert.equal(result.model, "typesafe/jev-1.13-20260917");
			assert.equal(result.probability, 0.96);
			assert.equal(result.confidence, 0.93);
			assert.equal(result.costUsd, 0.00003);
			assert.deepEqual(result.probabilities, distribution({ repair: 0.96, rerun: 0.04 }));
			assert.ok(result.latencyMs >= 0);
		});

		await test("thresholds: read at 0.90 and edit at 0.95 are selected, just below defers to main", async () => {
			const cases: Array<[string, string, number, "selected" | "main"]> = [
				["inspect", "read", 0.9, "selected"],
				["inspect", "read", 0.89, "main"],
				["repair", "edit", 0.95, "selected"],
				["repair", "edit", 0.94, "main"],
				["rerun", "check", 0.95, "selected"],
				["rerun", "check", 0.94, "main"],
			];
			for (const [id, kind, probability, expected] of cases) {
				const rest = 1 - probability;
				const others = CANDIDATES.filter((entry) => entry.id !== id).map((entry) => entry.id);
				const probabilities = distribution({
					[id]: probability,
					[others[0]]: rest,
				});
				const { impl } = stubFetch(() => json(payload({ choice: id, probabilities })));
				const result = await decide(input(), { fetch: impl });
				assert.equal(result.status, expected, `${kind} p=${probability}`);
				assert.equal(result.candidateId, expected === "selected" ? id : null, `${kind} p=${probability}`);
			}
		});

		await test("defer returns control with the validated distribution", async () => {
			const { impl } = stubFetch(() => json(payload({ choice: DEFER_ID, probabilities: distribution({ [DEFER_ID]: 0.8, inspect: 0.2 }) })));
			const result = await decide(input(), { fetch: impl });
			assert.equal(result.status, "main");
			assert.equal(result.reason, "deferred");
			assert.equal(result.candidateId, null);
			assert.equal(result.probability, 0.8);
			assert.equal(result.model, "typesafe/jev-1.13-20260917");
		});

		await test("malformed or dishonest responses return main/invalid_response", async () => {
			const cases: Array<[string, Response]> = [
				["missing probabilities", json(payload({ choice: "repair" }))],
				["missing confidence", json({ answers: { next_step: { type: "choice", choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) } } }, 200)],
				["unknown criteria key", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04, ghost: 0 }) }))],
				["missing criteria key", json(payload({ choice: "repair", probabilities: { repair: 0.96, [DEFER_ID]: 0.04 } }))],
				["out of range value", json(payload({ choice: "repair", probabilities: distribution({ repair: 1.2, rerun: -0.2 }) }))],
				["non-finite value", new Response('{"model":"typesafe/jev-1.13","provider":"TypeSafe","answers":{"next_step":{"type":"choice","choice":"repair","confidence":0.9,"probabilities":{"repair":1e999,"inspect":0,"rerun":0,"__defer__":0}}}}')],
				["probabilities do not sum to one", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.9, inspect: 0.5 }) }))],
				["tied maximum", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.5, inspect: 0.5 }) }))],
				["choice is not the maximum", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.2, inspect: 0.8 }) }))],
				["confidence above one", json(payload({ choice: "repair", confidence: 1.4, probabilities: distribution({ repair: 0.96, rerun: 0.04 }) }))],
				["wrong provider", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) }, { provider: "Someone" }))],
				["wrong model", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) }, { model: "openai/gpt-5" }))],
				["missing model", json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) }, { model: undefined }))],
				["unknown question type", json(payload({ type: "noul", noul: 0.9 }))],
				["broken json", new Response("{oops")],
				["body past the 256 KiB cap", new Response("x".repeat(300 * 1024))],
			];
			for (const [name, response] of cases) {
				const { calls, impl } = stubFetch(() => response);
				const result = await decide(input(), { fetch: impl });
				assert.equal(result.status, "main", name);
				assert.equal(result.reason, "invalid_response", name);
				assert.equal(result.candidateId, null, name);
				assert.equal(result.probabilities, null, name);
				assert.equal(result.model, null, name);
				assert.equal(calls.length, 1, `${name}: no retry`);
			}
		});

		await test("HTTP failures return main/http_error without retrying", async () => {
			for (const status of [401, 402, 429, 500, 503]) {
				const { calls, impl } = stubFetch(() => new Response("{}", { status }));
				const result = await decide(input(), { fetch: impl });
				assert.equal(result.status, "main", String(status));
				assert.equal(result.reason, "http_error", String(status));
				assert.equal(result.candidateId, null, String(status));
				assert.equal(calls.length, 1, `${status}: no retry`);
			}
		});

		await test("network rejection returns main/network_error without retrying", async () => {
			const { calls, impl } = stubFetch(() => Promise.reject(new TypeError("connection reset")));
			const result = await decide(input(), { fetch: impl });
			assert.equal(result.status, "main");
			assert.equal(result.reason, "network_error");
			assert.equal(calls.length, 1);
		});

		// Exercises the client's own 3s deadline against the platform clock; a fake
		// clock cannot drive a deadline that lives inside the code under test.
		await test("a hung request times out into main/timeout", async () => {
			const result = await decide(input(), { fetch: neverSettles() });
			assert.equal(result.status, "main");
			assert.equal(result.reason, "timeout");
			assert.equal(result.candidateId, null);
			assert.ok(result.latencyMs >= 2900, `latency ${result.latencyMs}`);
		});

		await test("caller cancellation returns main/cancelled and aborts the request", async () => {
			const controller = new AbortController();
			let observedAbort = false;
			const impl = (async (_url: unknown, init?: RequestInit) => {
				const { promise, reject } = Promise.withResolvers<Response>();
				init?.signal?.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						reject(new DOMException("Aborted", "AbortError"));
					},
					{ once: true },
				);
				// The caller gives up while the request is in flight; no wall-clock wait.
				controller.abort();
				return await promise;
			}) as typeof globalThis.fetch;
			const result = await decide(input(), { fetch: impl, signal: controller.signal });
			assert.equal(result.status, "main");
			assert.equal(result.reason, "cancelled");
			assert.equal(observedAbort, true);
			assert.ok(result.latencyMs < 2900, `latency ${result.latencyMs}`);
		});

		await test("invalid input never reaches the network", async () => {
			const cases: Array<[string, DecisionInput]> = [
				["empty goal", input({ goal: "" })],
				["blank goal", input({ goal: "   " })],
				["oversized goal", input({ goal: "g".repeat(1001) })],
				["empty state", input({ state: "" })],
				["oversized state", input({ state: "s".repeat(12001) })],
				["single candidate", input({ candidates: [CANDIDATES[0]] })],
				["six candidates", input({ candidates: [...CANDIDATES, CANDIDATES[0], CANDIDATES[1], CANDIDATES[2]] })],
				["duplicate ids", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], id: "repair" }] })],
				["uppercase id", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], id: "Repair" }] })],
				["leading underscore id", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], id: "_repair" }] })],
				["reserved defer id", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], id: DEFER_ID }] })],
				["unknown kind", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], kind: "write" as Candidate["kind"] }] })],
				["empty action", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], action: "" }] })],
				["oversized expected", input({ candidates: [CANDIDATES[0], { ...CANDIDATES[1], expected: "e".repeat(601) }] })],
				["request past the 24 KiB byte cap", input({ state: "ế".repeat(9000) })],
			];
			for (const [name, payloadInput] of cases) {
				const { calls, impl } = stubFetch(() => json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) })));
				const result = await decide(payloadInput, { fetch: impl });
				assert.equal(result.status, "main", name);
				assert.equal(result.reason, "invalid_input", name);
				assert.equal(calls.length, 0, `${name}: no request`);
			}
		});

		await test("a missing key returns main/missing_key without a request", async () => {
			const { calls, impl } = stubFetch(() => json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) })));
			delete process.env.OPENROUTER_API_KEY;
			try {
				for (const stored of [undefined, "", "   "]) {
					if (stored === undefined) delete process.env.OPENROUTER_API_KEY;
					else process.env.OPENROUTER_API_KEY = stored;
					const result = await decide(input(), { fetch: impl });
					assert.equal(result.status, "main", String(stored));
					assert.equal(result.reason, "missing_key", String(stored));
				}
			} finally {
				process.env.OPENROUTER_API_KEY = KEY;
			}
			assert.equal(calls.length, 0);
		});

		await test(`the session call limit stops the ${CALL_LIMIT + 1}th request`, async () => {
			const { calls, impl } = stubFetch(() => json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) })));
			const budget = { remaining: CALL_LIMIT };
			for (let index = 0; index < CALL_LIMIT; index += 1) {
				const result = await decide(input(), { fetch: impl, budget });
				assert.equal(result.status, "selected", `call ${index + 1}`);
			}
			const blocked = await decide(input(), { fetch: impl, budget });
			assert.equal(blocked.status, "main");
			assert.equal(blocked.reason, "call_limit");
			assert.equal(budget.remaining, 0);
			assert.equal(calls.length, CALL_LIMIT);
		});

		await test("the budget is claimed synchronously, so concurrent calls cannot overrun it", async () => {
			const gate = Promise.withResolvers<void>();
			const { calls, impl } = stubFetch(async () => {
				await gate.promise;
				return json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) }));
			});
			const budget = { remaining: 1 };
			// Both calls start before either fetch settles; the slot is claimed synchronously.
			const first = decide(input(), { fetch: impl, budget });
			const second = decide(input(), { fetch: impl, budget });
			const blocked = await second;
			assert.equal(blocked.status, "main");
			assert.equal(blocked.reason, "call_limit");
			gate.resolve();
			const selected = await first;
			assert.equal(selected.status, "selected");
			assert.equal(calls.length, 1);
		});

		// The per-session quota is a session contract: mid-session signals must not top it back up.
		await test("only session-change lifecycle events reset the call budget", async () => {
			assert.deepEqual([...BUDGET_RESET_REASONS].sort(), ["branch", "start", "switch", "tree"]);
			await withRegistration({}, ({ tool }) => assert.equal(tool, null, "no tool when the switch is unset"));
			await withRegistration({ optIn: "0" }, ({ tool }) => assert.equal(tool, null, "only exactly 1 opts in"));

			const { calls, impl } = stubFetch(() =>
				json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) })),
			);
			// execute() has no fetch seam of its own, so the process-wide boundary is stubbed:
			// this check must never reach the network.
			const realFetch = globalThis.fetch;
			globalThis.fetch = impl;
			try {
				await withRegistration({ optIn: "1", activeTools: ["read", "decision_maker"] }, async ({ tool }) => {
					assert.ok(tool, "the opted-in factory registers a tool");
					assert.equal(tool.approval, "exec");
					assert.equal(tool.loadMode, "essential");
					const { writes, ctx } = statusSink();
					for (let index = 0; index < CALL_LIMIT; index += 1) {
						const result = await tool.execute(`call-${index}`, input(), undefined, undefined, ctx);
						assert.equal(result.details.reason, "selected", `call ${index + 1}`);
					}
					const exhausted = await tool.execute("over-limit", input(), undefined, undefined, ctx);
					assert.equal(exhausted.details.reason, "call_limit");

					tool.onSession?.({ reason: "todo_reminder" });
					tool.onSession?.({ reason: "auto_retry_start" });
					tool.onSession?.({ reason: "ttsr_triggered" });
					tool.onSession?.({ reason: "auto_compaction_end" });
					const stillExhausted = await tool.execute("after-signals", input(), undefined, undefined, ctx);
					assert.equal(stillExhausted.details.reason, "call_limit");
					assert.equal(calls.length, CALL_LIMIT);

					tool.onSession?.({ reason: "switch" });
					const afterSwitch = await tool.execute("new-session", input(), undefined, undefined, ctx);
					assert.equal(afterSwitch.details.reason, "selected");
					assert.equal(calls.length, CALL_LIMIT + 1);
					// One refresh per call, so the line tracks what just happened.
					assert.equal(writes.length, 8, JSON.stringify(writes));
				});
			} finally {
				globalThis.fetch = realFetch;
			}
		});

		await test("the status label is decided by opt-in, key and activation", () => {
			const cases: Array<[StatusState, string]> = [
				[{ optedIn: false, hasKey: false, toolActive: false }, "JEV off"],
				[{ optedIn: false, hasKey: false, toolActive: true }, "JEV off"],
				[{ optedIn: false, hasKey: true, toolActive: false }, "JEV off"],
				[{ optedIn: false, hasKey: true, toolActive: true }, "JEV off"],
				[{ optedIn: true, hasKey: false, toolActive: false }, "JEV no key"],
				[{ optedIn: true, hasKey: false, toolActive: true }, "JEV no key"],
				[{ optedIn: true, hasKey: true, toolActive: false }, "JEV inactive"],
				[{ optedIn: true, hasKey: true, toolActive: true }, "JEV on"],
			];
			assert.equal(cases.length, 8, "the truth table must cover every state");
			for (const [state, label] of cases) assert.equal(statusLabel(state), label, JSON.stringify(state));
		});

		await test("every session event reports the same readiness label", async () => {
			const cases: Array<{ name: string; options: { optIn?: string; hasKey?: boolean; activeTools?: string[] }; label: string }> = [
				{ name: "opted out", options: {}, label: "JEV off" },
				{ name: "no key", options: { optIn: "1", hasKey: false }, label: "JEV no key" },
				{ name: "not active", options: { optIn: "1", activeTools: ["read"] }, label: "JEV inactive" },
				{ name: "ready", options: { optIn: "1", activeTools: ["read", "decision_maker"] }, label: "JEV on" },
			];
			for (const testCase of cases) {
				const written = await labelsFor(testCase.options);
				assert.equal(written.length, STATUS_EVENTS.length, testCase.name);
				for (const text of written) {
					assert.ok(text.endsWith(testCase.label), `${testCase.name}: "${text}" should end with "${testCase.label}"`);
					assert.equal(text.includes("\x1b"), false, `${testCase.name}: status text must not carry ANSI`);
					assert.equal(text.includes("\n"), false, `${testCase.name}: status text must stay on one line`);
				}
			}
		});

		await test("the status line exists when opted out and clears at shutdown", () =>
			withRegistration({}, (registration) => {
				assert.equal(registration.tool, null, "opting out must not register a tool");
				assert.ok((registration.handlers.get("session_start") ?? []).length > 0, "no status handler registered while opted out");
				assert.deepEqual(
					statusWrites(registration, "session_shutdown"),
					[[STATUS_KEY, undefined]],
					"shutdown must clear its own status slot",
				);
			}),
		);

		await test("the status line is refreshed after a call returns", () =>
			withRegistration({ optIn: "1", hasKey: false }, async ({ tool }) => {
				assert.ok(tool, "the tool must be registered when opted in");
				const { writes, ctx } = statusSink();
				// No key: the call is answered locally, but the status line must still be refreshed.
				const result = await tool.execute("call", input(), undefined, undefined, ctx);
				assert.equal(result.details.reason, "missing_key");
				assert.ok(
					writes.some(([key, text]) => key === STATUS_KEY && text?.endsWith("JEV no key")),
					`status not refreshed after execute: ${JSON.stringify(writes)}`,
				);
			}),
		);

		await test("missing or nonsensical cost is reported as null, never as zero", async () => {
			for (const usage of [undefined, {}, { cost: null }, { cost: -1 }, { cost: "free" }]) {
				const top = usage === undefined ? { usage: undefined } : { usage };
				const { impl } = stubFetch(() => json(payload({ choice: "repair", probabilities: distribution({ repair: 0.96, rerun: 0.04 }) }, top)));
				const result = await decide(input(), { fetch: impl });
				assert.equal(result.status, "selected", JSON.stringify(usage));
				assert.equal(result.costUsd, null, JSON.stringify(usage));
			}
		});
	} finally {
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
	}

	if (failures.length > 0) {
		console.error(`${failures.length} of ${ran} checks failed: ${failures.join(", ")}`);
		process.exit(1);
	}
	console.log(`all ${ran} checks passed`);
}

await main();
