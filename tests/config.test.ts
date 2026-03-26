import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseToolsMd, parseModelMd } from "../src/config.js";

describe("YAML config loading", () => {
  let dir: string;

  it("loads valid rlmx.yaml with all fields", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await writeFile(
      join(dir, "rlmx.yaml"),
      `model:
  provider: openai
  model: gpt-4
  sub-call-model: gpt-3.5-turbo
system: "You are a helper."
criteria: "Be concise."
tools:
  greet: |
    def greet(name):
        return f"Hello {name}"
context:
  extensions: [.md, .txt]
  exclude: [node_modules, dist]
budget:
  max-cost: 1.5
  max-tokens: 50000
  max-depth: 3
tools-level: standard
`
    );
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "openai");
    assert.equal(cfg.model.model, "gpt-4");
    assert.equal(cfg.model.subCallModel, "gpt-3.5-turbo");
    assert.equal(cfg.system, "You are a helper.");
    assert.equal(cfg.criteria, "Be concise.");
    assert.equal(cfg.tools.length, 1);
    assert.equal(cfg.tools[0].name, "greet");
    assert.deepEqual(cfg.contextConfig.extensions, [".md", ".txt"]);
    assert.equal(cfg.budget.maxCost, 1.5);
    assert.equal(cfg.budget.maxTokens, 50000);
    assert.equal(cfg.budget.maxDepth, 3);
    assert.equal(cfg.toolsLevel, "standard");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("loads minimal rlmx.yaml with defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await writeFile(join(dir, "rlmx.yaml"), "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "anthropic");
    assert.equal(cfg.toolsLevel, "core");
    assert.equal(cfg.budget.maxCost, null);
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("falls back to .md files when no YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await writeFile(join(dir, "MODEL.md"), "provider: openai\nmodel: gpt-4\n");
    await writeFile(join(dir, "SYSTEM.md"), "You are a test bot.");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "openai");
    assert.equal(cfg.model.model, "gpt-4");
    assert.equal(cfg.system, "You are a test bot.");
    assert.equal(cfg.configSource, "md");
    await rm(dir, { recursive: true });
  });

  it("returns defaults when no config files exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("throws on invalid YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await writeFile(join(dir, "rlmx.yaml"), "model: [\ninvalid yaml");
    await assert.rejects(() => loadConfig(dir), /Invalid YAML/);
    await rm(dir, { recursive: true });
  });

  it("rejects invalid tools-level", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await writeFile(join(dir, "rlmx.yaml"), "tools-level: mega\n");
    await assert.rejects(() => loadConfig(dir), /Invalid tools-level/);
    await rm(dir, { recursive: true });
  });
});

describe("parseToolsMd", () => {
  it("extracts tools from markdown format", () => {
    const md = `## greet\n\`\`\`python\ndef greet(name):\n    return f"Hello {name}"\n\`\`\`\n\n## farewell\n\`\`\`python\ndef farewell():\n    return "Goodbye"\n\`\`\``;
    const tools = parseToolsMd(md);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "greet");
    assert.ok(tools[0].code.includes("def greet"));
    assert.equal(tools[1].name, "farewell");
  });
});

describe("parseModelMd", () => {
  it("parses key: value pairs", () => {
    const md = "provider: openai\nmodel: gpt-4\nsub-call-model: gpt-3.5-turbo";
    const model = parseModelMd(md);
    assert.equal(model.provider, "openai");
    assert.equal(model.model, "gpt-4");
    assert.equal(model.subCallModel, "gpt-3.5-turbo");
  });

  it("uses defaults for missing keys", () => {
    const model = parseModelMd("");
    assert.equal(model.provider, "google");
  });
});
