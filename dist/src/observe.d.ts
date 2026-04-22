/**
 * ObservabilityRecorder — fire-and-forget event recording to pgserve.
 *
 * Records every LLM call, REPL execution, and sub-call into rlmx_sessions
 * and rlmx_events tables. All methods are fire-and-forget: errors are logged
 * to stderr but never thrown or block the main RLM loop.
 */
import type { PgStorage } from "./storage.js";
/** Usage info for recording an LLM call. */
export interface LLMCallUsage {
    inputTokens: number;
    outputTokens: number;
    cost: number;
}
/** Total usage for recording session completion. */
export interface TotalUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    totalCost: number;
}
export declare class ObservabilityRecorder {
    private storage;
    private sessionId;
    constructor(storage: PgStorage);
    /**
     * Create a new session record.
     */
    startSession(runId: string, query: string, model: string, provider: string, contextPath?: string, config?: Record<string, unknown>): void;
    /**
     * Record an LLM call event.
     */
    recordLLMCall(iteration: number, usage: LLMCallUsage, model: string, durationMs: number): void;
    /**
     * Record a REPL execution event.
     */
    recordReplExec(iteration: number, code: string, stdout: string, stderr: string, durationMs: number, isError?: boolean): void;
    /**
     * Record a sub-call event (pg_search, llm_query from REPL, etc.).
     */
    recordSubCall(iteration: number, requestType: string, promptPreview: string, durationMs: number, isError?: boolean, errorMessage?: string): void;
    /**
     * Record session completion with final answer and totals.
     */
    recordFinal(answer: string, iterations: number, totalUsage: TotalUsage): void;
    /**
     * Record session failure.
     */
    recordError(errorMessage: string): void;
    /**
     * Fire-and-forget: run an async operation, swallow errors.
     */
    private fire;
}
//# sourceMappingURL=observe.d.ts.map