/**
 * `/setup-jev` - the enable path for the decision maker.
 *
 * Measured behaviour this leans on (omp 18.2.6, isolated HOME, RPC get_state only, no inference):
 *   - a launch-directory `.env` is read from the launch directory exactly, never from ancestors, so a
 *     project switch only applies when omp starts in that directory;
 *   - `~/.omp/agent/.env` is read regardless of the working directory, so it works as the machine-wide
 *     switch and as the credential store;
 *   - the process environment beats both, which is what keeps `JEV_DECISION_MAKER=0` authoritative.
 *
 * The command never asks for the credential: omp's extension UI has no masked input, so a key typed
 * into a prompt would land in the transcript. It copies a key the operator already exported, or prints
 * the shell line to run instead.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export const SETUP_COMMAND = "setup-jev";
export const SWITCH_KEY = "JEV_DECISION_MAKER";
export const CREDENTIAL_KEY = "OPENROUTER_API_KEY";
const ENV_MODE = 0o600;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;
export type SetupContext = {
	cwd: string;
	env: Record<string, string | undefined>;
	exec: Exec;
	/** Whether the tool is in the session's active set; omitted when the caller cannot know. */
	toolActive?: boolean;
};
export type SetupReport = { level: "info" | "warn" | "error"; lines: string[] };

/** The dotenv subset this command reads and writes: `KEY=value` lines, `#` comments, blank lines. */
export function parseEnvFile(content: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator <= 0) continue;
		const key = trimmed.slice(0, separator).trim();
		if (!ENV_KEY_PATTERN.test(key)) continue;
		values.set(key, trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2"));
	}
	return values;
}

/** Replaces (or removes, with `undefined`) one key, leaving every other line byte-for-byte alone. */
export function setUpEnvFile(content: string, key: string, value: string | undefined): string {
	const lines = content.replace(/\n+$/, "").split("\n");
	const kept: string[] = [];
	let replaced = false;
	for (const line of lines) {
		const trimmed = line.trim();
		const name = trimmed.startsWith("#") ? "" : trimmed.split("=")[0]?.trim() ?? "";
		if (name !== key) {
			if (line.length > 0 || kept.length > 0) kept.push(line);
			continue;
		}
		if (!replaced && value !== undefined) {
			kept.push(`${key}=${value}`);
			replaced = true;
		}
	}
	if (!replaced && value !== undefined) kept.push(`${key}=${value}`);
	return `${kept.join("\n")}\n`;
}

export function agentEnvPath(env: Record<string, string | undefined>): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	if (override) return join(override, ".env");
	return join(env.HOME?.trim() || homedir(), env.PI_CONFIG_DIR?.trim() || ".omp", "agent", ".env");
}

function readEnvFile(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Writes through a temp file so a crashed write cannot truncate the operator's credential file. */
export function writeEnvFile(path: string, key: string, value: string | undefined): void {
	mkdirSync(dirname(path), { recursive: true });
	const updated = setUpEnvFile(readEnvFile(path), key, value);
	const staging = `${path}.tmp`;
	writeFileSync(staging, updated, { mode: ENV_MODE });
	chmodSync(staging, ENV_MODE);
	renameSync(staging, path);
}

function effectiveSwitch(env: Record<string, string | undefined>): string {
	const raw = env[SWITCH_KEY]?.trim();
	if (raw === undefined || raw.length === 0) return "unset";
	return raw === "1" ? "1 (on)" : `${raw} (not 1, so off)`;
}

async function isTrackedElsewhere(ctx: SetupContext, path: string): Promise<string | null> {
	const worktree = await ctx.exec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (worktree.code !== 0) return null;
	const ignored = await ctx.exec("git", ["check-ignore", "--quiet", relative(ctx.cwd, path) || ".env"]);
	if (ignored.code === 0) return null;
	return (
		`refusing to write ${path}: it is inside a git worktree and not ignored, so the switch could be committed. ` +
		`Run \`git check-ignore -q .env\` yourself, or add ".env" to .gitignore first.`
	);
}

async function status(ctx: SetupContext): Promise<SetupReport> {
	const projectEnv = join(ctx.cwd, ".env");
	const agentEnv = agentEnvPath(ctx.env);
	const projectSwitch = parseEnvFile(readEnvFile(projectEnv)).get(SWITCH_KEY);
	const agentSwitch = parseEnvFile(readEnvFile(agentEnv)).get(SWITCH_KEY);
	const agentCredential = parseEnvFile(readEnvFile(agentEnv)).get(CREDENTIAL_KEY);
	const sessionCredential = ctx.env[CREDENTIAL_KEY]?.trim();
	const lines = [
		`${SWITCH_KEY} in this session: ${effectiveSwitch(ctx.env)}`,
		`project env file: ${projectEnv} -> ${projectSwitch ?? "no switch set"}`,
		`agent env file:   ${agentEnv} -> ${agentSwitch ?? "no switch set"}`,
		`credential: ${sessionCredential ? "present in the session environment" : agentCredential ? "present in the agent env file" : "missing"}`,
	];
	if (ctx.toolActive !== undefined) lines.push(`tool active in this session: ${ctx.toolActive ? "yes" : "no"}`);
	lines.push(
		"enable: /setup-jev enable (this checkout, applies when omp starts here) or `enable --global` (every directory)",
		"credential: export OPENROUTER_API_KEY=... then /setup-jev key, or /setup-jev key with it already exported",
	);
	return { level: sessionCredential || agentCredential ? "info" : "warn", lines };
}

async function enable(ctx: SetupContext, global: boolean): Promise<SetupReport> {
	const path = global ? agentEnvPath(ctx.env) : join(ctx.cwd, ".env");
	if (!global) {
		const blocked = await isTrackedElsewhere(ctx, path);
		if (blocked) return { level: "error", lines: [blocked] };
	}
	writeEnvFile(path, SWITCH_KEY, "1");
	const lines = [`enabled: ${SWITCH_KEY}=1 written to ${path}`];
	if (global) lines.push("applies to every omp session started with this agent directory.");
	else {
		lines.push(
			"applies only when omp starts in that directory: a .env in a parent directory is ignored (measured), " +
				"so launching from a subdirectory needs `enable --global`.",
		);
	}
	lines.push("the environment still wins: JEV_DECISION_MAKER=0 in a session keeps the tool off.");
	return { level: "info", lines };
}

async function disable(ctx: SetupContext, global: boolean): Promise<SetupReport> {
	const path = global ? agentEnvPath(ctx.env) : join(ctx.cwd, ".env");
	if (!existsSync(path)) return { level: "info", lines: [`nothing to disable: ${path} does not exist`] };
	writeEnvFile(path, SWITCH_KEY, undefined);
	return { level: "info", lines: [`disabled: ${SWITCH_KEY} removed from ${path}`] };
}

function storeCredential(ctx: SetupContext): SetupReport {
	const value = ctx.env[CREDENTIAL_KEY]?.trim();
	if (!value) {
		return {
			level: "error",
			lines: [
				`no ${CREDENTIAL_KEY} in this session's environment, and this command never prompts for one:`,
				"omp's extension UI has no masked input, so a typed key would land in the transcript.",
				`Run \`export ${CREDENTIAL_KEY}=<key>\` in your own shell, then start omp and run /setup-jev key again -`,
				`or append it yourself: printf '%s\\n' "${CREDENTIAL_KEY}=<key>" >> ${agentEnvPath(ctx.env)}`,
			],
		};
	}
	const path = agentEnvPath(ctx.env);
	writeEnvFile(path, CREDENTIAL_KEY, value);
	return {
		level: "info",
		lines: [
			`credential stored in ${path} (mode 600, value never printed or logged).`,
			"the environment still wins if you export it later.",
		],
	};
}

/** Runs one `/setup-jev` invocation. Never reads the UI, never calls the network. */
export async function runSetupCommand(args: string, ctx: SetupContext): Promise<SetupReport> {
	const [subcommand = "", ...flags] = args.trim().split(/\s+/).filter((part) => part.length > 0);
	const global = flags.includes("--global");
	switch (subcommand) {
		case "":
			return await status(ctx);
		case "enable":
			return await enable(ctx, global);
		case "disable":
			return await disable(ctx, global);
		case "key":
			return storeCredential(ctx);
		default:
			return {
				level: "error",
				lines: [`unknown /setup-jev argument: ${subcommand}`, "usage: /setup-jev [enable|disable|key] [--global]"],
			};
	}
}
