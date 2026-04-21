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

import { randomUUID } from "node:crypto";
import type { RlmxConfig, ToolDef } from "./config.js";
import type { LoadedContext, ContextItem } from "./context.js";
import { buildCachedSystemPrompt, computeContentHash, buildSessionId, estimateTokens } from "./cache.js";
import { REPL } from "./repl.js";
import { PgStorage } from "./storage.js";
import { ObservabilityRecorder } from "./observe.js";
import {
  llmComplete,
  handleLLMRequest,
  createUsage,
  createGeminiCallCounts,
  mergeUsage,
  type ChatMessage,
  type UsageStats,
  type CacheLLMConfig,
  type GeminiCallCounts,
} from "./llm.js";
import {
  extractCodeBlocks,
  detectFinal,
  formatIterationResult,
  type ExecutionResult,
} from "./parser.js";
import { emitStreamEvent, logVerbose, type RLMResult } from "./output.js";
import { BudgetTracker } from "./budget.js";
import { isGoogleProvider } from "./gemini.js";
import { detectRtk } from "./rtk-detect.js";
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

const DEFAULT_OPTIONS: RLMOptions = {
  maxIterations: 30,
  timeout: 300_000,
  verbose: false,
  output: "text",
  cache: false,
};

/**
 * Check if structured output mode is active.
 * Structured output is when output.schema is set and provider is Google (Gemini).
 */
function isStructuredOutputMode(config: RlmxConfig): boolean {
  return config.output.schema !== null && isGoogleProvider(config.model.provider);
}

/**
 * Build the system prompt from config, tools, criteria, and context metadata.
 */
function buildSystemPrompt(
  config: RlmxConfig,
  _context: LoadedContext | null,
  storageRecordCount?: number
): string {
  // Use SYSTEM.md content or paper default (from scaffold)
  let system = config.system ?? "";

  // Inject custom tools section from TOOLS.md
  const customToolsSection = buildCustomToolsSection(config.tools);
  if (system.includes("{custom_tools_section}")) {
    system = system.replace("{custom_tools_section}", customToolsSection);
  } else if (customToolsSection) {
    system += "\n\n" + customToolsSection;
  }

  // Append CRITERIA.md content if present
  if (config.criteria) {
    system +=
      "\n\n## Output Criteria\n\nWhen providing your FINAL answer, follow these criteria:\n" +
      config.criteria;
  }

  // Append storage mode instructions when context is in PostgreSQL
  if (storageRecordCount !== undefined) {
    system +=
      `\n\n## Context Storage\n\n` +
      `Context is stored in PostgreSQL (~${storageRecordCount.toLocaleString()} records). Use these tools to query it:\n` +
      `- pg_search("pattern") — full-text search\n` +
      `- pg_slice(start, end) — get lines by range\n` +
      `- pg_time("HH:MM", "HH:MM") — filter by timestamp\n` +
      `- pg_count() — total records\n` +
      `- pg_query("SQL") — raw SQL (read-only)\n` +
      `Do NOT try to access the \`context\` variable directly — it is not loaded in memory.`;
  }

  return system;
}

/**
 * Build the custom tools section from TOOLS.md definitions.
 */
function buildCustomToolsSection(tools: ToolDef[]): string {
  if (tools.length === 0) return "";

  const lines = [
    "\nYou also have access to these additional custom REPL functions:",
  ];

  for (const tool of tools) {
    // Extract docstring from the code if present
    const docMatch = tool.code.match(/"""([\s\S]*?)"""|'''([\s\S]*?)'''/);
    const doc = docMatch ? (docMatch[1] || docMatch[2]).trim() : "";

    lines.push(`- \`${tool.name}()\`${doc ? `: ${doc}` : ""}`);
  }

  return lines.join("\n");
}

/**
 * Build the context metadata string that goes in the message history.
 * The actual context data is externalized into the REPL as the `context` variable.
 */
function buildContextMetadata(context: LoadedContext | null): string {
  if (!context) {
    return "No context was provided for this query. You can still use the REPL to reason and compute.";
  }
  return context.metadata;
}

/**
 * Build the user prompt for a given iteration.
 * Iteration 0 has a safeguard to prevent premature FINAL.
 */
function buildUserPrompt(
  query: string,
  iteration: number,
  contextMetadata: string
): string {
  if (iteration === 0) {
    const safeguard =
      "You have not interacted with the REPL environment or seen your prompt / context yet. " +
      "Your next action should be to look through and figure out how to answer the prompt, " +
      "so don't just provide a final answer yet.\n\n";
    return `${safeguard}${contextMetadata}\n\nQuery: ${query}`;
  }

  return (
    "The history before is your previous interactions with the REPL environment. " +
    `Continue working towards answering the query. If you have enough information, provide your final answer using FINAL().\n\nQuery: ${query}`
  );
}

/**
 * Prepare the context for REPL injection.
 * For list contexts, build the context as a list of dicts with path and content.
 */
function prepareReplContext(
  context: LoadedContext | null
): string | Array<{ path: string; content: string }> | undefined {
  if (!context) return undefined;

  if (context.type === "list") {
    const items = context.content as ContextItem[];
    return items.map((item) => ({ path: item.path, content: item.content }));
  }

  return context.content as string;
}

/**
 * Main RLM loop entry point.
 */
export async function rlmLoop(
  query: string,
  context: LoadedContext | null,
  config: RlmxConfig,
  options: Partial<RLMOptions> = {}
): Promise<RLMResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const usage = createUsage();
  const geminiCounts = createGeminiCallCounts();
  const budget = new BudgetTracker(config.budget);

  // ── Storage mode setup ──────────────────────────────────
  let storage: PgStorage | undefined;
  let recorder: ObservabilityRecorder | undefined;
  let storageRecordCount: number | undefined;
  const runId = randomUUID();

  if (opts.storageMode) {
    storage = new PgStorage();
    await storage.start(config.storage);

    // Ingest context into Postgres
    if (context) {
      storageRecordCount = await storage.ingest(context);
      if (opts.verbose) {
        process.stderr.write(`rlmx: ingested ${storageRecordCount} records into pgserve storage\n`);
      }
    }

    // Set up observability recorder
    recorder = new ObservabilityRecorder(storage);
    recorder.startSession(
      runId,
      query,
      `${config.model.provider}/${config.model.model}`,
      config.model.provider,
      undefined,
      config as unknown as Record<string, unknown>
    );
  }

  // Build system prompt — cache mode embeds full context, storage mode adds pg_* tools, normal mode uses metadata only
  const systemPrompt = opts.cache
    ? buildCachedSystemPrompt(config, context)
    : buildSystemPrompt(config, context, storageRecordCount);

  // In storage mode, override context metadata to describe storage
  const contextMetadata = opts.storageMode && storageRecordCount !== undefined
    ? `Context is stored in PostgreSQL (~${storageRecordCount.toLocaleString()} records). Use pg_search(), pg_slice(), pg_time(), pg_count(), pg_query() to query it.`
    : buildContextMetadata(context);

  // Build cache config for LLM calls (passed through to pi/ai completeSimple)
  let cacheConfig: CacheLLMConfig | undefined;
  if (opts.cache && context) {
    const contentHash = computeContentHash(context);
    const sessionId = buildSessionId(config.cache.sessionPrefix, contentHash);
    cacheConfig = {
      enabled: true,
      retention: config.cache.retention,
      sessionId,
    };

    // Emit cache_init log event
    if (opts.logger) {
      opts.logger.cacheInit({
        contentHash,
        sessionId,
        estimatedTokens: estimateTokens(context),
      });
    }
  }

  // Prepare abort controller for timeout
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, opts.timeout);

  const repl = new REPL();

  try {
    // Start REPL — in storage mode, skip raw context injection and load pg_batteries
    const replContext = opts.storageMode ? undefined : prepareReplContext(context);
    const toolsMap: Record<string, string> = {};
    for (const tool of config.tools) {
      toolsMap[tool.name] = tool.code;
    }

    // Resolve RTK mode once per run. `always` without an install is a config error.
    const rtk = await detectRtk();
    if (config.rtk.enabled === "always" && !rtk.available) {
      throw new Error(
        "rlmx config: rtk.enabled=always but rtk is not installed on PATH."
      );
    }
    const rtkEnabled =
      config.rtk.enabled === "always" ||
      (config.rtk.enabled === "auto" && rtk.available);

    if (rtkEnabled && opts.verbose) {
      const v = rtk.version ?? "unknown";
      process.stderr.write(
        `[rtk:auto] RTK ${v} detected — CLI subprocesses via run_cli() will auto-prefix rtk.\n`
      );
    }

    await repl.start({
      context: replContext as string | string[] | Record<string, unknown>,
      tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      loadGeminiBatteries: isGoogleProvider(config.model.provider) && (config.toolsLevel === "standard" || config.toolsLevel === "full"),
      loadPgBatteries: !!opts.storageMode,
      toolsLevel: config.toolsLevel,
      rtkEnabled,
    });

    // Set up LLM request handler for REPL IPC — pass storage for pg_* routes
    repl.onLLMRequest(async (request) => {
      const startMs = Date.now();
      const results = await handleLLMRequest(
        request,
        config,
        usage,
        abortController.signal,
        geminiCounts,
        storage
      );
      // Record sub-calls to observability
      if (recorder && request.request_type !== "llm_query" && request.request_type !== "llm_query_batched") {
        recorder.recordSubCall(
          0, // iteration not available here; will be approximate
          request.request_type,
          request.prompts[0]?.slice(0, 200) ?? "",
          Date.now() - startMs
        );
      }
      return results;
    });

    /** Cleanup timeout/REPL/storage and build the final result. */
    const finalize = async (answer: string, iterations: number): Promise<RLMResult> => {
      clearTimeout(timeoutHandle);
      // Record final observability event
      if (recorder) {
        recorder.recordFinal(answer, iterations, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cacheReadTokens,
          totalCost: usage.totalCost,
        });
      }
      await repl.stop();
      if (storage) await storage.stop();
      return buildResult(answer, usage, iterations, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed());
    };

    // Build initial message history
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: buildUserPrompt(query, 0, contextMetadata),
      },
    ];

    // Iteration loop
    let actualIterations = 0;
    let consecutiveEmpty = 0;
    let emptyAbort = false;
    for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
      // Check timeout
      if (abortController.signal.aborted) {
        if (opts.verbose) logVerbose(iteration, "timeout reached");
        break;
      }

      // Check budget
      if (budget.isExceeded()) {
        if (opts.verbose) logVerbose(iteration, `budget exceeded: ${budget.getState().budgetHit}`);
        break;
      }
      actualIterations = iteration + 1;

      if (opts.verbose) {
        logVerbose(iteration, "calling LLM...");
      }

      // Call LLM
      const llmStartMs = Date.now();
      const response = await llmComplete(messages, config.model, {
        signal: abortController.signal,
        cacheConfig,
        thinkingLevel: config.gemini.thinkingLevel,
        outputSchema: config.output.schema,
        geminiConfig: config.gemini,
      });
      const llmDurationMs = Date.now() - llmStartMs;
      mergeUsage(usage, response.usage);
      budget.record(response.usage.inputTokens, response.usage.outputTokens, response.usage.totalCost);

      // Record LLM call to observability
      if (recorder) {
        recorder.recordLLMCall(
          iteration,
          { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cost: response.usage.totalCost },
          `${config.model.provider}/${config.model.model}`,
          llmDurationMs
        );
      }

      // Track thought signatures for Gemini stats
      if (response.thoughtSignatureCount) {
        geminiCounts.thoughtSignatures += response.thoughtSignatureCount;
      }

      const responseText = response.text;

      if (opts.verbose) {
        logVerbose(
          iteration,
          `LLM responded (${responseText.length} chars, ${response.usage.inputTokens}+${response.usage.outputTokens} tokens)`
        );
      }

      // Check for empty LLM response (issue #14)
      // Thinking-only responses (output tokens > 0 but no visible text) are normal
      // for reasoning models warming up — don't count as empty.
      if (responseText.length === 0) {
        if (response.usage.outputTokens > 0) {
          // Thinking-only iteration — model is reasoning, not stuck
          consecutiveEmpty = 0;
          if (opts.verbose) {
            logVerbose(iteration, "thinking-only response (no visible text yet)");
          }
        } else {
          // Truly empty — no thinking, no text
          consecutiveEmpty++;
          process.stderr.write(
            `rlmx [iter ${iteration}]: WARNING — LLM returned empty response. Possible context size limit.\n`
          );
          if (consecutiveEmpty >= 3) {
            emptyAbort = true;
            break;
          }
        }
      } else {
        consecutiveEmpty = 0;
      }

      // Extract code blocks
      const codeBlocks = extractCodeBlocks(responseText);

      // In structured output mode, treat the API response as the final answer (schema-enforced JSON)
      if (isStructuredOutputMode(config) && codeBlocks.length === 0) {
        if (opts.verbose) {
          logVerbose(iteration, "structured output mode: response is final answer");
        }
        return finalize(responseText, iteration + 1);
      }

      // Check for FINAL signal in the text (outside code blocks)
      const finalSignal = detectFinal(responseText, codeBlocks);

      if (finalSignal && codeBlocks.length === 0) {
        if (finalSignal.type === "final") {
          return finalize(finalSignal.value, iteration + 1);
        }
        // FINAL_VAR without code — get variable value before stopping REPL
        const varResult = await getVariableFromRepl(repl, finalSignal.value);
        return finalize(varResult ?? finalSignal.value, iteration + 1);
      }

      // Execute code blocks in REPL
      const executions: ExecutionResult[] = [];

      for (const block of codeBlocks) {
        if (opts.verbose) {
          logVerbose(iteration, `executing code (${block.code.length} chars)`);
        }

        const execStartMs = Date.now();
        const execResult = await repl.execute(block.code);
        const execDurationMs = Date.now() - execStartMs;

        executions.push({
          code: block.code,
          stdout: execResult.stdout,
          stderr: execResult.stderr ?? "",
          variables: execResult.variables,
          error: execResult.error,
        });

        // Record REPL execution to observability
        if (recorder) {
          recorder.recordReplExec(
            iteration, block.code, execResult.stdout, execResult.stderr ?? "",
            execDurationMs, !!execResult.error
          );
        }

        if (execResult.final) {
          return finalize(execResult.final.value, iteration + 1);
        }
      }

      // Handle server-side code execution results from Gemini (GROUP 5)
      // These are executed by Gemini's code_execution tool and returned in the response
      if (response.codeExecutionResults && response.codeExecutionResults.length > 0) {
        geminiCounts.codeExecutionsServerSide += response.codeExecutionResults.length;
        if (opts.verbose) {
          logVerbose(iteration, `received ${response.codeExecutionResults.length} server-side execution results`);
        }

        // Treat server execution results as execution results for the conversation
        for (const result of response.codeExecutionResults) {
          executions.push({
            code: result.code,
            stdout: result.output,
            stderr: result.outcome === "OUTCOME_OK" ? "" : `Execution failed: ${result.outcome}`,
            variables: [],
            error: result.outcome === "OUTCOME_OK" ? undefined : `${result.outcome}`,
          });
        }
      }

      // Handle FINAL signal detected in text, after code execution
      if (finalSignal) {
        if (finalSignal.type === "final") {
          return finalize(finalSignal.value, iteration + 1);
        }
        // FINAL_VAR — variable should now exist after code execution
        const varExec = await repl.execute(
          `__final_val = str(${finalSignal.value}) if '${finalSignal.value}' in dir() else "Variable '${finalSignal.value}' not found"`
        );
        if (varExec.final) {
          return finalize(varExec.final.value, iteration + 1);
        }
        const getResult = await repl.execute(
          `FINAL_VAR("${finalSignal.value}")`
        );
        if (getResult.final) {
          return finalize(getResult.final.value, iteration + 1);
        }
      }

      // Format execution results and append to history
      const formattedResult = formatIterationResult(executions);

      // Append assistant message (with full pi/ai message for multi-turn)
      messages.push({
        role: "assistant",
        content: responseText,
        piMessage: response.piMessage,
      });

      // Append execution result as user message
      if (executions.length > 0) {
        messages.push({
          role: "user",
          content: formattedResult,
        });
      } else {
        // No code blocks — prompt the model to use the REPL
        messages.push({
          role: "user",
          content:
            "You didn't write any REPL code in your last response. Please use ```repl``` code blocks to interact with the REPL environment and work towards answering the query.",
        });
      }

      // Soft iteration limit: nudge LLM to wrap up when approaching max
      const remaining = opts.maxIterations - iteration - 1;
      if (opts.maxIterations >= 5 && remaining <= 2 && remaining > 0) {
        if (opts.verbose) {
          logVerbose(iteration, `soft limit: ${remaining} iteration(s) remaining, nudging LLM to wrap up`);
        }
        const nudge = remaining === 2
          ? "\n\nNote: You have 2 iterations remaining. Start wrapping up your analysis and prepare your final answer."
          : "\n\nNote: This is your LAST iteration. Provide your final answer NOW using FINAL().";
        // Append nudge to the last user message
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "user") {
          lastMsg.content += nudge;
        }
      }

      // Emit stream event if in stream mode
      if (opts.output === "stream") {
        emitStreamEvent({
          type: "iteration",
          iteration,
          code: codeBlocks.map((b) => b.code).join("\n\n"),
          stdout: executions.map((e) => e.stdout).join("\n"),
        });
      }

    }

    // Loop exited — check reason and handle accordingly
    if (emptyAbort) {
      // Aborted due to consecutive empty responses (issue #14)
      process.stderr.write(
        `rlmx: 3 consecutive empty LLM responses — aborting. Context may exceed API limits.\n`
      );
      clearTimeout(timeoutHandle);
      if (recorder) recorder.recordError("empty_responses");
      await repl.stop();
      if (storage) await storage.stop();

      return buildResult(
        "Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.",
        usage,
        actualIterations,
        config,
        "empty_responses",
        geminiCounts,
        repl.getGeminiBatteriesUsed()
      );
    }

    // Force a final answer for normal loop exit
    if (opts.verbose) {
      const reason = budget.isExceeded() ? "budget exceeded" : abortController.signal.aborted ? "timeout" : "max iterations reached";
      logVerbose(actualIterations, `${reason}, forcing final answer`);
    }

    const forcedResult = await forceFinalAnswer(messages, config, usage, abortController.signal, cacheConfig);
    return finalize(forcedResult, actualIterations);
  } catch (err: unknown) {
    clearTimeout(timeoutHandle);
    if (recorder) recorder.recordError(err instanceof Error ? err.message : String(err));
    await repl.stop().catch(() => {});
    if (storage) await storage.stop().catch(() => {});

    if ((err instanceof Error && err.name === "AbortError") || abortController.signal.aborted) {
      return buildResult(
        "Error: RLM query timed out",
        usage,
        0,
        config,
        budget.getState().budgetHit,
        geminiCounts,
        repl.getGeminiBatteriesUsed()
      );
    }

    throw err;
  }
}

/**
 * Force the LLM to produce a final answer when max iterations are reached.
 */
async function forceFinalAnswer(
  messages: ChatMessage[],
  config: RlmxConfig,
  usage: UsageStats,
  signal?: AbortSignal,
  cacheConfig?: CacheLLMConfig
): Promise<string> {
  const forceMessages: ChatMessage[] = [
    ...messages,
    {
      role: "user",
      content:
        "You have reached the maximum number of iterations. Please provide your best final answer NOW based on what you've learned so far. Respond with just the answer, no FINAL() wrapper needed.",
    },
  ];

  const response = await llmComplete(forceMessages, config.model, {
    signal,
    cacheConfig,
    thinkingLevel: config.gemini.thinkingLevel,
    outputSchema: config.output.schema,
    geminiConfig: config.gemini,
  });
  mergeUsage(usage, response.usage);
  return response.text;
}

/**
 * Try to get a variable value from the REPL (if still running).
 */
async function getVariableFromRepl(
  repl: REPL,
  varName: string
): Promise<string | null> {
  if (!repl.isRunning()) return null;
  try {
    const result = await repl.execute(`FINAL_VAR("${varName}")`);
    return result.final?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the final RLMResult.
 */
function buildResult(
  answer: string,
  usage: UsageStats,
  iterations: number,
  config: RlmxConfig,
  budgetHit?: string | null,
  geminiCounts?: GeminiCallCounts,
  geminiBatteriesUsed?: string[]
): RLMResult {
  // Extract file references from the answer (paths like docs/foo/bar.md)
  const refRegex = /(?:^|[\s(["'])([a-zA-Z0-9_./-]+\.(?:md|txt|py|ts|js|json))/gm;
  const refSet = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = refRegex.exec(answer)) !== null) {
    if (match[1]) refSet.add(match[1]);
  }
  const references = [...refSet];

  const result: RLMResult = {
    answer,
    references,
    usage,
    iterations,
    model: `${config.model.provider}/${config.model.model}`,
    budgetHit: budgetHit ?? null,
  };

  if (geminiCounts) {
    result.geminiCounts = geminiCounts;
  }
  if (geminiBatteriesUsed && geminiBatteriesUsed.length > 0) {
    result.geminiBatteriesUsed = geminiBatteriesUsed;
  }

  return result;
}
