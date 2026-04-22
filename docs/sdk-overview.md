# rlmx SDK — Overview

The rlmx SDK lets you build **declarative, observable, resumable AI
agents** from a folder of markdown + tool plugins. It sits alongside the
existing rlmx CLI (`rlmx "query"`) — the CLI path keeps running the
recursion engine in `src/rlm.ts` unchanged, while the SDK exposes a
finer-grained, programmatic surface for consumers who want to drive the
loop from their own code.

## Layer diagram

```
┌────────────────────────────────────────────────────────┐
│ Consumer code  (genie, brain, your app)                │
└─────────────────────────▲──────────────────────────────┘
                          │   runAgent(config) → EventStream
                          │
┌─────────────────────────┴──────────────────────────────┐
│ Driver seam (IterationDriver)                          │
│  • rlmDriver()       — live LLM via llmCompleteSimple  │
│  • your own async*   — canned / tests / custom         │
└─────────────────────────▲──────────────────────────────┘
                          │
┌─────────────────────────┴──────────────────────────────┐
│ runAgent wire (src/sdk/agent.ts)                       │
│  emits AgentStart → IterationStart → (Message |        │
│        ToolCallBefore → ToolCallAfter)* → EmitDone |   │
│        Error → IterationOutput → SessionClose          │
│  runs: permission chain, validate retry, session ckpt │
└─┬─────────▲─────────▲─────────▲──────────▲─────────────┘
  │         │         │         │          │
  ▼         │         │         │          │
┌────┐  ┌───┴──┐  ┌───┴────┐ ┌──┴─────┐ ┌──┴──────┐
│Ev. │  │Sess. │  │Permis- │ │Validate│ │Metrics  │
│SDK │  │API   │  │sion    │ │prim.   │ │recorder │
│(12 │  │+File │  │hooks   │ │+retry  │ │(depth-  │
│type│  │Store │  │chain   │ │once    │ │aware)   │
└────┘  └──────┘  └────────┘ └────────┘ └─────────┘
```

## Design principles

**Additive only.** Every SDK slice is a new namespace under `rlmx.sdk.*`
— no existing export shape changed, no CLI behaviour modified.
Consumers on the SDK path opt in; everything else keeps working.

**Pluggable seams, not invasive patches.** When the SDK needs to
cooperate with existing rlmx pieces (LLM transport, RTK detection), it
imports them and wraps them. It does not re-plumb `src/rlm.ts`
internals. This trades some duplication for zero regression risk.

**Events as the observability contract.** The 10 wish-spec event types
(plus session lifecycle) are the sole surface consumers subscribe to.
Anything else — metrics, per-depth accounting, retry hints — rides on
existing event payloads as optional fields. `ALL_AGENT_EVENT_TYPES`
stays small.

**Env-gated live tests.** CI runs deterministic hermetic tests only.
Live LLM smokes + Python protocol tests gate on env vars
(`GEMINI_API_KEY`, `python3 --version`) so they degrade to SKIP rather
than FAIL when the environment isn't there.

**Backcompat is policy, not aspiration.** The existing `rlmx "query"`
CLI is byte-for-byte identical to pre-SDK behaviour. The CLI cutover to
use `runAgent()` is a deliberately separate slice.

## Module map

| path | role |
|---|---|
| `src/sdk/events.ts` | Event type union + `makeEvent`, `iso`, `isAgentEvent`, `ALL_AGENT_EVENT_TYPES`, `WISH_SPEC_EVENT_TYPES`. |
| `src/sdk/emitter.ts` | Async-iterator `EventStream` + `createEmitter()`. |
| `src/sdk/session.ts` | `SessionState`, `SessionStore`, `createFileSessionStore`, `resumeAgent`, `pauseAgent`. |
| `src/sdk/permissions.ts` | `PermissionHook`, `runPermissionChain`, `composeHooks`, `ALLOW`. |
| `src/sdk/validate.ts` | `parseValidateMd`, `validateAgainstSchema`, `shouldRetry`, `buildRetryHint`. |
| `src/sdk/agent.ts` | `runAgent`, `AgentConfig`, `IterationDriver`, `IterationStep`, `ToolResolver`. |
| `src/sdk/rlm-driver.ts` | `rlmDriver` + `formatRlmPrompt` + `RlmDriverConfig` — bridges `llmCompleteSimple` into `IterationDriver`. |
| `src/sdk/agent-spec.ts` | `AgentSpec`, `parseAgentSpec`, `loadAgentSpec`, `resolveAgentPath`. |
| `src/sdk/tool-registry.ts` | `ToolRegistry`, `createToolRegistry`, `toolRegistryAsResolver`, `UnknownToolError`, `ToolHandler`. |
| `src/sdk/tool-loader.ts` | `loadPluginTools` (`.mjs` / `.js`) + `MissingPluginError` + `InvalidPluginError`. |
| `src/sdk/python-plugin.ts` | `loadPythonPlugins`, `makePythonPluginHandler`, `PythonPluginError`, `PythonPluginTimeoutError`. |
| `src/sdk/rtk-plugin.ts` | `registerRtkTool`. |
| `src/sdk/metrics.ts` | `IterationMetrics`, `createMetricsRecorder`. |

Public entry: `import { sdk } from "@automagik/rlmx"`.

## When to use the SDK vs the CLI

**Use the CLI (`rlmx "query"`)** when:
- You're running an ad-hoc query against a markdown-configured agent
  directory and you want the canonical rlmx iteration loop.
- You need tight compatibility with the existing `rlmx.yaml`
  configuration surface.
- You don't need per-iteration observability or programmatic control.

**Use the SDK (`sdk.runAgent(...)`)** when:
- You're embedding agent execution in another program (genie, brain,
  a service) and need to iterate events directly.
- You want to checkpoint + resume sessions across process restarts.
- You need permission hooks, per-depth metrics, or validate with
  retry-hint feedback.
- You're authoring tests that exercise agent behaviour without a live
  LLM (canned `IterationDriver`).

## Further reading

- [`docs/events.md`](./events.md) — the 12-event catalogue + usage.
- [`docs/tool-authoring.md`](./tool-authoring.md) — writing `.mjs`,
  `.js`, and `.py` tool plugins.
- [`docs/agent-yaml-schema.md`](./agent-yaml-schema.md) — the
  `agent.yaml` reference.
- [`examples/`](../examples/) — three runnable example agents with
  smoke tests.
