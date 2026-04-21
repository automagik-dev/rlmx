#!/usr/bin/env node
/**
 * dogfood-rtk.mjs — Canonical `run_cli` workflow that proves RTK routing end-to-end.
 *
 * Boots the Python REPL with rtkEnabled=true, executes a handful of `run_cli`
 * calls that map to commands RTK filters aggressively (git log, ls -la), and
 * lets RTK's own telemetry record the input/output. The orchestrating script
 * (dogfood.sh or manual run) captures `rtk gain` before and after to compute
 * the savings delta recorded in DOGFOOD.md.
 *
 * This is the same code path a real rlmx session uses — no mocks, no stubs.
 */

import { REPL } from "../dist/src/repl.js";

const WORKFLOW = `
import json
calls = []

# Canonical developer workflow — commands rtk filters aggressively.
# Each produces enough output for rtk's compression to move the savings needle.

# 1. ps aux — long process listing, heavily compressed by rtk.
r = run_cli("ps", "aux")
calls.append({
    "cmd": "ps aux",
    "rc": r["returncode"],
    "stdout_len": len(r["stdout"]),
    "prefixed": r["rtk_prefixed"],
})

# 2. ls -la on a populated dir — rtk strips metadata aggressively.
r = run_cli("ls", "-la", "/home/genie")
calls.append({
    "cmd": "ls -la /home/genie",
    "rc": r["returncode"],
    "stdout_len": len(r["stdout"]),
    "prefixed": r["rtk_prefixed"],
})

# 3. git log with body — verbose output that compresses well.
r = run_cli("git", "log", "-n", "10")
calls.append({
    "cmd": "git log -n 10",
    "rc": r["returncode"],
    "stdout_len": len(r["stdout"]),
    "prefixed": r["rtk_prefixed"],
})

# 4. env — another verbose listing that rtk filters.
r = run_cli("env")
calls.append({
    "cmd": "env",
    "rc": r["returncode"],
    "stdout_len": len(r["stdout"]),
    "prefixed": r["rtk_prefixed"],
})

print("DOGFOOD_RESULT:" + json.dumps(calls))
`;

async function main() {
  const repl = new REPL();
  try {
    await repl.start({ rtkEnabled: true, toolsLevel: "standard" });
    const result = await repl.execute(WORKFLOW, 60_000);
    if (result.error) {
      console.error("REPL error:", result.error);
      console.error("stderr:", result.stderr);
      process.exit(1);
    }

    const marker = result.stdout.split("\n").find((l) => l.startsWith("DOGFOOD_RESULT:"));
    if (!marker) {
      console.error("No DOGFOOD_RESULT marker; stdout:", result.stdout);
      process.exit(1);
    }
    const calls = JSON.parse(marker.slice("DOGFOOD_RESULT:".length));
    console.log(JSON.stringify({ calls }, null, 2));
  } finally {
    await repl.stop();
  }
}

main().catch((err) => {
  console.error("dogfood failed:", err);
  process.exit(1);
});
