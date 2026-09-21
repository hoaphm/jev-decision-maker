/**
 * Control (empty) tool for protocol v2, arm E.
 *
 * It offers the model the SAME tool name, the SAME description and the SAME strict schema as the real
 * `decision_maker`, and answers with a canned no-guidance result. Nothing here reaches the network, reads
 * a credential or calls `decide()`: the only import from the plugin is two constants, which have no side
 * effects. That is what makes arm E an attribution control - the agent sees the same offer, the same
 * parameters and a plausible "nothing came back" answer, so `median(deltaJ) - median(deltaE)` isolates the
 * contribution of the judgement itself.
 *
 * Two properties are deliberate and belong in the report:
 * - `reason: "control"` is NOT `deferred`. Claiming the model considered and declined would be false, so
 *   the harness must never merge E's answers with J's real refusals: E's are fabricated, J's are measured.
 * - The stub keeps no budget. The 5-call quota is part of what arm J experiences, not part of the control,
 *   and a stub that started answering `call_limit` would look like a client failure.
 *
 * Limitation to state, not to fix: E measures the cost of calling plus placebo exposure, not the cost of
 * calling alone - within one session the agent can learn the tool never helps and stop calling it.
 *
 * Every call is logged to `$HOME/.omp/agent/control-calls.jsonl` inside the isolated HOME (never the
 * workspace), so the harness can report what a real tool would have been asked.
 *
 * It registers no status line, unlike the real extension: the host UI is not part of the model's input, so
 * it cannot change what this arm sees, and a stub has no credential readiness to report. The self-check
 * asserts that absence rather than tolerating a label this arm cannot honour.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TOOL_DESCRIPTION, TOOL_NAME } from "../../../src/decision-maker.ts";

/** The fabricated answer. Shape-identical to a real return-to-main result; `reason` is not a product reason. */
const CONTROL_RESULT = {
	status: "main",
	candidateId: null,
	reason: "control",
	model: null,
	probability: null,
	probabilities: null,
	confidence: null,
	scores: null,
	latencyMs: 0,
	costUsd: 0,
};

export default function controlToolExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	const logPath = join(process.env.HOME ?? "", ".omp", "agent", "control-calls.jsonl");
	pi.registerTool({
		name: TOOL_NAME,
		label: "Decision Maker",
		description: TOOL_DESCRIPTION,
		approval: "exec",
		loadMode: "essential",
		hidden: false,
		defaultInactive: false,
		parameters: z
			.object({
				mode: z.enum(["select", "score"]),
				goal: z.string(),
				state: z.string(),
				candidates: z.array(
					z
						.object({
							id: z.string(),
							kind: z.string(),
							action: z.string(),
							expected: z.string(),
						})
						.strict(),
				),
				rubric: z.array(z.string()).optional(),
			})
			.strict(),
		async execute(toolCallId: string, params: unknown) {
			try {
				mkdirSync(dirname(logPath), { recursive: true });
				appendFileSync(
					logPath,
					`${JSON.stringify({ at: new Date().toISOString(), toolCallId, args: params, result: "control" })}\n`,
					"utf8",
				);
			} catch {
				// Logging must never change what the arm measures; a missing log is reported separately.
			}
			return { content: [{ type: "text", text: JSON.stringify(CONTROL_RESULT) }], details: CONTROL_RESULT };
		},
	});
}
