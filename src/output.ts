/**
 * Output formatting for RLM results.
 *
 * Supports text, JSON, stream (JSONL), and verbose modes.
 */

import type { UsageStats } from "./llm.js";

/** The full result returned by an RLM run. */
export interface RLMResult {
  answer: string;
  references: string[];
  usage: UsageStats;
  iterations: number;
  model: string;
}

/** Stream event emitted during iteration. */
export interface StreamEvent {
  type: "iteration" | "final";
  iteration?: number;
  code?: string;
  stdout?: string;
  answer?: string;
  references?: string[];
  usage?: UsageStats;
  iterations?: number;
  model?: string;
}

/**
 * Format and output the final RLM result to stdout.
 */
export function outputResult(
  result: RLMResult,
  mode: "text" | "json" | "stream"
): void {
  switch (mode) {
    case "json":
      console.log(JSON.stringify(result));
      break;

    case "stream":
      // In stream mode, the final event is emitted here
      console.log(
        JSON.stringify({
          type: "final",
          answer: result.answer,
          references: result.references,
          usage: result.usage,
          iterations: result.iterations,
          model: result.model,
        })
      );
      break;

    case "text":
    default:
      console.log(result.answer);
      break;
  }
}

/**
 * Emit a stream event (JSONL) for an iteration.
 */
export function emitStreamEvent(event: StreamEvent): void {
  console.log(JSON.stringify(event));
}

/**
 * Log verbose iteration progress to stderr.
 */
export function logVerbose(iteration: number, message: string): void {
  process.stderr.write(`rlmx [iter ${iteration}]: ${message}\n`);
}
