# Authoring tool plugins

An rlmx agent is a folder with `agent.yaml`, optional `SYSTEM.md` /
`VALIDATE.md`, and a `tools/` subdirectory of per-tool plugin files.
The SDK loads those files at runtime and exposes each as a named
handler `runAgent()` can dispatch. Three flavours are supported.

## TS/MJS tool plugin

File: `<agent-dir>/tools/<name>.mjs` (preferred) or `<name>.js`.

```js
// tools/greet.mjs
export default async function greet(args, ctx) {
	// args  — the payload from the IterationStep `tool_call`
	// ctx   — { tool, sessionId, iteration, signal }
	if (ctx.signal.aborted) throw new Error("aborted");
	return { hello: args.name };
}
```

Rules:

- **Default export only.** The loader imports the module dynamically
  and reads `module.default`. Named exports are ignored.
- **Must be a function.** The default export must satisfy
  `(args: unknown, ctx: ToolContext) => unknown | Promise<unknown>`.
  Anything else throws `InvalidPluginError` at load time.
- **Extension priority.** `.mjs` beats `.js` — pick one per name.
- **TypeScript source (`.ts`) is not loaded in this revision.**
  Compile to `.mjs` or `.js` first, or use `tsx`/`ts-node` in your
  runtime. A future slice will add native TS loading.

Loading:

```ts
import { sdk } from "@automagik/rlmx";

const spec = await sdk.loadAgentSpec("/path/to/my-agent");
const registry = sdk.createToolRegistry();
const result = await sdk.loadPluginTools(spec, registry);
// result: { loaded: ["greet"], skipped: [], missing: [] }
```

## Python tool plugin

File: `<agent-dir>/tools/<name>.py`.

```python
#!/usr/bin/env python3
"""tools/search_corpus.py — stdio-JSON tool."""
import json, sys

args = json.load(sys.stdin)
# ... your logic ...
result = {"hits": [{"id": i, "text": f"doc {i}"} for i in range(args["limit"])]}
json.dump(result, sys.stdout)
```

Protocol:

| direction | format | notes |
|---|---|---|
| stdin | JSON | Single value — what the agent sent as `tool_call.args`. |
| stdout | JSON | Parsed by the SDK; malformed → `PythonPluginError`. |
| stderr | free-form text | Captured but **not** interpreted. Surfaces via error payloads. |
| exit 0 | success | stdout must be valid JSON (empty stdout → `null`). |
| exit ≠ 0 | failure | `PythonPluginError` with `{exitCode, stderr, stdout}`. |

Loading (compose with the TS/MJS loader):

```ts
const js = await sdk.loadPluginTools(spec, registry);       // .mjs / .js first
const py = await sdk.loadPythonPlugins(spec, registry, {    // then .py for the rest
	timeoutMs: 30_000,
	// env is PROCESS.ENV by default — pass `{}` to isolate.
	env: { PATH: process.env.PATH, BRAIN_HOME: agentHome },
});
```

Options:

| option | default | purpose |
|---|---|---|
| `pythonBin` | `"python3"` | Override for venv paths or vendored interpreters. |
| `timeoutMs` | `30000` | Wall-clock budget. `null` disables. On overrun → `PythonPluginTimeoutError`. |
| `env` | `process.env` | Subprocess env. `{}` for isolation. |
| `cwd` | agent dir | `Path.cwd()` inside the plugin. |

Error taxonomy:

- `PythonPluginError` — non-zero exit, malformed stdout JSON, spawn
  failure (`ENOENT` on missing interpreter), missing script file.
  Always carries `exitCode`, `stderr`, `stdout`.
- `PythonPluginTimeoutError` — wall-clock overrun (SIGKILL). Carries
  `toolName`, `timeoutMs`.

Every call spawns a fresh subprocess — no pooling, no state leakage.
The ~50–100 ms interpreter startup is acceptable for sub-second
LLM-bound tool cadence.

## RTK as a first-class tool

[RTK](https://crates.io/crates/rtk) ("rust token killer") is a CLI
token-optimised subprocess runner. The SDK can register it as a
drop-in tool named `"rtk"`.

```ts
const registered = await sdk.registerRtkTool(registry);
// returns true when rtk is on PATH + the registry gained the tool,
// false when rtk is absent (no-op — agents can still declare `rtk`
// in agent.yaml and it will simply land on result.missing).
```

Handler signature:

```ts
const result = await registry.get("rtk")!(
	{ cmd: ["cargo", "test", "--quiet"] },
	ctx,
);
// result: { stdout, stderr, exitCode, durationMs }
```

Options:

| option | default | purpose |
|---|---|---|
| `name` | `"rtk"` | Override — useful for "sandboxed vs raw" splits. |
| `forceRegister` | `false` | Register the tool even when `rtk` is absent. Handler then fails at call time. |

Pre-registered RTK takes precedence over any `tools/rtk.{mjs,js,py}`
file on disk — the plugin loader reports such files on
`result.skipped`. This mirrors the general **pre-registered handlers
always win** invariant.

## Handler context

Every handler (TS / Python / RTK) receives a `ToolContext`:

```ts
interface ToolContext {
	readonly tool: string;            // the agent-declared name
	readonly sessionId: string;
	readonly iteration: number;
	readonly signal: AbortSignal;     // abort-at-boundaries
}
```

Honour `ctx.signal.aborted` in long-running handlers. The Python
loader already wires `signal.addEventListener("abort", ...)` to
`SIGKILL` the subprocess; TS/MJS handlers should check at cooperative
boundaries.

## Testing a plugin hermetically

```ts
import { sdk } from "@automagik/rlmx";

const registry = sdk.createToolRegistry();
await sdk.loadPluginTools(spec, registry);
const greet = registry.get("greet")!;
const out = await greet({ name: "Stéfani" }, {
	tool: "greet",
	sessionId: "t",
	iteration: 1,
	signal: new AbortController().signal,
});
// assert on `out`
```

For full end-to-end coverage with the event stream + permission chain
+ session checkpoint, pass the registry to `runAgent({ toolRegistry })`
and drive with a canned `IterationDriver`. See
[`examples/`](../examples/) for runnable walk-throughs.

## Production reference — `khal-os/brain`

The `examples/brain-triage/` directory in this repo demonstrates the
Python-plugin pattern in minimal form. For a full production
implementation of the pattern across three bridged agents, see
`khal-os/brain`:

| agent | folder | tools registered |
|---|---|---|
| L1 triage | `.agents/triage/` | `read`, `emit_done` |
| L2 preservation | `.agents/preservation/` | `brain_list`, `brain_get`, `brain_search`, `validate`, `read_window`, `brain_write`, `brain_propose`, `emit_done` |
| L3 audit | `.agents/audit/` | sampled audit subset |

Each folder carries the same `agent.yaml` + `SYSTEM.md` +
`VALIDATE.md` shape this repo documents. The bridge driver
(`src/agent/rlmx-bridge.ts` in brain) wraps each agent's existing
pi-agent loop as one outer iteration of `runAgent()`, preserving
retry / validate / stop-reason semantics exactly while gaining
SDK-level events, permissions, and session checkpointing.
