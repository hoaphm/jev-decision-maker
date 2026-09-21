/**
 * Install-path proof for the JEV decision-maker omp plugin.
 *
 * Runnable directly: `bun tests/plugin-install.test.ts`
 *
 * Scope: this file must never start an agent turn. The only omp processes it launches are
 * `plugin link`/`plugin uninstall` (state only) and an RPC session polled with `get_state` (tool
 * registry, no prompt) before being killed. Every user-level path resolves into a throwaway HOME,
 * and both candidate real state roots are fingerprinted before and after to prove nothing leaked.
 * omp only honours an XDG root that already exists - verified: with `$XDG_DATA_HOME/omp` present,
 * plugin state lands there rather than in `$HOME/.omp/plugins`, so the temp XDG roots are created
 * up front and the install location is matched against both candidates.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const HOME = mkdtempSync(join(tmpdir(), "jev-plugin-home-"));
const REAL_STATE_ROOTS = [
	join(process.env.HOME ?? "", ".omp", "plugins"),
	join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share"), "omp", "plugins"),
];
const MANIFEST_PATH = join(REPO, "package.json");
const RPC_DEADLINE_MS = 90_000;
const STATUS_GRACE_MS = 1_000;

// omp only honours an XDG root that already exists, so pre-create the temp ones: on a machine whose
// real XDG layout exists, plugin state must still resolve inside this throwaway HOME.
for (const leaf of ["xdg-data", "xdg-state", "xdg-cache"]) mkdirSync(join(HOME, leaf, "omp"), { recursive: true });
const PROJECT = join(HOME, "project");
mkdirSync(PROJECT, { recursive: true });
/** Every place omp could place user plugin state for this isolated HOME. */
const CANDIDATE_STATE_ROOTS = [join(HOME, ".omp", "plugins"), join(HOME, "xdg-data", "omp", "plugins")];

type PackageManifest = {
	name: string;
	private?: boolean;
	type?: string;
	omp?: { extensions?: string[] };
};

function fingerprint(dir: string): string {
	if (!existsSync(dir)) return "absent";
	return readdirSync(dir)
		.sort()
		.map((name) => `${name}:${statSync(join(dir, name)).mtimeMs}`)
		.join(" ");
}

function isolatedEnv(options: { jevDecisionMaker?: string; openRouterKey?: string } = {}): Record<string, string> {
	// A whitelist, not the ambient environment: no real credential can reach the child. The
	// placeholder model key only exists to get session startup past the "no models" gate, and the
	// placeholder OpenRouter key only exercises the readiness label through omp's own credential
	// lookup - no prompt is ever sent, so nothing can call a provider.
	const env: Record<string, string> = {
		HOME,
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
		XDG_DATA_HOME: join(HOME, "xdg-data"),
		XDG_STATE_HOME: join(HOME, "xdg-state"),
		XDG_CACHE_HOME: join(HOME, "xdg-cache"),
		ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
	};
	if (options.jevDecisionMaker !== undefined) env.JEV_DECISION_MAKER = options.jevDecisionMaker;
	if (options.openRouterKey !== undefined) env.OPENROUTER_API_KEY = options.openRouterKey;
	return env;
}

/** Runs one omp command inside the isolated HOME. */
async function capture(argv: string[], options: { jevDecisionMaker?: string; openRouterKey?: string } = {}) {
	const proc = Bun.spawn(argv, {
		cwd: HOME,
		env: isolatedEnv(options),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

type SessionProbe = { tools: string[]; statuses: Array<[string, string | undefined]>; commands: string[] };

/**
 * Starts a headless RPC session, asks for the tool registry and records the extension's status
 * writes, then kills the session without ever sending a prompt. RPC serialises ctx.ui.setStatus as
 * an `extension_ui_request` frame, which is how the status line is observable with no terminal.
 */
async function probeSession(options: { jevDecisionMaker?: string; openRouterKey?: string } = {}): Promise<SessionProbe> {
	const proc = Bun.spawn(
		[
			"omp",
			"--mode",
			"rpc",
			"--no-session",
			"--no-title",
			"--no-skills",
			"--no-rules",
			"--model",
			"anthropic/claude-sonnet-4-5",
		],
		{
			cwd: HOME,
			env: isolatedEnv(options),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.write('{"id":"probe-1","type":"get_state"}\n');

	// Pump both streams so the child can never block on a full pipe; the loop below only inspects
	// what has already arrived, so a missing status frame cannot wedge the probe.
	let out = "";
	let err = "";
	const pump = async (stream: ReadableStream, sink: (chunk: string) => void) => {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			sink(decoder.decode(value, { stream: true }));
		}
	};
	const pumping = Promise.all([
		pump(proc.stdout, (chunk) => { out += chunk; }),
		pump(proc.stderr, (chunk) => { err += chunk; }),
	]);

	const statuses: Array<[string, string | undefined]> = [];
	const commands = new Set<string>();
	let state: Record<string, any> | undefined;
	let consumed = 0;
	let respondedAt = 0;
	const takeFrames = () => {
		const pending = out.slice(consumed);
		const lines = pending.split("\n");
		consumed += pending.length - (lines.pop() ?? "").length;
		for (const line of lines) {
			if (!line.trim().startsWith("{")) continue;
			let frame: Record<string, any>;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame.type === "response" && frame.command === "get_state" && frame.success === true) state = frame;
			if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
				for (const command of frame.commands) commands.add(String(command.name));
			}
			if (frame.type === "extension_ui_request" && frame.method === "setStatus") {
				statuses.push([String(frame.statusKey), frame.statusText === undefined ? undefined : String(frame.statusText)]);
			}
		}
	};

	const deadline = performance.now() + RPC_DEADLINE_MS;
	while (performance.now() < deadline) {
		takeFrames();
		if (state && respondedAt === 0) respondedAt = performance.now();
		// A status frame can trail the response; give it one second, then stop.
		if (state && (statuses.length > 0 || performance.now() - respondedAt > STATUS_GRACE_MS)) break;
		await Bun.sleep(100);
	}
	takeFrames();
	proc.kill("SIGKILL");
	await proc.exited;
	await pumping;
	assert.ok(state, `get_state never answered; stderr: ${err.slice(0, 500)}`);
	const dump = state?.data?.dumpTools;
	assert.ok(Array.isArray(dump), "get_state returned no dumpTools");
	return { tools: dump.map((tool: { name: string }) => tool.name), statuses, commands: [...commands].sort() };
}

type CommandRun = { notifies: string[]; agentStarted: boolean; invocations: number };

/**
 * Sends slash commands to a real RPC session and records the notifications the extension emits.
 * A local-only command answers with data.agentInvoked === false, so any agent_start frame here would
 * mean the probe accidentally started a model turn.
 */
async function driveCommands(cwd: string, commands: string[], openRouterKey?: string): Promise<CommandRun> {
	const env = isolatedEnv({ jevDecisionMaker: "1", openRouterKey });
	const proc = Bun.spawn(
		["omp", "--mode", "rpc", "--no-session", "--no-title", "--no-skills", "--no-rules", "--model", "anthropic/claude-sonnet-4-5"],
		{ cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const notifies: string[] = [];
	let agentStarted = false;
	let invocations = 0;
	let out = "";
	let consumed = 0;
	const scan = () => {
		const pending = out.slice(consumed);
		const lines = pending.split("\n");
		consumed += pending.length - (lines.pop() ?? "").length;
		for (const line of lines) {
			if (!line.trim().startsWith("{")) continue;
			let frame: Record<string, any>;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame.type === "agent_start") agentStarted = true;
			if (frame.type === "extension_ui_request" && frame.method === "notify") notifies.push(String(frame.message ?? ""));
			if (frame.type === "response" && frame.command === "prompt" && frame.success === true) {
				invocations += 1;
				if (frame.data?.agentInvoked === false) continue;
			}
		}
	};
	const pumping = (async () => {
		const decoder = new TextDecoder();
		const reader = proc.stdout.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			out += decoder.decode(value, { stream: true });
		}
	})();

	const deadline = performance.now() + 60_000;
	for (const [index, command] of commands.entries()) {
		proc.stdin.write(JSON.stringify({ id: `cmd-${index}`, type: "prompt", message: command }) + "\n");
		const want = index + 1;
		while (invocations < want && performance.now() < deadline) {
			scan();
			await Bun.sleep(100);
		}
		// give the notification frames a moment to trail the acknowledgement
		const settle = performance.now() + 1_500;
		while (performance.now() < settle) {
			scan();
			await Bun.sleep(100);
		}
		scan();
	}
	proc.kill("SIGKILL");
	await proc.exited;
	await pumping;
	return { notifies, agentStarted, invocations };
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
	const realBefore = REAL_STATE_ROOTS.map((root) => fingerprint(root)).join(" || ");
	try {
		await test("the package manifest is a valid omp extension package", () => {
			assert.ok(existsSync(MANIFEST_PATH), "package.json is missing at the repository root");
			const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as PackageManifest;
			assert.equal(manifest.name, "jev-decision-maker");
			assert.equal(manifest.private, true);
			assert.equal(manifest.type, "module");
			assert.deepEqual(manifest.omp?.extensions, ["./src/decision-maker.ts"]);
			for (const entry of manifest.omp?.extensions ?? []) {
				assert.ok(existsSync(join(REPO, entry)), `declared extension entry is missing: ${entry}`);
			}
			assert.ok(existsSync(join(REPO, "rules", "decision-maker.md")), "the runtime policy rule is missing");
		});

		await test("the extension left project-native discovery", () => {
			assert.equal(existsSync(join(REPO, ".omp", "extensions", "decision-maker.ts")), false);
		});

		await test("omp plugin link installs the package inside the isolated HOME only", async () => {
			const linked = await capture(["omp", "plugin", "link", REPO, "--json"]);
			assert.equal(linked.code, 0, `link failed: ${linked.stderr.slice(0, 500)}`);
			const reported = JSON.parse(linked.stdout) as { name?: string; package?: string; path?: string };
			assert.equal(reported.name ?? reported.package, "jev-decision-maker");

			const installed = CANDIDATE_STATE_ROOTS.map((root) => join(root, "node_modules", "jev-decision-maker")).filter((link) =>
				existsSync(link),
			);
			assert.equal(installed.length, 1, `expected exactly one install root, found ${installed.length}`);
			assert.equal(lstatSync(installed[0]).isSymbolicLink(), true);
			const lockfile = JSON.parse(readFileSync(join(dirname(installed[0]), "..", "omp-plugins.lock.json"), "utf8")) as {
				plugins?: Record<string, unknown>;
			};
			assert.ok(lockfile.plugins?.["jev-decision-maker"], "the runtime lock does not list the plugin");
		});

		await test("the installed plugin exposes the tool only when opted in", async () => {
			const optedIn = await probeSession({ jevDecisionMaker: "1", openRouterKey: "sk-or-placeholder" });
			assert.ok(optedIn.tools.includes("decision_maker"), `missing tool; got ${optedIn.tools.slice(0, 40).join(",")}`);
			const optedOut = await probeSession();
			assert.equal(optedOut.tools.includes("decision_maker"), false);
		});

		await test("the setup command is discoverable and runs locally", async () => {
			try {
				const discovered = await probeSession();
				assert.ok(
					discovered.commands.includes("setup-jev"),
					`setup-jev is not registered; got ${discovered.commands.slice(0, 20).join(",")}`,
				);

				const status = await driveCommands(PROJECT, ["/setup-jev"]);
				assert.equal(status.agentStarted, false, "the probe started an agent turn");
				assert.equal(status.invocations, 1, "the command was not acknowledged");
				assert.ok(
					status.notifies.some((line) => line.includes("JEV_DECISION_MAKER")),
					`the status output did not name the switch: ${JSON.stringify(status.notifies)}`,
				);

				const enabled = await driveCommands(PROJECT, ["/setup-jev enable", "/setup-jev disable"]);
				assert.equal(enabled.agentStarted, false, "the probe started an agent turn");
				const projectEnv = join(PROJECT, ".env");
				assert.ok(existsSync(projectEnv), "enable did not write a project .env");
				assert.equal(
					readFileSync(projectEnv, "utf8").includes("JEV_DECISION_MAKER=1"),
					false,
					"disable left the switch behind",
				);

				// The command owns no credential: the removed subcommand is rejected and writes nothing.
				const keyed = await driveCommands(PROJECT, ["/setup-jev key"], "sk-or-v1-plugin-test-placeholder");
				assert.equal(keyed.agentStarted, false, "the probe started an agent turn");
				assert.ok(
					keyed.notifies.some((line) => line.includes("unknown")),
					`/setup-jev key was still accepted: ${JSON.stringify(keyed.notifies)}`,
				);
				assert.equal(existsSync(join(HOME, ".omp", "agent", ".env")), false, "the command wrote an agent env file");

				const global = await driveCommands(PROJECT, ["/setup-jev enable --global", "/setup-jev disable --global"]);
				assert.equal(global.agentStarted, false, "the probe started an agent turn");
				const agentEnv = join(HOME, ".omp", "agent", ".env");
				assert.ok(existsSync(agentEnv), "--global did not write the agent env file");
				const agentText = readFileSync(agentEnv, "utf8");
				assert.equal(agentText.includes("JEV_DECISION_MAKER=1"), false, "disable --global left the switch behind");
				assert.equal(agentText.includes("OPENROUTER_API_KEY"), false, "the agent env file must not hold a credential");
			} finally {
				// The command writes real dotenv files (that is the feature); later checks must not inherit them.
				for (const path of [join(PROJECT, ".env"), join(HOME, ".omp", "agent", ".env")]) {
					if (existsSync(path)) unlinkSync(path);
				}
			}
		});

		await test("the README documents install, activation and the labels", () => {
			const readme = readFileSync(join(REPO, "README.md"), "utf8");
			for (const fact of [
				"omp plugin link",
				"omp plugin install",
				"setup-jev",
				"JEV_DECISION_MAKER",
				"enable --global",
				"◆ JEV on",
				"JEV no key",
				"JEV inactive",
			]) {
				assert.ok(readme.includes(fact), `README does not document ${fact}`);
			}
			assert.equal(readme.includes("/setup-jev key"), false, "the README still offers the removed key subcommand");
		});

		await test("the installed plugin writes a readiness status line", async () => {
			const cases: Array<{ name: string; options: { jevDecisionMaker?: string; openRouterKey?: string }; label: string }> = [
				{ name: "off", options: {}, label: "JEV off" },
				{ name: "no key", options: { jevDecisionMaker: "1" }, label: "JEV no key" },
				{ name: "ready", options: { jevDecisionMaker: "1", openRouterKey: "sk-or-placeholder" }, label: "JEV on" },
			];
			for (const testCase of cases) {
				const probe = await probeSession(testCase.options);
				const ours = probe.statuses.filter(([key]) => key === "jev");
				assert.ok(ours.length > 0, `${testCase.name}: no status frame; saw ${JSON.stringify(probe.statuses)}`);
				for (const [, text] of ours) {
					assert.ok(text?.endsWith(testCase.label), `${testCase.name}: "${text}" should end with "${testCase.label}"`);
				}
			}
		});

		await test("omp plugin uninstall removes the installed plugin", async () => {
			const removed = await capture(["omp", "plugin", "uninstall", "jev-decision-maker", "--json"]);
			assert.equal(removed.code, 0, `uninstall failed: ${removed.stderr.slice(0, 500) || removed.stdout.slice(0, 500)}`);
			const after = await probeSession({ jevDecisionMaker: "1" });
			assert.equal(after.tools.includes("decision_maker"), false, "the tool is still registered after uninstall");
			assert.equal(after.statuses.length, 0, `the uninstalled plugin still writes status: ${JSON.stringify(after.statuses)}`);
		});
	} finally {
		for (const root of CANDIDATE_STATE_ROOTS) {
			const link = join(root, "node_modules", "jev-decision-maker");
			if (existsSync(link)) unlinkSync(link);
		}
		rmSync(HOME, { recursive: true, force: true });
	}

	await test("the real plugin state was not touched", () => {
		const changed = REAL_STATE_ROOTS.filter((root, index) => fingerprint(root) !== realBefore.split(" || ")[index]);
		assert.deepEqual(changed, [], `omp wrote into real state: ${changed.join(", ")}`);
	});

	if (failures.length > 0) {
		console.error(`${failures.length} of ${ran} checks failed: ${failures.join(", ")}`);
		process.exit(1);
	}
	console.log(`all ${ran} checks passed`);
}

await main();
