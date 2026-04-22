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

// ─── runAgent (G2b) ──────────────────────────────────────────────
export { runAgent } from "./agent.js";
export type {
	AgentConfig,
	IterationDriver,
	IterationRequest,
	IterationStep,
	ToolResolver,
} from "./agent.js";

// ─── rlmDriver (G2c — real LLM bridge) ───────────────────────────
export { formatRlmPrompt, rlmDriver } from "./rlm-driver.js";
export type { RlmDriverConfig } from "./rlm-driver.js";

// ─── Agent spec + tool plugin loader (G3a) ───────────────────────
export {
	loadAgentSpec,
	parseAgentSpec,
	resolveAgentPath,
} from "./agent-spec.js";
export type { AgentBudget, AgentScope, AgentSpec } from "./agent-spec.js";
export {
	createToolRegistry,
	toolRegistryAsResolver,
	UnknownToolError,
} from "./tool-registry.js";
export type { ToolContext, ToolHandler, ToolRegistry } from "./tool-registry.js";
export {
	InvalidPluginError,
	MissingPluginError,
	loadPluginTools,
} from "./tool-loader.js";
export type { LoadOptions, LoadResult } from "./tool-loader.js";

// ─── RTK plugin (G3a) ────────────────────────────────────────────
export { registerRtkTool } from "./rtk-plugin.js";
export type {
	RegisterRtkOptions,
	RtkToolArgs,
	RtkToolResult,
} from "./rtk-plugin.js";

// ─── Metrics (G3a) ───────────────────────────────────────────────
export { createMetricsRecorder } from "./metrics.js";
export type { IterationMetrics, MetricsRecorder } from "./metrics.js";
