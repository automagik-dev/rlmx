/**
 * Output formatting for RLM results.
 *
 * Supports text, JSON, stream (JSONL), and verbose modes.
 * Stats output: --stats emits JSON to stderr, --output json --stats includes stats in response.
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

/** Stats data emitted via --stats. */
export interface StatsData {
  iterations: number;
  total_tokens: number;
  total_cost: number;
  time_ms: number;
  tools_level: string;
  batteries_used: string[];
  budget_hit: string | null;
  model: string;
  run_id: string;
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
 * Build a StatsData object from an RLMResult and run metadata.
 */
export function buildStats(
  result: RLMResult,
  meta: {
    time_ms: number;
    tools_level?: string;
    batteries_used?: string[];
    budget_hit?: string | null;
    run_id?: string;
  }
): StatsData {
  return {
    iterations: result.iterations,
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    total_cost: result.usage.totalCost,
    time_ms: meta.time_ms,
    tools_level: meta.tools_level ?? "core",
    batteries_used: meta.batteries_used ?? [],
    budget_hit: meta.budget_hit ?? null,
    model: result.model,
    run_id: meta.run_id ?? "",
  };
}

/**
 * Format and output the final RLM result to stdout.
 * When stats is provided and mode is "json", stats are included in the JSON response.
 */
export function outputResult(
  result: RLMResult,
  mode: "text" | "json" | "stream",
  stats?: StatsData
): void {
  switch (mode) {
    case "json":
      if (stats) {
        console.log(JSON.stringify({ ...result, stats }));
      } else {
        console.log(JSON.stringify(result));
      }
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
 * Emit stats as JSON to stderr.
 * Only called when --stats flag is present.
 */
export function emitStats(stats: StatsData): void {
  process.stderr.write(JSON.stringify(stats) + "\n");
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
