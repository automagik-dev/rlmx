# rlmx SDK — Event Stream

> **Status:** Wish B Group 1 skeleton — event types + emitter only.
> `runAgent()` / `resumeAgent()` / permission hooks land in Groups 2–3.
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

## Event catalogue (10 types)

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

## Scope boundary

This PR ships the contract shape + emit infrastructure. It does **not**:

- instrument `rlm.ts` with emit calls (Group 2–3);
- define `runAgent()` / `resumeAgent()` (Group 2);
- wire permission hooks or the `VALIDATE.md` primitive (Group 2);
- touch CLI behaviour — `rlmx "query"` is unchanged.
