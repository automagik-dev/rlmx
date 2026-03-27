import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffold } from "../src/scaffold.js";

describe("Scaffold includes Gemini section", () => {
  let dir: string;

  it("rlmx init includes commented gemini section", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-scaffold-"));
    const created = await scaffold(dir);
    assert.ok(created.includes("rlmx.yaml"));

    const content = await readFile(join(dir, "rlmx.yaml"), "utf-8");
    assert.ok(content.includes("gemini:"), "Should contain gemini section");
    assert.ok(content.includes("thinking-level"), "Should mention thinking-level");
    assert.ok(content.includes("google-search"), "Should mention google-search");
    assert.ok(content.includes("url-context"), "Should mention url-context");
    assert.ok(content.includes("code-execution"), "Should mention code-execution");
    assert.ok(content.includes("media-resolution"), "Should mention media-resolution");
    assert.ok(content.includes("computer-use"), "Should mention computer-use");
    assert.ok(content.includes("maps-grounding"), "Should mention maps-grounding");
    assert.ok(content.includes("file-search"), "Should mention file-search");
    await rm(dir, { recursive: true });
  });

  it("rlmx init includes output section", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-scaffold-"));
    await scaffold(dir);
    const content = await readFile(join(dir, "rlmx.yaml"), "utf-8");
    assert.ok(content.includes("output:"), "Should contain output section");
    assert.ok(content.includes("schema"), "Should mention schema");
    await rm(dir, { recursive: true });
  });

  it("scaffold default model is now Gemini 3", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-scaffold-"));
    await scaffold(dir);
    const content = await readFile(join(dir, "rlmx.yaml"), "utf-8");
    assert.ok(content.includes("provider: google"), "Default provider should be google");
    assert.ok(
      content.includes("gemini-3.1-flash-lite-preview"),
      "Default model should be gemini-3.1-flash-lite-preview"
    );
    await rm(dir, { recursive: true });
  });
});
