/**
 * LLM client wrapper using pi/ai.
 *
 * Provides completeSimple wrapper, batched calls, IPC request handling
 * from the Python REPL, and rlm_query child process spawning.
 */
import type { AssistantMessage as PiAssistantMessage } from "@mariozechner/pi-ai";
import type { RlmxConfig, ModelConfig, GeminiConfig } from "./config.js";
import type { LLMRequest } from "./ipc.js";
import type { Logger } from "./logger.js";
import type { PgStorage } from "./storage.js";
import { type ThinkingLevel } from "./gemini.js";
/** Token usage tracking. */
export interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCost: number;
    llmCalls: number;
}
/** Create a fresh usage tracker. */
export declare function createUsage(): UsageStats;
/** Gemini-specific call counts tracked across an RLM run. */
export interface GeminiCallCounts {
    webSearch: number;
    fetchUrl: number;
    generateImage: number;
    codeExecutionsServerSide: number;
    thoughtSignatures: number;
}
/** Create a fresh Gemini call counter. */
export declare function createGeminiCallCounts(): GeminiCallCounts;
/** Merge child usage into parent. */
export declare function mergeUsage(parent: UsageStats, child: UsageStats): void;
/** Message format for the RLM loop. */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
    /** Original pi/ai AssistantMessage — stored for multi-turn fidelity. */
    piMessage?: PiAssistantMessage;
}
/** Cache config passed through to pi/ai completeSimple. */
export interface CacheLLMConfig {
    enabled: boolean;
    retention: "short" | "long";
    sessionId: string;
}
/** Code execution result from Gemini (GROUP 5). */
export interface CodeExecutionResult {
    code: string;
    outcome: "OUTCOME_OK" | "OUTCOME_FAILED" | "OUTCOME_DEADLINE_EXCEEDED";
    output: string;
}
/** Response from a single LLM call. */
export interface LLMResponse {
    text: string;
    usage: UsageStats;
    /** Original pi/ai AssistantMessage for multi-turn conversation fidelity. */
    piMessage?: PiAssistantMessage;
    /** Count of thought signatures in response (GROUP 2: multi-turn quality tracking). */
    thoughtSignatureCount?: number;
    /** Code execution results from Gemini (GROUP 5). */
    codeExecutionResults?: CodeExecutionResult[];
}
/**
 * Call pi/ai completeSimple with messages.
 * Tracks cost and time_ms per call. Optionally emits to a Logger.
 */
export declare function llmComplete(messages: ChatMessage[], modelConfig: ModelConfig, options?: {
    maxTokens?: number;
    signal?: AbortSignal;
    logger?: Logger;
    iteration?: number;
    cacheConfig?: CacheLLMConfig;
    thinkingLevel?: ThinkingLevel | null;
    outputSchema?: Record<string, unknown> | null;
    geminiConfig?: GeminiConfig;
}): Promise<LLMResponse>;
/**
 * Call pi/ai completeSimple for a single prompt (no conversation history).
 * Used for llm_query() sub-calls from the REPL.
 */
export declare function llmCompleteSimple(prompt: string, modelConfig: ModelConfig, signal?: AbortSignal): Promise<LLMResponse>;
/**
 * Run multiple llm_query calls concurrently.
 */
export declare function llmCompleteBatched(prompts: string[], modelConfig: ModelConfig, signal?: AbortSignal): Promise<{
    results: string[];
    usage: UsageStats;
}>;
/**
 * Spawn a child rlmx process for rlm_query() recursive sub-calls.
 * The child inherits the parent's cwd (and thus .md configs).
 */
export declare function rlmQuery(prompt: string, cwd: string, signal?: AbortSignal): Promise<string>;
/**
 * Run multiple rlm_query calls concurrently (max 4).
 */
export declare function rlmQueryBatched(prompts: string[], cwd: string, signal?: AbortSignal): Promise<string[]>;
/**
 * Handle an LLM IPC request from the Python REPL.
 * Routes to the appropriate handler based on request_type.
 * When geminiCounts is provided, increments Gemini-specific call counters.
 */
export declare function handleLLMRequest(request: LLMRequest, config: RlmxConfig, usage: UsageStats, signal?: AbortSignal, geminiCounts?: GeminiCallCounts, storage?: PgStorage): Promise<string[]>;
//# sourceMappingURL=llm.d.ts.map