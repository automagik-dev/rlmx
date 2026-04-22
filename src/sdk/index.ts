/**
 * SDK public surface — Wish B Groups 1 + 2 cumulative.
 *
 * Group 1 shipped event types + emitter.
 * Group 2 adds session / permissions / validate primitives + session
 * lifecycle events. `runAgent()` wiring lands in a later slice per
 * `.genie/wishes/rlmx-sdk-upgrade/WISH.md`.
 */

// ─── Events ──────────────────────────────────────────────────────
export {
	ALL_AGENT_EVENT_TYPES,
	WISH_SPEC_EVENT_TYPES,
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
	SessionCloseEvent,
	SessionCloseReason,
	SessionOpenEvent,
	ToolCallAfterEvent,
	ToolCallBeforeEvent,
	ValidationEvent,
} from "./events.js";

// ─── Emitter ─────────────────────────────────────────────────────
export { createEmitter } from "./emitter.js";
export type {
	EmitterAndStream,
	EventEmitter,
	EventStream,
} from "./emitter.js";

// ─── Session ─────────────────────────────────────────────────────
export {
	createFileSessionStore,
	isSessionState,
	pauseAgent,
	resumeAgent,
} from "./session.js";
export type {
	BudgetSnapshot,
	HistoryTurn,
	SessionState,
	SessionStore,
} from "./session.js";

// ─── Permissions ─────────────────────────────────────────────────
export { ALLOW, composeHooks, runPermissionChain } from "./permissions.js";
export type {
	PermissionDecision,
	PermissionHook,
	PermissionHookContext,
} from "./permissions.js";

// ─── Validate ────────────────────────────────────────────────────
export {
	MAX_VALIDATE_ATTEMPTS,
	buildRetryHint,
	parseValidateMd,
	shouldRetry,
	validateAgainstSchema,
} from "./validate.js";
export type { ValidateResult, ValidateSchema } from "./validate.js";
