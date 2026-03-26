#!/usr/bin/env node

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, type ToolsLevel } from "./config.js";
import { scaffold, needsScaffold } from "./scaffold.js";
import { loadContext, loadContextFromStdin } from "./context.js";
import { rlmLoop } from "./rlm.js";
import { outputResult, buildStats, emitStats } from "./output.js";
import { createLogger } from "./logger.js";
import { checkPythonVersion } from "./detect.js";

const HELP = `rlmx — RLM algorithm CLI for coding agents

Usage:
  rlmx "query" [options]          Run an RLM query
  rlmx init [--dir <path>]       Scaffold rlmx.yaml config

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
`;

interface CliOptions {
  query: string | null;
  command: "query" | "init" | "help" | "version";
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
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    return {
      query: null, command: "help", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, ext: null,
    };
  }

  if (values.version) {
    return {
      query: null, command: "version", context: null, output: "text",
      verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
      stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
      maxDepth: null, ext: null,
    };
  }

  const command = positionals[0] === "init" ? "init" : "query";
  const query = command === "query" ? positionals[0] ?? null : null;
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
  } catch (err: any) {
    console.error(err.message);
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
    const contextOpts = opts.ext ? { extensions: opts.ext } : undefined;
    context = await loadContext(contextPath, contextOpts);
    if (opts.verbose) {
      console.error(`rlmx: loaded context — ${context.metadata}`);
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
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

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
