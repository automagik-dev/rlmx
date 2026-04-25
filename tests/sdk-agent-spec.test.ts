import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadAgentSpec, parseAgentSpec } from "../src/sdk/index.js";

describe("parseAgentSpec — agent.yaml parser (G3a)", () => {
	const DIR = "/tmp/fake-agent";

	it("parses the minimal wish-A shape (triage example)", () => {
		const text = `
schema_version: 1
tools_api: 1
shape: single-step
model: gemini-3.1-flash-lite-preview
tools:
  - read
  - emit_done
scope:
  reads:
    - Conversas/*
budget:
  max_cost: 0.01
  max_iterations: 5
`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.dir, DIR);
		assert.equal(spec.schemaVersion, 1);
		assert.equal(spec.toolsApi, 1);
		assert.equal(spec.shape, "single-step");
		assert.equal(spec.model, "gemini-3.1-flash-lite-preview");
		assert.deepEqual([...spec.tools], ["read", "emit_done"]);
		assert.deepEqual([...(spec.scope?.reads ?? [])], ["Conversas/*"]);
		assert.equal(spec.budget?.maxCost, 0.01);
		assert.equal(spec.budget?.maxIterations, 5);
	});

	it("defaults schema_version / tools_api / shape when absent", () => {
		const text = `model: gemini-2.5-flash\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.schemaVersion, 1);
		assert.equal(spec.toolsApi, 1);
		assert.equal(spec.shape, "single-step");
	});

	it("rejects invalid shape", () => {
		const text = `shape: multi-step\n`;
		assert.throws(() => parseAgentSpec(text, DIR), /shape must be one of/);
	});

	it("rejects non-mapping YAML", () => {
		assert.throws(
			() => parseAgentSpec("just a string\n", DIR),
			/mapping at the top level/,
		);
		assert.throws(() => parseAgentSpec("- a\n- b\n", DIR), /mapping at the top level/);
	});

	it("ignores empty tool names in the list", () => {
		const text = `tools:\n  - ok\n  - ""\n  - also-ok\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.deepEqual([...spec.tools], ["ok", "also-ok"]);
	});

	it("preserves unrecognised keys in extras", () => {
		const text = `model: x\ncustom_flag: true\nnested:\n  a: 1\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.extras.custom_flag, true);
		assert.deepEqual(spec.extras.nested, { a: 1 });
	});

	it("handles camelCase + snake_case equivalently for schema fields", () => {
		const a = parseAgentSpec(
			"schema_version: 2\ntools_api: 3\n",
			DIR,
		);
		const b = parseAgentSpec(
			"schemaVersion: 2\ntoolsApi: 3\n",
			DIR,
		);
		assert.equal(a.schemaVersion, 2);
		assert.equal(a.toolsApi, 3);
		assert.equal(b.schemaVersion, 2);
		assert.equal(b.toolsApi, 3);
	});

	it("returns undefined scope/budget when the sections are empty", () => {
		const spec = parseAgentSpec("tools: []\n", DIR);
		assert.equal(spec.scope, undefined);
		assert.equal(spec.budget, undefined);
	});
});

describe("loadAgentSpec — filesystem wrapper (G3a)", () => {
	let dir = "";
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-spec-"));
	});
	after(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("reads agent.yaml from the given dir + resolves to absolute", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			"model: gemini-2.5-flash\ntools: [a, b]\n",
			"utf8",
		);
		const spec = await loadAgentSpec(dir);
		assert.equal(spec.dir, dir);
		assert.equal(spec.model, "gemini-2.5-flash");
		assert.deepEqual([...spec.tools], ["a", "b"]);
	});

	it("throws a useful error when agent.yaml is missing", async () => {
		const missing = join(dir, "no-such-sub");
		await assert.rejects(loadAgentSpec(missing));
	});
});
