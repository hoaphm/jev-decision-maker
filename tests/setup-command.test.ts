/**
 * `/setup-jev` behaviour: the enable switch, the git guard around a project switch, and the credential
 * presence report. Everything here runs against a temp directory - no omp, no network, no model, and
 * no credential is ever read, written or echoed by the command.
 *
 * The subdirectory case runs real `git` with the child's cwd set to the launch directory: a stub
 * cannot catch a pathspec that Git resolves against the wrong directory, which is the bug that made
 * a local enable report "does not ignore it after updating .gitignore" whenever omp started below
 * the worktree root.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, runSetupCommand, setUpEnvFile, writeEnvFile } from "../src/setup-command.ts";

const SECRET = "sk-or-v1-this-value-must-never-be-printed";

type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Stub `git` for a directory that is not a worktree: every probe answers "not a repository". */
const notARepository: Exec = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });

/** Real `git`, run with `cwd` as the child's working directory. */
function realGit(cwd: string): Exec {
	return async (file, args) => {
		if (file !== "git") return { code: 127, stdout: "", stderr: "not found" };
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	};
}

type RunOptions = {
	args?: string;
	cwd: string;
	home: string;
	env?: Record<string, string | undefined>;
	exec?: Exec;
	credentialPresent?: boolean;
};

function run(options: RunOptions) {
	const env: Record<string, string | undefined> = { HOME: options.home, ...(options.env ?? {}) };
	return runSetupCommand(options.args ?? "", {
		cwd: options.cwd,
		env,
		exec: options.exec ?? notARepository,
		...(options.credentialPresent === undefined ? {} : { credentialPresent: async () => options.credentialPresent === true }),
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
	});

	await test("writing an env file replaces a stale key and keeps other lines", () => {
		const root = tempRoot();
		try {
			const path = join(root, ".env");
			writeFileSync(path, "OTHER=1\nJEV_DECISION_MAKER=0\n");
			writeEnvFile(path, "JEV_DECISION_MAKER", "1");
			const written = readFileSync(path, "utf8");
			assert.ok(written.includes("OTHER=1"), "unrelated line was dropped");
			assert.equal(parseEnvFile(written).get("JEV_DECISION_MAKER"), "1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("status reports the switch, both env files and omp credential presence", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(join(root, ".omp", "agent"), { recursive: true });
			mkdirSync(cwd, { recursive: true });
			writeFileSync(join(cwd, ".env"), "JEV_DECISION_MAKER=1\n");

			const report = await run({ cwd, home: root, credentialPresent: false });
			// Switch on but no credential in omp: actionable, not an error, so the report warns.
			assert.equal(report.level, "warn");
			const text = report.lines.join("\n");
			assert.ok(text.includes("JEV_DECISION_MAKER"), "does not name the switch");
			assert.ok(text.includes(join(cwd, ".env")), "does not name the project env file");
			assert.ok(text.includes(join(root, ".omp", "agent", ".env")), "does not name the agent env file");
			assert.ok(/credential: missing/.test(text), `credential line wrong: ${text}`);

			const configured = await run({ cwd, home: root, credentialPresent: true });
			assert.equal(configured.level, "info");
			assert.ok(/credential: omp can resolve/.test(configured.lines.join("\n")), configured.lines.join("\n"));
			for (const line of [...report.lines, ...configured.lines]) {
				assert.equal(line.includes(SECRET), false, "the command must never carry a credential");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("local enable ignores the switch when omp starts in a subdirectory", async () => {
		const root = tempRoot();
		try {
			const project = join(root, "project");
			const cwd = join(project, "nested");
			mkdirSync(cwd, { recursive: true });
			const init = await realGit(project)("git", ["init", "--quiet", "."]);
			assert.equal(init.code, 0, `git init failed: ${init.stderr}`);
			const exec = realGit(cwd);

			const enabled = await run({ args: "enable", cwd, home: root, exec });
			assert.equal(enabled.level, "info", enabled.lines.join("\n"));
			assert.equal(parseEnvFile(readFileSync(join(cwd, ".env"), "utf8")).get("JEV_DECISION_MAKER"), "1");
			assert.equal(readFileSync(join(project, ".gitignore"), "utf8").trim(), "/nested/.env");

			const again = await run({ args: "enable", cwd, home: root, exec });
			assert.equal(again.level, "info", again.lines.join("\n"));
			assert.equal(
				readFileSync(join(project, ".gitignore"), "utf8").split("\n").filter((line) => line === "/nested/.env").length,
				1,
				"a second enable duplicated the ignore rule",
			);

			// A tracked switch could still be committed, so enable must refuse without mutating anything.
			const ignoreBefore = readFileSync(join(project, ".gitignore"), "utf8");
			const staged = await realGit(project)("git", ["add", "-f", "nested/.env"]);
			assert.equal(staged.code, 0, `git add failed: ${staged.stderr}`);
			assert.equal((await run({ args: "disable", cwd, home: root, exec })).level, "info");

			const refused = await run({ args: "enable", cwd, home: root, exec });
			assert.equal(refused.level, "error", refused.lines.join("\n"));
			assert.ok(refused.lines.join("\n").includes("tracks it"), refused.lines.join("\n"));
			assert.equal(readFileSync(join(project, ".gitignore"), "utf8"), ignoreBefore, "a refusal rewrote .gitignore");
			assert.equal(parseEnvFile(readFileSync(join(cwd, ".env"), "utf8")).has("JEV_DECISION_MAKER"), false, "wrote anyway");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await test("enable writes the switch, and --global writes it for every session", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			const local = await run({ args: "enable", cwd, home: root });
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

	await test("the command no longer owns a credential", async () => {
		const root = tempRoot();
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			const report = await run({ args: "key", cwd, home: root, env: { OPENROUTER_API_KEY: SECRET } });
			assert.equal(report.level, "error");
			assert.ok(report.lines.join("\n").includes("unknown"), report.lines.join("\n"));
			assert.equal(existsSync(join(root, ".omp", "agent", ".env")), false, "wrote an agent env file");
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
			await runSetupCommand("enable", { cwd, env: { HOME: root }, exec: notARepository });
			await runSetupCommand("", { cwd, env: { HOME: root }, exec: notARepository });
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
