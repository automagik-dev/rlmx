# rlmx SDK — Event Stream + Session / Permission / Validate primitives + runAgent

> **Status:** Wish B Groups 1 + 2 + 2b.
> G1 shipped event types + emitter.
> G2 added session persistence, permission hooks, validate primitive, session-lifecycle events.
> **G2b wires everything into `runAgent()`** — the pluggable driver seam lets consumers
> plug in a canned driver (tests) or (later) `rlm.ts` (production). CLI entry
> switch-over remains a separate slice.
> See `.genie/wishes/rlmx-sdk-upgrade/WISH.md`.

The SDK yields a stream of typed events describing one agent run.
Consumers drive the stream with `for await`; the SDK core pushes
events at every state transition.

```ts
import { sdk } from "@automagik/rlmx";
// Future (Group 2): const stream = sdk.runAgent({ ... });
// Today: construct an emitter manually for tests / preview.
const em = sdk.createEmitter();

em.emit(
	sdk.makeEvent("AgentStart", {
		agentId: "demo",
		sessionId: "s-1",
		config: { model: "claude-sonnet-4-6" },
	}),
);

for await (const ev of em) {
	console.log(ev.type, ev.timestamp);
}
```

## Event catalogue (12 types)

| `type`            | Emitted when                                          |
| ----------------- | ----------------------------------------------------- |
| `AgentStart`      | Once per `runAgent()` before the first iteration.     |
| `IterationStart`  | At the top of each REPL iteration.                    |
| `IterationOutput` | After an iteration completes, with its output string. |
| `ToolCallBefore`  | Immediately before a tool invocation.                 |
| `ToolCallAfter`   | Immediately after a tool returns (success or error).  |
| `Recurse`         | On every `rlm_query` recursion, with depth metadata.  |
| `Validation`      | After an `emit_done` payload is schema-checked.       |
| `Message`         | For human-readable system / user / assistant turns.   |
| `EmitDone`        | When the agent signals completion with a payload.     |
| `Error`           | For non-fatal + fatal failures, tagged by phase.      |
| `SessionOpen`     | On `resumeAgent()` — `resumed` flags fresh vs reload. |
| `SessionClose`    | On `pauseAgent()` / terminal event — carries reason.  |

The first 10 are the wish-spec contract (`WISH_SPEC_EVENT_TYPES`);
the last 2 are session-lifecycle additions from Group 2. Use
`ALL_AGENT_EVENT_TYPES` for the full current union and
`WISH_SPEC_EVENT_TYPES` for just the wish-frozen core.

Every event carries a `timestamp` (`ISO-8601` UTC) and a discriminant
`type` field. Round-trip through JSON is lossless — `isAgentEvent()`
recognises the deserialised shape.

## Emitter contract

- `emit(event)` — synchronous push. Silently no-ops after `close()`.
- `close()` — idempotent; terminates all pending iterator pulls with `{ done: true }`.
- `subscribe()` — returns a fresh `AsyncIterableIterator`. Multiple
  subscribers receive fan-out copies of every post-subscribe event.
- Pre-subscribe events are buffered and replay to the **first**
  subscriber only (no double-delivery).
- The emitter itself is directly iterable via `for await (const ev of em)`.

## Session / Permission / Validate primitives (Group 2)

### Session persistence

```ts
import { sdk } from "@automagik/rlmx";

const store = sdk.createFileSessionStore("/path/to/sessions");
const state = await sdk.resumeAgent("sess-1", store); // null if fresh
// ...run agent iterations, assemble a new state...
await sdk.pauseAgent(state, store, "pause");
```

`SessionStore` is pluggable — the default is file-backed, each session
lands as an atomic JSON write under `baseDir/<id>.json`. A pgserve-backed
store can implement the same 4-method interface without rippling call
sites. `pauseAgent` stamps `updatedAt` on save; budget (`spent`, `limit`,
`currency`) is preserved across the resume boundary.

### Permission hooks

Hooks run before every tool call. `runPermissionChain` walks them in
order; the first non-`allow` decision wins. `modify` rewrites `args`
for subsequent hooks (compose redactors before policy checks).

```ts
const chain = sdk.composeHooks(
	(ctx) => ({ decision: "modify", modifiedArgs: redact(ctx.args) }),
	(ctx) => ctx.tool.startsWith("write_") ? { decision: "deny", reason: "read-only session" } : { decision: "allow" },
);
const result = await chain(ctx);
```

### Validate primitive

Parse `VALIDATE.md`, check an `emit_done` payload, synthesise a retry
hint on failure. Retry-once is enforced by `MAX_VALIDATE_ATTEMPTS`
(= 2) and `shouldRetry(result, attempt)`.

```ts
const { schema, rawBlock } = sdk.parseValidateMd(md);
const result = sdk.validateAgainstSchema(payload, schema, rawBlock);
if (!result.ok && sdk.shouldRetry(result, attempt)) {
	const hint = sdk.buildRetryHint(result);
	// prepend `hint` to the next user turn, bump `attempt`
}
```

## `runAgent()` — the wire (Group 2b)

`runAgent(config)` takes an `AgentConfig` and returns an `EventStream`.
Internally it drives an iteration loop, emits the 12 events, runs the
permission chain before tool calls, validates `emit_done` payloads
(with retry-once), and checkpoints to the session store.

```ts
import { sdk } from "@automagik/rlmx";

const driver: sdk.IterationDriver = async function* (req) {
	// Tests use canned drivers; production plugs rlm.ts here.
	yield { kind: "tool_call", tool: "read_file", args: { path: "/tmp" } };
	yield { kind: "emit_done", payload: { answer: "42" } };
};

const stream = sdk.runAgent({
	agentId: "demo",
	sessionId: "s-1",
	input: "what is the answer?",
	driver,
	sessionStore: sdk.createFileSessionStore("/tmp/sessions"),
	permissionHooks: [
		(ctx) => ctx.tool.startsWith("write_")
			? { decision: "deny", reason: "read-only" }
			: { decision: "allow" },
	],
	validateSchema: {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "string" } },
	},
});

for await (const ev of stream) {
	console.log(ev.type, ev.timestamp);
}
```

`AbortSignal` support: pass `signal` to terminate gracefully at event
boundaries; the emitter closes with `SessionClose { reason: "abort" }`
and the snapshot is checkpointed so `resumeAgent(sessionId, store)`
picks up where abort hit.

## Scope boundary

These PRs ship contract shape + emit infrastructure + Group-2
primitives + the `runAgent()` wire (G2b).
They do **not**:

- instrument `rlm.ts` directly — the iteration logic is behind the
  `IterationDriver` seam, so `rlm.ts` remains untouched until a
  cutover slice wraps it as a driver;
- switch the CLI to use `runAgent()` — `rlmx "query"` still drives
  `rlmLoop` as before;
- ship a pgserve-backed `SessionStore` implementation.
