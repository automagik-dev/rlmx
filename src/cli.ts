#!/usr/bin/env node

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, type ToolsLevel } from "./config.js";
import { isValidThinkingLevel, checkFutureFlags, type ThinkingLevel } from "./gemini.js";
import { scaffold, needsScaffold } from "./scaffold.js";
import { loadContext, loadContextFromStdin } from "./context.js";
import { rlmLoop } from "./rlm.js";
import { outputResult, buildStats, emitStats } from "./output.js";
import { createLogger } from "./logger.js";
import { checkPythonVersion } from "./detect.js";
import { estimateTokens, validateContextSize } from "./cache.js";
import { runBatch } from "./batch.js";
import { loadSettings, saveSettings, injectApiKeysToEnv, formatValue, parseSettingValue, getSettingsPath } from "./settings.js";

const HELP = `rlmx — RLM algorithm CLI for coding agents

Usage:
  rlmx "query" [options]          Run an RLM query
  rlmx init [--dir <path>]       Scaffold rlmx.yaml config
  rlmx cache [options]           Pre-warm cache or estimate context size
  rlmx batch <file> [options]    Bulk interrogation from questions file
  rlmx benchmark <mode> [options]  Run benchmarks (cost or oolong)

Options:
  --context <path>        Path to context (directory or file)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Directory for init command (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version

  --stats                 Emit JSON stats to stderr (or include in --output json)
  --log <path>            Write structured JSONL log to file
  --tools <level>         Tool level: core (default), standard, full
  --max-cost <n>          Maximum USD spend per run
  --max-tokens <n>        Maximum total tokens per run
  --max-depth <n>         Maximum recursive rlm_query depth
  --ext <list>            File extensions for context dirs (comma-separated)
  --thinking <level>      Thinking level: minimal, low, medium, high (Gemini 3)
  --cache                 Enable cache mode (full context in system prompt for provider caching)
  --no-session            Disable auto-save of session data
  --estimate              Show context size and cost estimate without caching (cache command)
  --parallel <n>          Concurrent questions for batch command (default: 1)
  --batch-api             Use Gemini Batch API for 50% cost reduction (batch command)

Config:
  rlmx.yaml               Single config file (run "rlmx init" to create)
  Fallback: SYSTEM.md, TOOLS.md, CRITERIA.md, MODEL.md (v0.1 compat)

Examples:
  rlmx "How does IPC work?" --context ./docs/
  rlmx "Summarize this" --context paper.md --output json --stats
  rlmx "Analyze code" --context ./src/ --tools full --ext .ts,.js
  rlmx "Quick question" --max-cost 0.10 --max-tokens 5000
  rlmx init --dir ./my-project
  echo "data" | rlmx "Analyze this" --log run.jsonl
  rlmx cache --context ./docs/ --estimate
  rlmx cache --context ./docs/
  rlmx batch questions.txt --context ./docs/ --cache --max-cost 1.00
  rlmx batch questions.txt --context ./src/ --max-iterations 3

  rlmx config set GEMINI_API_KEY <key>   Set API key
  rlmx config set model.provider google  Set default provider
  rlmx config get model.provider         Get a setting
  rlmx config list                       Show all settings
  rlmx config delete <key>               Remove a setting
  rlmx config path                       Show settings file path
`;

interface CliOptions {
  query: string | null;
  command: "query" | "init" | "help" | "version" | "cache" | "batch" | "config" | "benchmark";
  context: string | null;
  output: "text" | "json" | "stream";
  verbose: boolean;
  maxIterations: number;
  timeout: number;
  dir: string;
  stats: boolean;
  log: string | null;
  tools: ToolsLevel | null;
  maxCost: number | null;
  maxTokens: number | null;
  maxDepth: number | null;
  ext: string[] | null;
  thinking: ThinkingLevel | null;
  cache: boolean;
  estimate: boolean;
  batchFile: string | null;
  parallel: number;
  batchApi: boolean;
  noSession: boolean;
}

function parseCliArgs(args: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args,
    options: {
      context: { type: "string" },
      output: { type: "string", default: "text" },
      verbose: { type: "boolean", default: false },
      "max-iterations": { type: "string", default: "30" },
      timeout: { type: "string", default: "300000" },
      dir: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      stats: { type: "boolean", default: false },
      log: { type: "string" },
      tools: { type: "string" },
      "max-cost": { type: "string" },
      "max-tokens": { type: "string" },
      "max-depth": { type: "string" },
      ext: { type: "string" },
      thinking: { type: "string" },
      cache: { type: "boolean", default: false },
      estimate: { type: "boolean", default: false },
      parallel: { type: "string", default: "1" },
      "batch-api": { type: "boolean", default: false },
      "no-session": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    return {
      query: null, command: "help", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, ext: null, thinking: null, cache: false, estimate: false,
      batchFile: null, parallel: 1, batchApi: false, noSession: false,
    };
  }

  if (values.version) {
    return {
      query: null, command: "version", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, ext: null, thinking: null, cache: false, estimate: false,
      batchFile: null, parallel: 1, batchApi: false, noSession: false,
    };
  }

  const command = positionals[0] === "init" ? "init"
    : positionals[0] === "cache" ? "cache"
    : positionals[0] === "batch" ? "batch"
    : positionals[0] === "config" ? "config"
    : positionals[0] === "benchmark" ? "benchmark"
    : "query";
  const query = command === "query" ? positionals[0] ?? null : null;
  const batchFile = command === "batch" ? positionals[1] ?? null : null;
  const dir = (values.dir as string) || process.cwd();

  const outputMode = values.output as string;
  if (outputMode && !["text", "json", "stream"].includes(outputMode)) {
    console.error(`Error: --output must be text, json, or stream (got "${outputMode}")`);
    process.exit(1);
  }

  // Validate --tools
  const toolsRaw = values.tools as string | undefined;
  if (toolsRaw && !["core", "standard", "full"].includes(toolsRaw)) {
    console.error(`Error: --tools must be core, standard, or full (got "${toolsRaw}")`);
    process.exit(1);
  }

  // Validate --thinking
  const thinkingRaw = values.thinking as string | undefined;
  if (thinkingRaw && !isValidThinkingLevel(thinkingRaw)) {
    console.error(`Error: --thinking must be minimal, low, medium, or high (got "${thinkingRaw}")`);
    process.exit(1);
  }

  // Parse --ext
  const extRaw = values.ext as string | undefined;
  const ext = extRaw
    ? extRaw.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`))
    : null;

  return {
    query,
    command,
    context: (values.context as string) || null,
    output: (outputMode as "text" | "json" | "stream") || "text",
    verbose: values.verbose as boolean,
    maxIterations: parseInt(values["max-iterations"] as string, 10) || 30,
    timeout: parseInt(values.timeout as string, 10) || 300000,
    dir: resolve(dir),
    stats: values.stats as boolean,
    log: (values.log as string) || null,
    tools: (toolsRaw as ToolsLevel) || null,
    maxCost: values["max-cost"] ? parseFloat(values["max-cost"] as string) : null,
    maxTokens: values["max-tokens"] ? parseInt(values["max-tokens"] as string, 10) : null,
    maxDepth: values["max-depth"] ? parseInt(values["max-depth"] as string, 10) : null,
    ext,
    thinking: (thinkingRaw as ThinkingLevel) || null,
    cache: values.cache as boolean,
    estimate: values.estimate as boolean,
    batchFile,
    parallel: parseInt(values.parallel as string, 10) || 1,
    batchApi: values["batch-api"] as boolean,
    noSession: values["no-session"] as boolean,
  };
}

async function runInit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const created = await scaffold(dir);
  if (created.length === 0) {
    console.log("Config already exists in", dir);
  } else {
    console.log(`Created ${created.join(", ")} in ${dir}`);
  }
}

async function runQuery(opts: CliOptions): Promise<void> {
  const configDir = process.cwd();
  const startTime = Date.now();

  // Check Python version at startup
  try {
    const pyVersion = await checkPythonVersion();
    if (!pyVersion.valid) {
      console.error(
        `Error: rlmx requires Python 3.10+, found ${pyVersion.version}.\n` +
        `Please upgrade Python and try again.`
      );
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Auto-scaffold on first run
  if (await needsScaffold(configDir)) {
    if (opts.verbose) {
      console.error("rlmx: auto-scaffolding config files...");
    }
    const created = await scaffold(configDir);
    if (opts.verbose && created.length > 0) {
      console.error(`  Created: ${created.join(", ")}`);
    }
  }

  // Load config
  const config = await loadConfig(configDir);

  // Apply CLI overrides to config
  if (opts.thinking) {
    config.gemini.thinkingLevel = opts.thinking;
  }
  if (opts.cache) {
    config.cache.enabled = true;
  }
  if (opts.tools) {
    config.toolsLevel = opts.tools;
  }

  // Warn about future flags
  const futureWarnings = checkFutureFlags(config.gemini);
  for (const w of futureWarnings) {
    console.error(`rlmx: ${w}`);
  }

  if (opts.maxCost !== null) {
    config.budget.maxCost = opts.maxCost;
  }
  if (opts.maxTokens !== null) {
    config.budget.maxTokens = opts.maxTokens;
  }
  if (opts.maxDepth !== null) {
    config.budget.maxDepth = opts.maxDepth;
  }

  // Set up logger
  const logger = createLogger(opts.log ?? undefined);
  logger.runStart({
    query: opts.query ?? "(stdin)",
    model: `${config.model.provider}/${config.model.model}`,
    tools_level: config.toolsLevel,
    context_type: opts.context ? "path" : "none",
  });

  // Load context if provided, with extension overrides
  let context = null;
  if (opts.context) {
    const contextPath = resolve(opts.context);
    const contextOpts = opts.ext
      ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
      : config.contextConfig
        ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
        : undefined;
    context = await loadContext(contextPath, contextOpts);
    if (opts.verbose) {
      console.error(`rlmx: loaded context — ${context.metadata}`);
    }
  }

  // Validate context size and auto-adjust cache/storage modes
  let storageMode = false;
  if (context) {
    const validation = validateContextSize(context, config.model.provider);
    if (!validation.valid) {
      // Context exceeds model limit — disable cache mode if it was enabled
      if (opts.cache || config.cache.enabled) {
        console.error(
          `rlmx: context exceeds model limit (~${validation.estimatedTokens.toLocaleString()} tokens > ${validation.limit.toLocaleString()}), disabling cache mode`
        );
        opts.cache = false;
        config.cache.enabled = false;
      }
      // Signal storage mode when enabled is 'auto' or 'always'
      if (config.storage.enabled === "auto" || config.storage.enabled === "always") {
        storageMode = true;
        console.error(
          `rlmx: storage mode activated for large context (~${validation.estimatedTokens.toLocaleString()} tokens)`
        );
      }
    }
  }

  // Read query from stdin if not provided as argument
  let query = opts.query;
  if (!query && !process.stdin.isTTY) {
    const stdinCtx = await loadContextFromStdin();
    query = stdinCtx.content as string;
  }

  if (!query) {
    console.error("Error: no query provided");
    process.exit(1);
  }

  // Run RLM loop
  const result = await rlmLoop(query, context, config, {
    maxIterations: opts.maxIterations,
    timeout: opts.timeout,
    verbose: opts.verbose,
    output: opts.output,
    cache: opts.cache,
    storageMode,
    logger,
  });

  const timeMs = Date.now() - startTime;

  // Log run end
  logger.runEnd({
    iterations: result.iterations,
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    total_cost: result.usage.totalCost,
    time_ms: timeMs,
    budget_hit: result.budgetHit ?? null,
    answer_length: result.answer.length,
  });
  logger.close();

  // Build stats if requested
  if (opts.stats) {
    const stats = buildStats(result, {
      time_ms: timeMs,
      tools_level: config.toolsLevel,
      budget_hit: result.budgetHit,
      run_id: logger.runId,
      cache_enabled: opts.cache,
      thinking_level: config.gemini.thinkingLevel ?? undefined,
      gemini_batteries_used: result.geminiBatteriesUsed,
      thought_signatures_circulated: result.geminiCounts?.thoughtSignatures,
      web_search_calls: result.geminiCounts?.webSearch,
      fetch_url_calls: result.geminiCounts?.fetchUrl,
      code_executions_server_side: result.geminiCounts?.codeExecutionsServerSide,
      image_generations: result.geminiCounts?.generateImage,
    });
    // For JSON output, stats are included in the response
    if (opts.output === "json") {
      outputResult(result, opts.output, stats);
    } else {
      outputResult(result, opts.output);
      emitStats(stats);
    }
  } else {
    outputResult(result, opts.output);
  }

  // Save session (unless --no-session)
  if (!opts.noSession) {
    try {
      const { saveSession } = await import("./session.js");
      await saveSession({
        runId: logger.runId,
        query: opts.query ?? "(stdin)",
        contextPath: opts.context,
        model: `${config.model.provider}/${config.model.model}`,
        answer: result.answer,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedTokens: result.usage.cacheReadTokens,
          totalCost: result.usage.totalCost,
          iterations: result.iterations,
          timeMs: timeMs,
          model: `${config.model.provider}/${config.model.model}`,
        },
        config: config as unknown as Record<string, unknown>,
        logPath: opts.log,
      });
    } catch (err: unknown) {
      console.error(`rlmx: session save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Exit with non-zero code on empty response abort (issue #14)
  if (result.budgetHit === "empty_responses") {
    process.exit(1);
  }
}

// Rough cost estimate per 1M input tokens by provider (USD)
const COST_PER_1M_INPUT: Record<string, number> = {
  anthropic: 3.0,    // Claude Sonnet ~$3/M input
  openai: 2.5,       // GPT-4o ~$2.50/M input
  google: 0.075,     // Gemini 2.0 Flash — very cheap
  "amazon-bedrock": 3.0,
};

async function runCache(opts: CliOptions): Promise<void> {
  if (!opts.context) {
    console.error("Error: --context is required for the cache command.");
    console.error("Usage: rlmx cache --context <path> [--estimate]");
    process.exit(1);
  }

  // Load config
  const configDir = process.cwd();
  const config = await loadConfig(configDir);

  // Apply CLI overrides
  if (opts.tools) {
    config.toolsLevel = opts.tools;
  }

  const provider = config.model.provider;
  const model = config.model.model;

  // Load context
  const contextPath = resolve(opts.context);
  const contextOpts = opts.ext
    ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
    : config.contextConfig
      ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
      : undefined;
  const context = await loadContext(contextPath, contextOpts);

  // Validate context size
  const validation = validateContextSize(context, provider);

  if (!validation.valid) {
    console.error(`Error: ${validation.message}`);
    process.exit(1);
  }

  // Estimate cost
  const costPer1M = COST_PER_1M_INPUT[provider] ?? 3.0;
  const estimatedCost = (validation.estimatedTokens / 1_000_000) * costPer1M;
  const ttl = config.cache.ttl ?? (config.cache.retention === "long" ? 3600 : 300);

  if (opts.estimate) {
    // Print stats and exit — no actual caching
    console.log("rlmx cache estimate");
    console.log("---");
    console.log(`  context:          ${opts.context}`);
    console.log(`  metadata:         ${context.metadata}`);
    console.log(`  estimated tokens: ${validation.estimatedTokens.toLocaleString()}`);
    console.log(`  provider limit:   ${validation.limit.toLocaleString()} tokens`);
    console.log(`  utilization:      ${((validation.estimatedTokens / validation.limit) * 100).toFixed(1)}%`);
    console.log(`  provider:         ${provider}`);
    console.log(`  model:            ${model}`);
    console.log(`  ttl:              ${ttl}s`);
    console.log(`  estimated cost:   $${estimatedCost.toFixed(4)}`);
    return;
  }

  // Warmup: run a minimal rlmLoop with cache enabled
  console.error(`rlmx: warming cache for ${opts.context} (~${validation.estimatedTokens.toLocaleString()} tokens)`);

  config.cache.enabled = true;

  try {
    await rlmLoop("warmup", context, config, {
      maxIterations: 1,
      timeout: opts.timeout,
      verbose: opts.verbose,
      output: "text",
      cache: true,
    });
  } catch {
    // Warmup may produce a minimal/empty result — that's OK
    // The goal is just to prime the provider's cache
  }

  console.error("rlmx: cache warmup complete");
  console.error(`  provider:         ${provider}`);
  console.error(`  model:            ${model}`);
  console.error(`  estimated tokens: ${validation.estimatedTokens.toLocaleString()}`);
  console.error(`  ttl:              ${ttl}s`);
  console.error(`  estimated cost:   $${estimatedCost.toFixed(4)}`);
}

async function runBatchCommand(opts: CliOptions): Promise<void> {
  if (!opts.batchFile) {
    console.error("Error: batch command requires a questions file path.");
    console.error("Usage: rlmx batch <questions.txt> [--context <path>] [--max-cost <n>]");
    process.exit(1);
  }

  const configDir = process.cwd();

  // Load config
  const config = await loadConfig(configDir);

  // Apply CLI overrides to config
  config.cache.enabled = true; // batch always uses cache
  if (opts.tools) {
    config.toolsLevel = opts.tools;
  }
  if (opts.maxCost !== null) {
    config.budget.maxCost = opts.maxCost;
  }
  if (opts.maxTokens !== null) {
    config.budget.maxTokens = opts.maxTokens;
  }
  if (opts.maxDepth !== null) {
    config.budget.maxDepth = opts.maxDepth;
  }

  // Load context if provided
  let context = null;
  if (opts.context) {
    const contextPath = resolve(opts.context);
    const contextOpts = opts.ext
      ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
      : config.contextConfig
        ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
        : undefined;
    context = await loadContext(contextPath, contextOpts);
    if (opts.verbose) {
      console.error(`rlmx batch: loaded context — ${context.metadata}`);
    }
  }

  // Validate context size and auto-adjust cache mode for batch
  let batchCache = true;
  if (context) {
    const validation = validateContextSize(context, config.model.provider);
    if (!validation.valid) {
      console.error(
        `rlmx: context exceeds model limit (~${validation.estimatedTokens.toLocaleString()} tokens > ${validation.limit.toLocaleString()}), disabling cache mode (using REPL externalization)`
      );
      batchCache = false;
      config.cache.enabled = false;
    }
  }

  if (opts.verbose) {
    console.error(`rlmx batch: processing ${opts.batchFile}`);
  }

  await runBatch(resolve(opts.batchFile), context, config, {
    maxIterations: opts.maxIterations,
    timeout: opts.timeout,
    verbose: opts.verbose,
    cache: batchCache,
    maxCost: opts.maxCost ?? undefined,
    parallel: opts.parallel,
  });
}

const CONFIG_HELP = `rlmx config — manage global settings

Usage:
  rlmx config set <key> <value>   Set a setting
  rlmx config get <key>           Get a setting value
  rlmx config list                Show all settings (API keys masked)
  rlmx config delete <key>        Remove a setting
  rlmx config path                Show settings file path

Keys:
  API keys:    GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, ...
  Model:       model.provider, model.model, model.sub_call_model
  Budget:      budget.max_cost, budget.max_tokens, budget.max_depth
  Gemini:      gemini.thinking_level, gemini.google_search, gemini.code_execution
  General:     tools_level, cache.retention

Settings file: ~/.rlmx/settings.json
`;

async function runConfig(args: string[]): Promise<void> {
  const action = args[0];
  const key = args[1];
  const value = args.slice(2).join(" ");

  switch (action) {
    case "set": {
      if (!key || !value) {
        console.error("Usage: rlmx config set <key> <value>");
        process.exit(1);
      }
      const settings = await loadSettings();
      settings[key] = parseSettingValue(value);
      await saveSettings(settings);
      console.log(`Set ${key} = ${formatValue(key, settings[key])}`);
      break;
    }

    case "get": {
      if (!key) {
        console.error("Usage: rlmx config get <key>");
        process.exit(1);
      }
      const settings = await loadSettings();
      if (!(key in settings)) {
        console.error(`Key "${key}" not found in settings.`);
        process.exit(1);
      }
      console.log(formatValue(key, settings[key]));
      break;
    }

    case "list": {
      const settings = await loadSettings();
      const keys = Object.keys(settings);
      if (keys.length === 0) {
        console.log("No settings configured. Use: rlmx config set <key> <value>");
        return;
      }
      for (const k of keys) {
        console.log(`${k} = ${formatValue(k, settings[k])}`);
      }
      break;
    }

    case "delete": {
      if (!key) {
        console.error("Usage: rlmx config delete <key>");
        process.exit(1);
      }
      const settings = await loadSettings();
      if (!(key in settings)) {
        console.error(`Key "${key}" not found in settings.`);
        process.exit(1);
      }
      delete settings[key];
      await saveSettings(settings);
      console.log(`Deleted ${key}`);
      break;
    }

    case "path":
      console.log(getSettingsPath());
      break;

    default:
      console.log(CONFIG_HELP);
      break;
  }
}

async function runBenchmarkCommand(opts: CliOptions, args: string[]): Promise<void> {
  const mode = args[0];
  const configDir = process.cwd();
  const config = await loadConfig(configDir);

  if (opts.tools) config.toolsLevel = opts.tools;

  if (mode === "cost") {
    const { runCostBenchmark, formatBenchmarkTable, saveBenchmarkResults } = await import("./benchmark.js");
    const outputIdx = args.indexOf("--output");
    const outputFormat = outputIdx >= 0 && args[outputIdx + 1] === "json" ? "json" as const : "table" as const;
    const results = await runCostBenchmark(config, { outputFormat });
    if (outputFormat === "json") {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.error(formatBenchmarkTable(results));
    }
    const savedPath = await saveBenchmarkResults(results);
    console.error(`Results saved to ${savedPath}`);
  } else if (mode === "oolong") {
    const samplesIdx = args.indexOf("--samples");
    const samples = samplesIdx >= 0 ? parseInt(args[samplesIdx + 1], 10) : 5;
    const idxArgIdx = args.indexOf("--idx");
    const idx = idxArgIdx >= 0 ? parseInt(args[idxArgIdx + 1], 10) : undefined;

    const { runOolongBenchmark, formatBenchmarkTable, saveBenchmarkResults } = await import("./benchmark.js");
    const results = await runOolongBenchmark(config, { samples, idx });
    console.error(formatBenchmarkTable(results));
    const savedPath = await saveBenchmarkResults(results);
    console.error(`Results saved to ${savedPath}`);
  } else {
    console.log(`rlmx benchmark — compare RLM vs direct LLM\n\nUsage:\n  rlmx benchmark cost                     Run cost benchmark with built-in dataset\n  rlmx benchmark cost --output json       Output results as JSON\n  rlmx benchmark oolong                   Run Oolong Synth (auto-installs HF datasets)\n  rlmx benchmark oolong --samples 5       Run N samples (default 5)\n  rlmx benchmark oolong --idx 42          Run specific sample by index`);
  }
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  // Load global settings and inject API keys before any command
  const globalSettings = await loadSettings();
  injectApiKeysToEnv(globalSettings);

  switch (opts.command) {
    case "help":
      console.log(HELP);
      break;

    case "version": {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      // dist/src/cli.js → ../../package.json
      const pkg = require("../../package.json");
      console.log(`rlmx v${pkg.version}`);
      break;
    }

    case "init":
      await runInit(opts.dir);
      break;

    case "cache":
      await runCache(opts);
      break;

    case "batch":
      await runBatchCommand(opts);
      break;

    case "config":
      await runConfig(process.argv.slice(3));
      break;

    case "benchmark":
      await runBenchmarkCommand(opts, process.argv.slice(3));
      break;

    case "query":
      if (!opts.query && process.stdin.isTTY) {
        console.log(HELP);
        process.exit(1);
      }
      await runQuery(opts);
      break;
  }
}

main().catch((err) => {
  console.error("rlmx error:", err.message);
  process.exit(1);
});
