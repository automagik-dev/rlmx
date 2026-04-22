/**
 * Core RLM iteration loop.
 *
 * Faithful implementation of the RLM algorithm:
 * - Prompt externalization (context as REPL variable, only metadata in messages)
 * - Python REPL with persistent namespace
 * - Iterative code generation + execution loop
 * - FINAL/FINAL_VAR termination detection
 * - Recursive sub-calls via llm_query/rlm_query
 */
import type { RlmxConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
import { type RLMResult } from "./output.js";
import type { Logger } from "./logger.js";
/** Options for the RLM loop. */
export interface RLMOptions {
    maxIterations: number;
    timeout: number;
    verbose: boolean;
    output: "text" | "json" | "stream";
    cache: boolean;
    /** When true, route context through pgserve storage instead of REPL variable. */
    storageMode?: boolean;
    logger?: Logger;
}
/**
 * Main RLM loop entry point.
 */
export declare function rlmLoop(query: string, context: LoadedContext | null, config: RlmxConfig, options?: Partial<RLMOptions>): Promise<RLMResult>;
//# sourceMappingURL=rlm.d.ts.map