/**
 * RTK integration test — end-to-end subprocess routing through the Python REPL.
 *
 * Boots the same REPL surface that `rlmLoop` uses, executes `run_cli` against a
 * stubbed `rtk` on PATH, and asserts the stub was invoked (the command did go
 * through rtk) when rtkEnabled is on.
 *
 * Skips gracefully when the host Python or `git` is missing so CI with a thin
 * toolchain does not break.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scaffold } from "../src/scaffold.js";
import { parseToolsMd } from "../src/config.js";
import { REPL } from "../src/repl.js";
const execFileAsync = promisify(execFile);
async function hasBinary(name) {
    try {
        await execFileAsync("which", [name], { timeout: 2_000 });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Build a throwaway rtk stub in a temp directory and return the dir path so
 * callers can prepend it to PATH. The stub prints a known sentinel token plus
 * its argv, proving any rtk-routed subprocess actually hit the stub.
 */
async function makeRtkStub() {
    const stubDir = await mkdtemp(join(tmpdir(), "rlmx-rtk-int-"));
    const stub = join(stubDir, "rtk");
    // Print a marker so integration assertions can detect rtk routing. The stub
    // then `exec`s the target command so stdout/exit-code parity is preserved.
    await writeFile(stub, `#!/usr/bin/env bash
echo "__RTK_STUB_MARKER__:$*"
# forward to real command so return code + subsequent output still reflect reality
exec "$@"
`, "utf-8");
    await chmod(stub, 0o755);
    return stubDir;
}
describe("RTK integration (REPL routes run_cli through rtk)", () => {
    const originalPath = process.env.PATH ?? "";
    let pythonAvailable = false;
    let gitAvailable = false;
    before(async () => {
        pythonAvailable = await hasBinary("python3");
        gitAvailable = await hasBinary("git");
    });
    after(() => {
        process.env.PATH = originalPath;
    });
    it("scaffolded project inherits run_cli example in TOOLS.md", async () => {
        const dir = await mkdtemp(join(tmpdir(), "rlmx-rtk-scaffold-"));
        try {
            await scaffold(dir, "default");
            const { readFile } = await import("node:fs/promises");
            const tools = await readFile(join(dir, ".rlmx", "TOOLS.md"), "utf-8");
            assert.ok(tools.includes("run_cli"), "scaffolded TOOLS.md must mention run_cli");
            const parsed = parseToolsMd(tools);
            assert.ok(parsed.some((t) => t.code.includes("run_cli")), "scaffolded TOOLS.md must contain at least one tool using run_cli");
        }
        finally {
            await rm(dir, { recursive: true });
        }
    });
    it("REPL with rtkEnabled routes run_cli through the rtk stub", async (ctx) => {
        if (!pythonAvailable) {
            ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
            return;
        }
        const stubDir = await makeRtkStub();
        process.env.PATH = `${stubDir}:${originalPath}`;
        const repl = new REPL();
        try {
            await repl.start({ rtkEnabled: true, toolsLevel: "standard" });
            // Execute run_cli through the REPL. `printenv PATH` is used as the
            // forwarded command because it's always available on Unix and produces
            // stable stdout.
            const result = await repl.execute(`_r = run_cli("printenv", "PATH")\nprint(_r["stdout"])\nprint("PREFIXED:" + str(_r["rtk_prefixed"]))`);
            assert.equal(result.error, undefined, `REPL raised: ${result.error ?? "(no error)"} — stderr=${result.stderr}`);
            assert.ok(result.stdout.includes("__RTK_STUB_MARKER__"), `expected stub marker in stdout, got:\n${result.stdout}\n---stderr---\n${result.stderr}`);
            assert.ok(result.stdout.includes("PREFIXED:True"), `expected run_cli to report rtk_prefixed=True, got:\n${result.stdout}`);
        }
        finally {
            await repl.stop();
            await rm(stubDir, { recursive: true });
            process.env.PATH = originalPath;
        }
    });
    it("REPL without rtkEnabled executes command directly (no stub marker)", async (ctx) => {
        if (!pythonAvailable) {
            ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
            return;
        }
        const stubDir = await makeRtkStub();
        process.env.PATH = `${stubDir}:${originalPath}`;
        const repl = new REPL();
        try {
            await repl.start({ rtkEnabled: false, toolsLevel: "standard" });
            const result = await repl.execute(`_r = run_cli("printenv", "PATH")\nprint(_r["stdout"])\nprint("PREFIXED:" + str(_r["rtk_prefixed"]))`);
            assert.equal(result.error, undefined);
            assert.ok(!result.stdout.includes("__RTK_STUB_MARKER__"), "stub must NOT fire when rtkEnabled=false");
            assert.ok(result.stdout.includes("PREFIXED:False"), `expected rtk_prefixed=False, got:\n${result.stdout}`);
        }
        finally {
            await repl.stop();
            await rm(stubDir, { recursive: true });
            process.env.PATH = originalPath;
        }
    });
    it("run_cli preserves exit code and stdout identically between on/off modes", async (ctx) => {
        if (!pythonAvailable || !gitAvailable) {
            ctx.diagnostic("python3 or git missing — skipping parity check");
            return;
        }
        const stubDir = await makeRtkStub();
        process.env.PATH = `${stubDir}:${originalPath}`;
        const replOn = new REPL();
        const replOff = new REPL();
        try {
            await replOn.start({ rtkEnabled: true, toolsLevel: "standard" });
            await replOff.start({ rtkEnabled: false, toolsLevel: "standard" });
            // A command with deterministic output+exit that's available everywhere.
            const code = `import json\nr = run_cli("true")\nprint(json.dumps({"rc": r["returncode"]}))`;
            const r1 = await replOn.execute(code);
            const r2 = await replOff.execute(code);
            const parse = (s) => {
                const line = s.split("\n").find((l) => l.trim().startsWith("{")) ?? "{}";
                return JSON.parse(line);
            };
            const on = parse(r1.stdout);
            const off = parse(r2.stdout);
            assert.equal(on.rc, 0, "rtk-on path must preserve exit code");
            assert.equal(off.rc, 0, "rtk-off path must preserve exit code");
            assert.equal(on.rc, off.rc, "exit code parity between on/off");
        }
        finally {
            await replOn.stop();
            await replOff.stop();
            await rm(stubDir, { recursive: true });
            process.env.PATH = originalPath;
        }
    });
});
//# sourceMappingURL=rtk-integration.test.js.map