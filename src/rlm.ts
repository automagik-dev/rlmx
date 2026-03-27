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

import type { RlmxConfig, ToolDef } from "./config.js";
import type { LoadedContext, ContextItem } from "./context.js";
import { buildCachedSystemPrompt, computeContentHash, buildSessionId, estimateTokens } from "./cache.js";
import { REPL } from "./repl.js";
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
import type { Logger } from "./logger.js";

/** Options for the RLM loop. */
export interface RLMOptions {
  maxIterations: number;
  timeout: number;
  verbose: boolean;
  output: "text" | "json" | "stream";
  cache: boolean;
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
  _context: LoadedContext | null
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

  // Build system prompt — cache mode embeds full context, normal mode uses metadata only
  const systemPrompt = opts.cache
    ? buildCachedSystemPrompt(config, context)
    : buildSystemPrompt(config, context);
  const contextMetadata = buildContextMetadata(context);

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
    // Start REPL with context and custom tools
    const replContext = prepareReplContext(context);
    const toolsMap: Record<string, string> = {};
    for (const tool of config.tools) {
      toolsMap[tool.name] = tool.code;
    }

    await repl.start({
      context: replContext as any,
      tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      loadGeminiBatteries: isGoogleProvider(config.model.provider) && (config.toolsLevel === "standard" || config.toolsLevel === "full"),
      toolsLevel: config.toolsLevel,
    });

    // Set up LLM request handler for REPL IPC
    repl.onLLMRequest(async (request) => {
      return handleLLMRequest(
        request,
        config,
        usage,
        abortController.signal,
        geminiCounts
      );
    });

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
      const response = await llmComplete(messages, config.model, {
        signal: abortController.signal,
        cacheConfig,
        thinkingLevel: config.gemini.thinkingLevel as any,
        outputSchema: config.output.schema,
        geminiConfig: config.gemini,
      });
      mergeUsage(usage, response.usage);
      budget.record(response.usage.inputTokens, response.usage.outputTokens, response.usage.totalCost);

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
      if (responseText.length === 0) {
        consecutiveEmpty++;
        process.stderr.write(
          `rlmx [iter ${iteration}]: WARNING — LLM returned empty response. Possible context size limit.\n`
        );
        if (consecutiveEmpty >= 3) {
          emptyAbort = true;
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      // Extract code blocks
      const codeBlocks = extractCodeBlocks(responseText);

      // In structured output mode, treat the API response as the final answer (schema-enforced JSON)
      if (isStructuredOutputMode(config) && codeBlocks.length === 0) {
        clearTimeout(timeoutHandle);
        await repl.stop();
        if (opts.verbose) {
          logVerbose(iteration, "structured output mode: response is final answer");
        }
        return buildResult(responseText, usage, iteration + 1, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed());
      }

      // Check for FINAL signal in the text (outside code blocks)
      const finalSignal = detectFinal(responseText, codeBlocks);

      if (finalSignal && codeBlocks.length === 0) {
        // FINAL without code blocks — direct answer
        clearTimeout(timeoutHandle);

        if (finalSignal.type === "final") {
          await repl.stop();
          return buildResult(finalSignal.value, usage, iteration + 1, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed());
        }
        // FINAL_VAR without code — get variable value before stopping REPL
        const varResult = await getVariableFromRepl(repl, finalSignal.value);
        await repl.stop();
        return buildResult(
          varResult ?? finalSignal.value,
          usage,
          iteration + 1,
          config,
          budget.getState().budgetHit,
          geminiCounts,
          repl.getGeminiBatteriesUsed()
        );
      }

      // Execute code blocks in REPL
      const executions: ExecutionResult[] = [];

      for (const block of codeBlocks) {
        if (opts.verbose) {
          logVerbose(iteration, `executing code (${block.code.length} chars)`);
        }

        const execResult = await repl.execute(block.code);

        executions.push({
          code: block.code,
          stdout: execResult.stdout,
          stderr: execResult.stderr ?? "",
          variables: execResult.variables,
          error: execResult.error,
        });

        // Check if this execution produced a FINAL signal
        if (execResult.final) {
          clearTimeout(timeoutHandle);
          await repl.stop();

          return buildResult(
            execResult.final.value,
            usage,
            iteration + 1,
            config,
            budget.getState().budgetHit,
            geminiCounts,
            repl.getGeminiBatteriesUsed()
          );
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

      // Check for FINAL_VAR in text after code execution
      if (finalSignal && finalSignal.type === "final_var") {
        // The variable should now exist in the REPL after code execution
        const varExec = await repl.execute(
          `__final_val = str(${finalSignal.value}) if '${finalSignal.value}' in dir() else "Variable '${finalSignal.value}' not found"`
        );
        if (varExec.final) {
          clearTimeout(timeoutHandle);
          await repl.stop();
          return buildResult(
            varExec.final.value,
            usage,
            iteration + 1,
            config,
            budget.getState().budgetHit,
            geminiCounts,
            repl.getGeminiBatteriesUsed()
          );
        }
        // Try getting variable directly
        const getResult = await repl.execute(
          `FINAL_VAR("${finalSignal.value}")`
        );
        if (getResult.final) {
          clearTimeout(timeoutHandle);
          await repl.stop();
          return buildResult(
            getResult.final.value,
            usage,
            iteration + 1,
            config,
            budget.getState().budgetHit,
            geminiCounts,
            repl.getGeminiBatteriesUsed()
          );
        }
      }

      // Also check for FINAL in the text portion after code
      if (finalSignal && finalSignal.type === "final") {
        clearTimeout(timeoutHandle);
        await repl.stop();
        return buildResult(finalSignal.value, usage, iteration + 1, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed());
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

      // Update user prompt for next iteration
      if (iteration + 1 < opts.maxIterations) {
        // For iteration > 0, the user prompt is the continuation
        // (already handled by the execution result above)
      }
    }

    // Loop exited — check reason and handle accordingly
    if (emptyAbort) {
      // Aborted due to consecutive empty responses (issue #14)
      process.stderr.write(
        `rlmx: 3 consecutive empty LLM responses — aborting. Context may exceed API limits.\n`
      );
      clearTimeout(timeoutHandle);
      await repl.stop();

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
    clearTimeout(timeoutHandle);
    await repl.stop();

    return buildResult(
      forcedResult,
      usage,
      actualIterations,
      config,
      budget.getState().budgetHit,
      geminiCounts,
      repl.getGeminiBatteriesUsed()
    );
  } catch (err: any) {
    clearTimeout(timeoutHandle);
    await repl.stop().catch(() => {});

    if (err.name === "AbortError" || abortController.signal.aborted) {
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
    thinkingLevel: config.gemini.thinkingLevel as any,
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
  const references: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = refRegex.exec(answer)) !== null) {
    const ref = match[1];
    if (ref && !references.includes(ref)) {
      references.push(ref);
    }
  }

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
