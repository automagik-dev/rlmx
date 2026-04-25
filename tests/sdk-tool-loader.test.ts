import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	type AgentSpec,
	createToolRegistry,
	InvalidPluginError,
	loadPluginTools,
	MissingPluginError,
} from "../src/sdk/index.js";

async function writePlugin(
	dir: string,
	name: string,
	body: string,
	ext = ".mjs",
): Promise<string> {
	const toolsDir = join(dir, "tools");
	await mkdir(toolsDir, { recursive: true });
	const file = join(toolsDir, `${name}${ext}`);
	await writeFile(file, body, "utf8");
	return file;
}

function specFor(dir: string, tools: string[]): AgentSpec {
	return {
		dir,
		schemaVersion: 1,
		toolsApi: 1,
		shape: "single-step",
		tools,
		extras: {},
	} as AgentSpec;
}

describe("loadPluginTools — TS plugin loader (G3a, .mjs/.js only)", () => {
	let root = "";
	before(async () => {
		root = await mkdtemp(join(tmpdir(), "plugin-loader-"));
	});
	after(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("loads a plugin's default export into the registry", async () => {
		const agentDir = join(root, "load-default");
		await writePlugin(
			agentDir,
			"greet",
			`export default async (args) => "hello " + args.name;\n`,
		);
		const registry = createToolRegistry();
		const result = await loadPluginTools(specFor(agentDir, ["greet"]), registry);
		assert.deepEqual([...result.loaded], ["greet"]);
		assert.equal(result.missing.length, 0);
		const handler = registry.get("greet");
		assert.ok(handler);
		const out = await handler!({ name: "sté" }, {
			tool: "greet",
			sessionId: "s",
			iteration: 1,
			signal: new AbortController().signal,
		});
		assert.equal(out, "hello sté");
	});

	it("skips tools already present in the registry (pre-registered wins)", async () => {
		const agentDir = join(root, "skip");
		await writePlugin(agentDir, "rtk", `export default async () => "file";\n`);
		const registry = createToolRegistry();
		registry.register("rtk", async () => "pre-registered");
		const result = await loadPluginTools(specFor(agentDir, ["rtk"]), registry);
		assert.deepEqual([...result.skipped], ["rtk"]);
		assert.deepEqual([...result.loaded], []);
		assert.equal(await registry.get("rtk")!({}, {
			tool: "rtk",
			sessionId: "",
			iteration: 0,
			signal: new AbortController().signal,
		}), "pre-registered");
	});

	it("tracks missing plugins on the result when non-strict (default)", async () => {
		const agentDir = join(root, "missing");
		await mkdir(join(agentDir, "tools"), { recursive: true });
		const registry = createToolRegistry();
		const result = await loadPluginTools(
			specFor(agentDir, ["no_such_tool"]),
			registry,
		);
		assert.deepEqual([...result.missing], ["no_such_tool"]);
		assert.equal(result.loaded.length, 0);
	});

	it("throws MissingPluginError in strict mode", async () => {
		const agentDir = join(root, "missing-strict");
		await mkdir(join(agentDir, "tools"), { recursive: true });
		const registry = createToolRegistry();
		await assert.rejects(
			loadPluginTools(specFor(agentDir, ["nope"]), registry, { strict: true }),
			(err: unknown) => {
				assert.ok(err instanceof MissingPluginError);
				assert.equal((err as MissingPluginError).toolName, "nope");
				return true;
			},
		);
	});

	it("throws InvalidPluginError when the default export is not a function", async () => {
		const agentDir = join(root, "invalid");
		await writePlugin(
			agentDir,
			"bad",
			`export default "not a function";\n`,
		);
		const registry = createToolRegistry();
		await assert.rejects(
			loadPluginTools(specFor(agentDir, ["bad"]), registry),
			(err: unknown) => {
				assert.ok(err instanceof InvalidPluginError);
				assert.equal((err as InvalidPluginError).toolName, "bad");
				return true;
			},
		);
	});

	it("prefers .mjs over .js when both are present", async () => {
		const agentDir = join(root, "ext-priority");
		await writePlugin(
			agentDir,
			"both",
			`export default async () => "mjs";\n`,
			".mjs",
		);
		// .js file with deliberately different output
		await writePlugin(
			agentDir,
			"both",
			`export default async () => "js";\n`,
			".js",
		);
		const registry = createToolRegistry();
		await loadPluginTools(specFor(agentDir, ["both"]), registry);
		const result = await registry.get("both")!({}, {
			tool: "both",
			sessionId: "",
			iteration: 0,
			signal: new AbortController().signal,
		});
		assert.equal(result, "mjs");
	});

	it("falls back to .js when .mjs missing", async () => {
		const agentDir = join(root, "js-fallback");
		await writePlugin(
			agentDir,
			"fallback",
			`export default async () => "js-only";\n`,
			".js",
		);
		const registry = createToolRegistry();
		await loadPluginTools(specFor(agentDir, ["fallback"]), registry);
		const result = await registry.get("fallback")!({}, {
			tool: "fallback",
			sessionId: "",
			iteration: 0,
			signal: new AbortController().signal,
		});
		assert.equal(result, "js-only");
	});

	it("loads multiple tools in declaration order + reports a breakdown", async () => {
		const agentDir = join(root, "multi");
		await writePlugin(agentDir, "a", `export default async () => "A";\n`);
		await writePlugin(agentDir, "b", `export default async () => "B";\n`);
		await writePlugin(agentDir, "c", `export default async () => "C";\n`);
		const registry = createToolRegistry();
		registry.register("b", async () => "pre-b"); // one pre-registered
		const result = await loadPluginTools(
			specFor(agentDir, ["a", "b", "c", "d"]),
			registry,
		);
		assert.deepEqual([...result.loaded], ["a", "c"]);
		assert.deepEqual([...result.skipped], ["b"]);
		assert.deepEqual([...result.missing], ["d"]);
	});
});
