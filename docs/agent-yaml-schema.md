# `agent.yaml` schema

The agent folder's `agent.yaml` file is a small YAML mapping that the
SDK's `parseAgentSpec` / `loadAgentSpec` turn into an `AgentSpec`.
The schema is **deliberately minimal** — only the fields the SDK
consumes are validated. Unknown keys are preserved on `AgentSpec.extras`
so consumers (brain, genie, your project) can layer their own schema
without forking the parser.

## Minimal example

```yaml
schema_version: 1
tools_api: 1

shape: single-step
model: gemini-2.5-flash

tools:
  - greet
```

Loaded:

```ts
const spec = await sdk.loadAgentSpec("/path/to/agent-dir");
// spec = {
//   dir: "/path/to/agent-dir",
//   schemaVersion: 1,
//   toolsApi: 1,
//   shape: "single-step",
//   model: "gemini-2.5-flash",
//   tools: ["greet"],
//   extras: {},
// }
```

## Full reference

```yaml
# ─── Schema versioning ────────────────────────────────────────
schema_version: 1            # or schemaVersion: 1   (both accepted)
tools_api: 1                 # or toolsApi: 1

# ─── Iteration shape (how the loop behaves) ──────────────────
shape: single-step           # "single-step" | "loop" | "recurse"
                             # Default: single-step

# ─── Model selection (consumer-interpreted) ──────────────────
model: gemini-2.5-flash      # free-form string; the SDK does not
                             # validate — it's surfaced on AgentSpec
                             # for the consumer's driver / rlmDriver.

# ─── Tools ───────────────────────────────────────────────────
tools:
  - greet                    # Each name must resolve via the plugin
  - search_corpus            # loader. Missing tools land on
  - rtk                      # result.missing (or throw in strict mode).

# ─── Scope hints (advisory, SDK does NOT enforce) ────────────
scope:
  reads:
    - Conversas/*            # Glob patterns; consumers (brain's
    - docs/**/*.md           # read() tool) enforce the policy.
  writes:
    - _pending/*

# ─── Budget hints (advisory in the SDK today) ────────────────
budget:
  max_cost: 0.01             # USD per run (consumer-enforced)
  max_iterations: 5          # Ceiling — consumer can pass to
                             # runAgent({ maxIterations }).
  max_depth: 3               # For recursive shapes.

# ─── System prompt pointer ───────────────────────────────────
system: SYSTEM.md            # Relative to agent dir. Consumer loads
                             # the content and passes it to the
                             # driver (e.g. rlmDriver({ system })).
```

## Field reference

| field | type | default | status | notes |
|---|---|---|---|---|
| `schema_version` / `schemaVersion` | number | `1` | SDK reads | Bumped when the schema itself changes. |
| `tools_api` / `toolsApi` | number | `1` | SDK reads | Bumped when the tool contract changes. |
| `shape` | `"single-step" \| "loop" \| "recurse"` | `"single-step"` | SDK reads, enforces allowed values | Rejects unknown shapes with a named error. |
| `model` | string | — | passthrough | Not validated. Consumers wire it into their driver. |
| `tools` | string[] | `[]` | SDK reads | Empty strings are filtered. Duplicate names collapse (last wins at load). |
| `system` | string | — | passthrough | Consumer is responsible for reading the file + handing its contents to the driver. |
| `scope.reads` | string[] | — | passthrough | Advisory. Enforced by individual tool handlers (e.g. brain's `read`). |
| `scope.writes` | string[] | — | passthrough | Advisory, same as above. |
| `budget.max_cost` / `maxCost` | number | — | passthrough | Consumer threads it into their budget tracker. |
| `budget.max_iterations` / `maxIterations` | number | — | SDK/consumer | Can be passed to `runAgent({ maxIterations })`. |
| `budget.max_depth` / `maxDepth` | number | — | passthrough | For recursive shapes. |

## Extras

Any key not listed above is preserved on `AgentSpec.extras` so
domain-specific schemas can layer without a parser fork:

```yaml
# agent.yaml
schema_version: 1
tools: [search_corpus]

brain:
  reader_inline_media: true
  pending_writes_whitelist:
    - _pending/**/*.yaml
```

```ts
const spec = await sdk.loadAgentSpec("/path/to/agent");
// spec.extras.brain === { reader_inline_media: true, pending_writes_whitelist: [...] }
```

## Errors the parser raises

| condition | error |
|---|---|
| YAML syntax error | `Error: agent.yaml: parse error: ...` |
| Top-level is not a mapping (e.g. a list or scalar) | `Error: agent.yaml: expected a YAML mapping at the top level` |
| `shape` is set to an unsupported value | `Error: agent.yaml: shape must be one of single-step \| loop \| recurse, got "..."` |
| `agent.yaml` file is missing (via `loadAgentSpec`) | `ENOENT` from `node:fs` |

Non-strings, non-finite numbers, and other type drift default
silently — the parser aims to be forgiving where there's no risk of
surprise.

## Consumer schema evolution

When you need to validate additional fields — e.g. brain's
`scope.reads` enforcement — layer your own validator on top of
`AgentSpec.extras`. The SDK's parser is a floor, not a ceiling:

```ts
import { sdk } from "@automagik/rlmx";

const spec = await sdk.loadAgentSpec(path);
validateBrainExtras(spec.extras); // your layer; throws if non-compliant.
const registry = sdk.createToolRegistry();
// ... proceed ...
```
