import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadContext, loadContextFromDir, loadContextFromFile } from "../src/context.js";
import type { ContextItem } from "../src/context.js";

describe("context loading", () => {
  let dir: string;

  it("default options load only .md files", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await writeFile(join(dir, "a.md"), "hello");
    await writeFile(join(dir, "b.txt"), "world");
    await writeFile(join(dir, "c.py"), "code");
    const ctx = await loadContextFromDir(dir);
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 1);
    assert.equal(items[0].path, "a.md");
    await rm(dir, { recursive: true });
  });

  it("custom extensions load specified types", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await writeFile(join(dir, "a.md"), "hello");
    await writeFile(join(dir, "b.txt"), "world");
    const ctx = await loadContextFromDir(dir, { extensions: [".md", ".txt"] });
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 2);
    await rm(dir, { recursive: true });
  });

  it("three extensions load all", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await writeFile(join(dir, "a.md"), "hello");
    await writeFile(join(dir, "b.txt"), "world");
    await writeFile(join(dir, "c.py"), "code");
    const ctx = await loadContext(dir, { extensions: [".md", ".txt", ".py"] });
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 3);
    await rm(dir, { recursive: true });
  });

  it("exclude patterns skip directories", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await mkdir(join(dir, "docs"));
    await mkdir(join(dir, "skip_me"));
    await writeFile(join(dir, "docs", "a.md"), "hello");
    await writeFile(join(dir, "skip_me", "b.md"), "hidden");
    const ctx = await loadContextFromDir(dir, { exclude: ["skip_me"] });
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 1);
    assert.ok(items[0].path.includes("a.md"));
    await rm(dir, { recursive: true });
  });

  it("glob exclude patterns work", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await writeFile(join(dir, "readme.md"), "content");
    await writeFile(join(dir, "debug.log"), "logs");
    const ctx = await loadContext(dir, {
      extensions: [".md", ".log"],
      exclude: ["*.log"],
    });
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 1);
    assert.equal(items[0].path, "readme.md");
    await rm(dir, { recursive: true });
  });

  it("hidden directories always skipped", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await mkdir(join(dir, ".hidden"));
    await writeFile(join(dir, ".hidden", "secret.md"), "secret");
    await writeFile(join(dir, "visible.md"), "visible");
    const ctx = await loadContextFromDir(dir);
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 1);
    assert.equal(items[0].path, "visible.md");
    await rm(dir, { recursive: true });
  });

  it("loads a single file context", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await writeFile(join(dir, "test.md"), "file content here");
    const ctx = await loadContextFromFile(join(dir, "test.md"));
    assert.equal(ctx.type, "string");
    assert.equal(ctx.content, "file content here");
    await rm(dir, { recursive: true });
  });

  it("loads JSON file as dict context", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    await writeFile(join(dir, "data.json"), '{"key": "value"}');
    const ctx = await loadContextFromFile(join(dir, "data.json"));
    assert.equal(ctx.type, "dict");
    await rm(dir, { recursive: true });
  });

  it("empty directory returns empty list", async () => {
    dir = await mkdtemp(join(tmpdir(), "rlmx-ctx-"));
    const ctx = await loadContextFromDir(dir);
    const items = ctx.content as ContextItem[];
    assert.equal(items.length, 0);
    await rm(dir, { recursive: true });
  });
});
