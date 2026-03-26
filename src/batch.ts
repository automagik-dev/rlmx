/**
 * Batch processing engine for bulk interrogation against cached corpus.
 *
 * Reads questions from a file (one per line), runs each through rlmLoop
 * with cache enabled, and outputs JSONL to stdout with per-question results
 * and a final aggregate stats line.
 */

import { readFile } from "node:fs/promises";
import { rlmLoop, type RLMOptions } from "./rlm.js";
import type { RlmxConfig } from "./config.js";
import type { LoadedContext } from "./context.js";

interface BatchResult {
  question: string;
  answer: string;
  stats: {
    iterations: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
}

interface BatchAggregate {
  type: "aggregate";
  total_questions: number;
  completed: number;
  total_cost: number;
  cache_savings: number;
}

export interface BatchOptions extends Partial<RLMOptions> {
  maxCost?: number;
  parallel?: number;
}

/**
 * Run a batch of questions from a file against the RLM loop.
 *
 * Each question is run with cache enabled so context is shared across all
 * questions via provider-level prompt caching. Results are emitted as JSONL
 * to stdout (one JSON object per line), with a final aggregate stats line.
 */
export async function runBatch(
  questionsFile: string,
  context: LoadedContext | null,
  config: RlmxConfig,
  options: BatchOptions = {}
): Promise<void> {
  // Read questions from file (one per line, skip empty lines and comments)
  const content = await readFile(questionsFile, "utf-8");
  const questions = content
    .split("\n")
    .map((q) => q.trim())
    .filter((q) => q.length > 0 && !q.startsWith("#"));

  if (questions.length === 0) {
    console.error("rlmx batch: no questions found in file");
    process.exit(1);
  }

  let totalCost = 0;
  let totalCacheReadTokens = 0;
  let completed = 0;

  for (const question of questions) {
    // Check budget — stop if cumulative cost exceeds maxCost
    if (options.maxCost && totalCost >= options.maxCost) {
      console.error(
        `rlmx batch: budget exceeded ($${totalCost.toFixed(4)} >= $${options.maxCost.toFixed(4)}), stopping after ${completed}/${questions.length} questions`
      );
      break;
    }

    // Run each question through rlmLoop with cache enabled
    const result = await rlmLoop(question, context, config, {
      maxIterations: options.maxIterations,
      timeout: options.timeout,
      verbose: options.verbose,
      output: "text", // batch always captures text internally
      cache: true, // batch always uses cache
    });

    totalCost += result.usage.totalCost;
    totalCacheReadTokens += result.usage.cacheReadTokens;
    completed++;

    // Output JSONL line for this question
    const line: BatchResult = {
      question,
      answer: result.answer,
      stats: {
        iterations: result.iterations,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cost: result.usage.totalCost,
      },
    };
    console.log(JSON.stringify(line));
  }

  // Estimate cache savings: cache read tokens are ~10x cheaper than regular input tokens
  // Savings = cacheReadTokens * 0.9 * (costPerInputToken)
  // Simplified: we report the raw cache read tokens and let the user interpret
  const cacheSavings = totalCacheReadTokens > 0
    ? totalCost * (totalCacheReadTokens / (totalCacheReadTokens + 1)) * 0.9
    : 0;

  // Final aggregate line
  const aggregate: BatchAggregate = {
    type: "aggregate",
    total_questions: questions.length,
    completed,
    total_cost: totalCost,
    cache_savings: Math.round(cacheSavings * 10000) / 10000,
  };
  console.log(JSON.stringify(aggregate));
}
