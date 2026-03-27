#!/usr/bin/env node

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { scaffold, needsScaffold } from "./scaffold.js";
import { loadContext, loadContextFromStdin } from "./context.js";
import { rlmLoop } from "./rlm.js";
import { outputResult } from "./output.js";

const HELP = `rlmx — RLM algorithm CLI for coding agents

Usage:
  rlmx "query" [options]          Run an RLM query
  rlmx init [--dir <path>]       Scaffold .md config files

Options:
  --context <path>        Path to context (directory or file)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Directory for init command (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version

Config Files (.md in cwd):
  SYSTEM.md     System prompt (default: RLM paper prompt)
  CONTEXT.md    Context loading config
  TOOLS.md      Custom Python REPL tools
  CRITERIA.md   Output format criteria
  MODEL.md      LLM provider and model selection

Examples:
  rlmx "How does IPC work?" --context ./docs/
  rlmx "Summarize this" --context paper.md --output json
  rlmx init --dir ./my-project
  echo "data" | rlmx "Analyze this"
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
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    return {
      query: null,
      command: "help",
      context: null,
      output: "text",
      verbose: false,
      maxIterations: 30,
      timeout: 300000,
      dir: process.cwd(),
    };
  }

  if (values.version) {
    return {
      query: null,
      command: "version",
      context: null,
      output: "text",
      verbose: false,
      maxIterations: 30,
      timeout: 300000,
      dir: process.cwd(),
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

  return {
    query,
    command,
    context: (values.context as string) || null,
    output: (outputMode as "text" | "json" | "stream") || "text",
    verbose: values.verbose as boolean,
    maxIterations: parseInt(values["max-iterations"] as string, 10) || 30,
    timeout: parseInt(values.timeout as string, 10) || 300000,
    dir: resolve(dir),
  };
}

async function runInit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const created = await scaffold(dir);
  if (created.length === 0) {
    console.log("All config files already exist in", dir);
  } else {
    console.log(`Scaffolded ${created.length} config file(s) in ${dir}:`);
    for (const name of created) {
      console.log(`  ${name}`);
    }
  }
}

async function runQuery(opts: CliOptions): Promise<void> {
  const configDir = process.cwd();

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

  // Load context if provided
  let context = null;
  if (opts.context) {
    const contextPath = resolve(opts.context);
    context = await loadContext(contextPath);
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

  // Output result
  outputResult(result, opts.output);
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
      const pkg = require("../package.json");
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

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("rlmx error:", message);
  process.exit(1);
});
