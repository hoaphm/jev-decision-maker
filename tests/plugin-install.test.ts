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

// omp only honours an XDG root that already exists, so pre-create the temp ones: on a machine whose
// real XDG layout exists, plugin state must still resolve inside this throwaway HOME.
for (const leaf of ["xdg-data", "xdg-state", "xdg-cache"]) mkdirSync(join(HOME, leaf, "omp"), { recursive: true });
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

function isolatedEnv(jevDecisionMaker?: string): Record<string, string> {
	// A whitelist, not the ambient environment: no real credential can reach the child, and a
	// placeholder key only exists to get session startup past the "no models" gate. No prompt is
	// ever sent, so nothing can call a provider.
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
	if (jevDecisionMaker !== undefined) env.JEV_DECISION_MAKER = jevDecisionMaker;
	return env;
}

/** Runs one omp command inside the isolated HOME. */
async function capture(argv: string[], jevDecisionMaker?: string) {
	const proc = Bun.spawn(argv, {
		cwd: HOME,
		env: isolatedEnv(jevDecisionMaker),
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

/** Starts a headless RPC session, asks for the tool registry, and kills it before any turn. */
async function registeredToolNames(jevDecisionMaker?: string): Promise<string[]> {
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
			env: isolatedEnv(jevDecisionMaker),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.write('{"id":"probe-1","type":"get_state"}\n');

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let state: Record<string, any> | undefined;
	const deadline = performance.now() + RPC_DEADLINE_MS;
	while (!state && performance.now() < deadline) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim().startsWith("{")) continue;
			let frame: Record<string, any>;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame.type === "response" && frame.command === "get_state" && frame.success === true) state = frame;
		}
	}
	proc.kill("SIGKILL");
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	assert.ok(state, `get_state never answered; stderr: ${stderr.slice(0, 500)}`);
	const dump = state?.data?.dumpTools;
	assert.ok(Array.isArray(dump), "get_state returned no dumpTools");
	return dump.map((tool: { name: string }) => tool.name);
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
			const optedIn = await registeredToolNames("1");
			assert.ok(optedIn.includes("decision_maker"), `missing tool; got ${optedIn.slice(0, 40).join(",")}`);
			const optedOut = await registeredToolNames(undefined);
			assert.equal(optedOut.includes("decision_maker"), false);
		});

		await test("the README states both install paths and the two variables", () => {
			const readme = readFileSync(join(REPO, "README.md"), "utf8");
			for (const fact of ["omp plugin link", "omp plugin install", "JEV_DECISION_MAKER", "OPENROUTER_API_KEY"]) {
				assert.ok(readme.includes(fact), `README does not document ${fact}`);
			}
		});

		await test("omp plugin uninstall removes the installed plugin", async () => {
			const removed = await capture(["omp", "plugin", "uninstall", "jev-decision-maker", "--json"]);
			assert.equal(removed.code, 0, `uninstall failed: ${removed.stderr.slice(0, 500) || removed.stdout.slice(0, 500)}`);
			const after = await registeredToolNames("1");
			assert.equal(after.includes("decision_maker"), false, "the tool is still registered after uninstall");
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
