import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseToolsMd } from "../src/config.js";

/** Helper: create .rlmx/ dir with rlmx.yaml content */
async function makeConfig(dir: string, yamlContent: string): Promise<void> {
  const rlmxDir = join(dir, ".rlmx");
  await mkdir(rlmxDir, { recursive: true });
  await writeFile(join(rlmxDir, "rlmx.yaml"), yamlContent);
}

describe("YAML config loading", () => {
  let dir: string;

  it("loads valid .rlmx/rlmx.yaml with all fields", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, `model:
  provider: openai
  model: gpt-4
  sub-call-model: gpt-3.5-turbo
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
`);
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "openai");
    assert.equal(cfg.model.model, "gpt-4");
    assert.equal(cfg.model.subCallModel, "gpt-3.5-turbo");
    assert.deepEqual(cfg.contextConfig.extensions, [".md", ".txt"]);
    assert.equal(cfg.budget.maxCost, 1.5);
    assert.equal(cfg.budget.maxTokens, 50000);
    assert.equal(cfg.budget.maxDepth, 3);
    assert.equal(cfg.toolsLevel, "standard");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("auto-loads SYSTEM.md and CRITERIA.md from .rlmx/", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    await writeFile(join(dir, ".rlmx", "SYSTEM.md"), "You are a helper.");
    await writeFile(join(dir, ".rlmx", "CRITERIA.md"), "Be concise.");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.system, "You are a helper.");
    assert.equal(cfg.criteria, "Be concise.");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("auto-loads TOOLS.md from .rlmx/", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    await writeFile(join(dir, ".rlmx", "TOOLS.md"), "## greet\n```python\ndef greet(name):\n    return f\"Hello {name}\"\n```\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.tools.length, 1);
    assert.equal(cfg.tools[0].name, "greet");
    await rm(dir, { recursive: true });
  });

  it("loads minimal .rlmx/rlmx.yaml with defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "anthropic");
    assert.equal(cfg.toolsLevel, "core");
    assert.equal(cfg.budget.maxCost, null);
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("returns defaults when no .rlmx/ exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("ignores root rlmx.yaml (only .rlmx/ is checked)", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await writeFile(join(dir, "rlmx.yaml"), "model:\n  provider: openai\n");
    const cfg = await loadConfig(dir);
    // Root rlmx.yaml should be ignored — defaults returned
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("throws on invalid YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "model: [\ninvalid yaml");
    await assert.rejects(() => loadConfig(dir), /Invalid YAML/);
    await rm(dir, { recursive: true });
  });

  it("rejects invalid tools-level", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "tools-level: mega\n");
    await assert.rejects(() => loadConfig(dir), /Invalid tools-level/);
    await rm(dir, { recursive: true });
  });

  it("defaults rtk.enabled to auto when rlmx.yaml omits it", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.rtk.enabled, "auto");
    await rm(dir, { recursive: true });
  });

  it("accepts rtk.enabled: never", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "rtk:\n  enabled: never\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.rtk.enabled, "never");
    await rm(dir, { recursive: true });
  });

  it("rejects invalid rtk.enabled", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    await makeConfig(dir, "rtk:\n  enabled: banana\n");
    await assert.rejects(() => loadConfig(dir), /Invalid rtk\.enabled/);
    await rm(dir, { recursive: true });
  });

  it("default config (no yaml) sets rtk.enabled to auto", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.rtk.enabled, "auto");
    assert.equal(cfg.configSource, "defaults");
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
