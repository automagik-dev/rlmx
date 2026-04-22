/**
 * SDK public surface — Wish B Group 1 skeleton.
 *
 * Group 1 ships event types + emitter. `runAgent()`, `resumeAgent()`,
 * permission hooks, and validate primitives are defined by Groups 2-3
 * per `.genie/wishes/rlmx-sdk-upgrade/WISH.md`. The public re-export
 * stays intentionally narrow — consumers depending on internals would
 * break when Group 2 lands.
 */
export {
	ALL_AGENT_EVENT_TYPES,
	isAgentEvent,
	iso,
	makeEvent,
} from "./events.js";
export type {
	AgentEvent,
	AgentEventType,
	AgentStartEvent,
	EmitDoneEvent,
	ErrorEvent,
	IterationOutputEvent,
	IterationStartEvent,
	MessageEvent,
	RecurseEvent,
	ToolCallAfterEvent,
	ToolCallBeforeEvent,
	ValidationEvent,
} from "./events.js";
export { createEmitter } from "./emitter.js";
export type {
	EmitterAndStream,
	EventEmitter,
	EventStream,
} from "./emitter.js";
