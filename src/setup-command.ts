/**
 * `/setup-jev` - the enable path for the decision maker.
 *
 * Measured behaviour this leans on (omp 18.2.6, isolated HOME, RPC get_state only, no inference):
 *   - a launch-directory `.env` is read from the launch directory exactly, never from ancestors, so a
 *     project switch only applies when omp starts in that directory;
 *   - `~/.omp/agent/.env` is read regardless of the working directory, so it works as an explicit
 *     machine-wide switch;
 *   - the process environment beats both, which is what keeps `JEV_DECISION_MAKER=0` authoritative.
 *
 * The command owns activation only. The credential belongs to omp: `status` asks the caller for
 * credential presence and never reads, writes or prints a key itself.
 *
 * A local switch lives inside the operator's worktree, so `enable` proves Git cannot commit it before
 * writing: a tracked target is refused, an unignored one gets exactly one root-relative ignore rule.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export const SETUP_COMMAND = "setup-jev";
export const SWITCH_KEY = "JEV_DECISION_MAKER";
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
	/**
	 * Whether omp can resolve an OpenRouter credential for this session. The command never resolves or
	 * stores a key itself, so a caller that cannot probe omits this and the report stays silent about it.
	 */
	credentialPresent?: () => Promise<boolean>;
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

/** Writes through a temp file so a crashed write cannot truncate the target file. */
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

/**
 * Makes the launch-directory switch uncommittable without mutating anything on a refusal.
 *
 * Every Git call after the root probe runs with `-C <root>`: `pi.exec` starts Git in the launch
 * directory, and the pathspecs here are worktree-root-relative, so omitting the flag would test the
 * wrong path whenever omp starts in a subdirectory. Returns a report line on refusal, `null` to write.
 */
async function prepareProjectEnvFile(ctx: SetupContext, path: string): Promise<string | null> {
	const worktree = await ctx.exec("git", ["rev-parse", "--show-toplevel"]);
	// Not a worktree: there is nothing Git could commit, so the switch is safe to write.
	if (worktree.code !== 0) return null;
	// `git rev-parse --show-toplevel` prints the resolved path, while `ctx.cwd` may hold a symlinked
	// one (`/tmp` on macOS), so both sides are canonicalized before the pathspec is derived.
	const root = realpathSync(worktree.stdout.trim());
	const dir = relative(root, realpathSync(ctx.cwd)).replaceAll("\\", "/");
	if (dir.startsWith("..")) return `refusing to write ${path}: it is outside the git worktree.`;
	/** Root-relative, so every Git call below must run with `-C root`. */
	const target = dir.length === 0 ? ".env" : `${dir}/.env`;
	const at = ["-C", root];
	const tracked = await ctx.exec("git", [...at, "ls-files", "--error-unmatch", "--", target]);
	if (tracked.code === 0) {
		return (
			`refusing to write ${path}: git already tracks it, so the switch could be committed. ` +
			`Remove it from the index (\`git rm --cached ${target}\`) first, or use \`enable --global\`.`
		);
	}
	if (tracked.code !== 1) return `refusing to write ${path}: git could not tell whether it is tracked.`;

	const ignored = await ctx.exec("git", [...at, "check-ignore", "--quiet", "--", target]);
	if (ignored.code === 0) return null;
	if (ignored.code !== 1) return `refusing to write ${path}: git could not tell whether it is ignored.`;

	const pattern = `/${target}`;
	const ignorePath = join(root, ".gitignore");
	const current = readEnvFile(ignorePath);
	if (!current.split("\n").some((line) => line.trim() === pattern)) {
		writeFileSync(ignorePath, `${current.replace(/\n*$/, "\n")}${pattern}\n`);
	}
	const verified = await ctx.exec("git", [...at, "check-ignore", "--quiet", "--", target]);
	if (verified.code === 0) return null;
	return verified.code === 1
		? `refusing to write ${path}: git still does not ignore it after adding "${pattern}" to ${ignorePath}.`
		: `refusing to write ${path}: git could not verify the ignore rule in ${ignorePath}.`;
}

async function status(ctx: SetupContext): Promise<SetupReport> {
	const projectEnv = join(ctx.cwd, ".env");
	const agentEnv = agentEnvPath(ctx.env);
	const projectSwitch = parseEnvFile(readEnvFile(projectEnv)).get(SWITCH_KEY);
	const agentSwitch = parseEnvFile(readEnvFile(agentEnv)).get(SWITCH_KEY);
	const present = ctx.credentialPresent === undefined ? undefined : await ctx.credentialPresent();
	const lines = [
		`${SWITCH_KEY} in this session: ${effectiveSwitch(ctx.env)}`,
		`project env file: ${projectEnv} -> ${projectSwitch ?? "no switch set"}`,
		`agent env file:   ${agentEnv} -> ${agentSwitch ?? "no switch set"}`,
	];
	if (present !== undefined) lines.push(`credential: ${present ? "omp can resolve an OpenRouter key" : "missing"}`);
	if (ctx.toolActive !== undefined) lines.push(`tool active in this session: ${ctx.toolActive ? "yes" : "no"}`);
	lines.push(
		"enable: /setup-jev enable (this checkout, applies when omp starts here) or `enable --global` (every directory)",
		"credential: configure an OpenRouter key for omp itself, then re-run /setup-jev",
	);
	return { level: present === false ? "warn" : "info", lines };
}

async function enable(ctx: SetupContext, global: boolean): Promise<SetupReport> {
	const path = global ? agentEnvPath(ctx.env) : join(ctx.cwd, ".env");
	if (!global) {
		const blocked = await prepareProjectEnvFile(ctx, path);
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
	// The ignore rule stays: it is the operator's file, and another tool may rely on it.
	return { level: "info", lines: [`disabled: ${SWITCH_KEY} removed from ${path}`] };
}

/** Runs one `/setup-jev` invocation. Never reads the UI, never resolves a credential, never calls the network. */
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
		default:
			return {
				level: "error",
				lines: [`unknown /setup-jev argument: ${subcommand}`, "usage: /setup-jev [enable|disable] [--global]"],
			};
	}
}
