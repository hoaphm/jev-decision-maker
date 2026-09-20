/**
 * `/setup-jev` behaviour: the enable switch, the credential hand-off, and the guards around writing
 * either of them. Everything here runs against a temp directory and a stub git - no omp, no network,
 * no model.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, runSetupCommand, setUpEnvFile, writeEnvFile } from "../src/setup-command.ts";

const SECRET = "sk-or-v1-this-value-must-never-be-printed";

type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Stub `git`: reports whether the cwd is a worktree and whether the path is ignored. */
function gitStub(options: { worktree: boolean; ignored?: boolean }): Exec {
	return async (file, args) => {
		if (file !== "git") return { code: 127, stdout: "", stderr: "not found" };
		if (args.includes("--is-inside-work-tree")) {
			return { code: options.worktree ? 0 : 128, stdout: `${options.worktree}`, stderr: "" };
		}
		if (args.includes("check-ignore")) {
			return { code: options.ignored ? 0 : 1, stdout: options.ignored ? ".env" : "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "unexpected git call" };
	};
}

type RunOptions = {
	args?: string;
	cwd: string;
	home: string;
	env?: Record<string, string | undefined>;
	git?: { worktree: boolean; ignored?: boolean };
};

function run(options: RunOptions) {
	const env: Record<string, string | undefined> = { HOME: options.home, ...(options.env ?? {}) };
	return runSetupCommand(options.args ?? "", {
		cwd: options.cwd,
		env,
		exec: gitStub(options.git ?? { worktree: false }),
	});
}

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "jev-setup-"));
}

const failures: string[] = [];
let ran = 0;

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
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
	await test("env files are merged, not clobbered", () => {
		const original = "# keep me\nOTHER=1\nJEV_DECISION_MAKER=0\n";
		assert.equal(parseEnvFile(original).get("OTHER"), "1");
		const enabled = setUpEnvFile(original, "JEV_DECISION_MAKER", "1");
		assert.equal(enabled.split("\n").filter((line) => line.startsWith("JEV_DECISION_MAKER=")).length, 1);
		assert.ok(enabled.includes("# keep me"));
		assert.ok(enabled.includes("OTHER=1"));
		const disabled = setUpEnvFile(enabled, "JEV_DECISION_MAKER", undefined);
		assert.ok(disabled.includes("OTHER=1"));
		assert.equal(parseEnvFile(disabled).has("JEV_DECISION_MAKER"), false);
		// A key that was never present is appended, and other keys are untouched.
		const keyed = setUpEnvFile(disabled, "OPENROUTER_API_KEY", SECRET);
		assert.equal(parseEnvFile(keyed).get("OPENROUTER_API_KEY"), SECRET);
		assert.ok(keyed.includes("OTHER=1"));
	});

	await test("writing an env file replaces a stale key and keeps other lines", () => {
		const root = tempRoot();
		try {
			const path = join(root, ".env");
			writeFileSync(path, "OTHER=1\nOPENROUTER_API_KEY=old\n");
			writeEnvFile(path, "OPENROUTER_API_KEY", SECRET);
			const written = readFileSync(path, "utf8");
			assert.ok(written.includes("OTHER=1"), "unrelated line was dropped");
			assert.equal(written.includes("old"), false, "stale value survived");
			assert.equal(parseEnvFile(written).get("OPENROUTER_API_KEY"), SECRET);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("status reports the effective switch, the files and the credential presence", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(join(root, ".omp", "agent"), { recursive: true });
			mkdirSync(cwd, { recursive: true });
			writeFileSync(join(cwd, ".env"), "JEV_DECISION_MAKER=1\n");

			const report = await run({ cwd, home: root });
			// Switch on but no credential anywhere: actionable, not an error, so the report warns.
			assert.equal(report.level, "warn");
			const text = report.lines.join("\n");
			assert.ok(text.includes("JEV_DECISION_MAKER"), "does not name the switch");
			assert.ok(text.includes(join(cwd, ".env")), "does not name the project env file");
			assert.ok(text.includes(join(root, ".omp", "agent", ".env")), "does not name the agent env file");
			assert.ok(/credential: missing/.test(text), `credential line wrong: ${text}`);

			const keyed = await run({ cwd, home: root, env: { OPENROUTER_API_KEY: SECRET } });
			const keyedText = keyed.lines.join("\n");
			assert.ok(/credential: present/.test(keyedText), `credential line wrong: ${keyedText}`);
			assert.equal(keyedText.includes(SECRET), false, "the status must never echo the credential");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("enable refuses to write an env file that git would track", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			const refused = await run({ args: "enable", cwd, home: root, git: { worktree: true, ignored: false } });
			assert.equal(refused.level, "error");
			const text = refused.lines.join("\n");
			assert.ok(text.includes("check-ignore"), `no gitignore guidance: ${text}`);
			assert.equal(existsSync(join(cwd, ".env")), false, "wrote anyway");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("enable writes the switch, and --global writes it for every session", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			const local = await run({ args: "enable", cwd, home: root, git: { worktree: true, ignored: true } });
			assert.equal(local.level, "info");
			assert.equal(parseEnvFile(readFileSync(join(cwd, ".env"), "utf8")).get("JEV_DECISION_MAKER"), "1");
			assert.ok(local.lines.join("\n").includes("subdirector"), "the cwd caveat is not stated");

			const global = await run({ args: "enable --global", cwd, home: root });
			assert.equal(global.level, "info");
			const agentEnv = join(root, ".omp", "agent", ".env");
			assert.equal(parseEnvFile(readFileSync(agentEnv, "utf8")).get("JEV_DECISION_MAKER"), "1");
			assert.equal(statSync(agentEnv).mode & 0o777, 0o600, "agent env file is not private");

			const disabled = await run({ args: "disable --global", cwd, home: root });
			assert.equal(disabled.level, "info");
			assert.equal(parseEnvFile(readFileSync(agentEnv, "utf8")).has("JEV_DECISION_MAKER"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("key refuses without a credential in the session environment", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			const refused = await run({ args: "key", cwd, home: root });
			assert.equal(refused.level, "error");
			const text = refused.lines.join("\n");
			assert.ok(text.includes("OPENROUTER_API_KEY"), "does not name the variable");
			assert.ok(text.includes("export"), `no shell guidance: ${text}`);
			assert.equal(existsSync(join(root, ".omp", "agent", ".env")), false, "wrote an empty credential");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("key stores an existing credential without echoing it", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			const stored = await run({ args: "key", cwd, home: root, env: { OPENROUTER_API_KEY: ` ${SECRET} ` } });
			assert.equal(stored.level, "info");
			const text = stored.lines.join("\n");
			assert.equal(text.includes(SECRET), false, "the command echoed the credential");
			const agentEnv = join(root, ".omp", "agent", ".env");
			assert.equal(parseEnvFile(readFileSync(agentEnv, "utf8")).get("OPENROUTER_API_KEY"), SECRET, "value not trimmed/stored");
			assert.equal(statSync(agentEnv).mode & 0o777, 0o600, "agent env file is not private");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("the command takes no UI input at all", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			// A context without any `ui` member: anything that tried to prompt would throw.
			await runSetupCommand("key", { cwd, env: { HOME: root }, exec: gitStub({ worktree: false }) });
			await runSetupCommand("", { cwd, env: { HOME: root }, exec: gitStub({ worktree: false }) });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	if (failures.length > 0) {
		console.error(`${failures.length} of ${ran} checks failed: ${failures.join(", ")}`);
		process.exit(1);
	}
	console.log(`all ${ran} checks passed`);
}

await main();
