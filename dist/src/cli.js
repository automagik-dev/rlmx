#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { isValidThinkingLevel, checkFutureFlags } from "./gemini.js";
import { scaffold, needsScaffold } from "./scaffold.js";
import { loadContext, loadContextFromStdin } from "./context.js";
import { rlmLoop } from "./rlm.js";
import { outputResult, buildStats, emitStats } from "./output.js";
import { createLogger } from "./logger.js";
import { checkPythonVersion } from "./detect.js";
import { detectRtk } from "./rtk-detect.js";
import { validateContextSize } from "./cache.js";
import { runBatch } from "./batch.js";
import { loadSettings, saveSettings, injectApiKeysToEnv, formatValue, parseSettingValue, getSettingsPath } from "./settings.js";
/**
 * Apply model overrides from global settings (~/.rlmx/settings.json).
 * Priority: CLI flags > settings.json > rlmx.yaml > hardcoded defaults.
 *
 * This ensures `rlmx config set model.provider openai` actually takes effect
 * even when a local rlmx.yaml exists with its own model defaults.
 */
/** Module-level ref so helper functions can apply overrides without re-loading. */
let _globalSettings = {};
/**
 * Apply model overrides from global settings (~/.rlmx/settings.json).
 * Priority: CLI flags > settings.json > rlmx.yaml > hardcoded defaults.
 *
 * This ensures `rlmx config set model.provider openai` actually takes effect
 * even when a local rlmx.yaml exists with its own model defaults.
 */
function applySettingsModelOverrides(config, settings) {
    const s = settings ?? _globalSettings;
    const provider = s["model.provider"];
    const model = s["model.model"];
    const subCallModel = s["model.sub-call-model"];
    if (typeof provider === "string" && provider) {
        config.model.provider = provider;
    }
    if (typeof model === "string" && model) {
        config.model.model = model;
    }
    if (typeof subCallModel === "string" && subCallModel) {
        config.model.subCallModel = subCallModel;
    }
}
const HELP = `rlmx — RLM algorithm CLI for coding agents

Usage:
  rlmx "query" [options]          Run an RLM query
  rlmx init [--template default|code] [--dir <path>]  Scaffold .rlmx/ config
  rlmx cache [options]           Pre-warm cache or estimate context size
  rlmx batch <file> [options]    Bulk interrogation from questions file
  rlmx benchmark <mode> [options]  Run benchmarks (cost or oolong)
  rlmx stats [options]           Query run history and cost breakdowns
  rlmx doctor                    Health check: providers, RTK, config

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
  .rlmx/                   Config directory (run "rlmx init" to create)
    rlmx.yaml              Config (model, budget, context, storage, etc.)
    SYSTEM.md              System prompt
    CRITERIA.md            Output criteria
    TOOLS.md               Custom Python tools

Examples:
  rlmx "How does IPC work?" --context ./docs/
  rlmx "Summarize this" --context paper.md --output json --stats
  rlmx "Analyze code" --context ./src/ --tools full --ext .ts,.js
  rlmx "Quick question" --max-cost 0.10 --max-tokens 5000
  rlmx init --template code --dir ./my-project
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
function parseCliArgs(args) {
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
            template: { type: "string", default: "default" },
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
            batchFile: null, parallel: 1, batchApi: false, noSession: false, template: "default",
        };
    }
    if (values.version) {
        return {
            query: null, command: "version", context: null, output: "text",
            verbose: false, maxIterations: 30, timeout: 300000, dir: process.cwd(),
            stats: false, log: null, tools: null, maxCost: null, maxTokens: null,
            maxDepth: null, ext: null, thinking: null, cache: false, estimate: false,
            batchFile: null, parallel: 1, batchApi: false, noSession: false, template: "default",
        };
    }
    const command = positionals[0] === "init" ? "init"
        : positionals[0] === "cache" ? "cache"
            : positionals[0] === "batch" ? "batch"
                : positionals[0] === "config" ? "config"
                    : positionals[0] === "benchmark" ? "benchmark"
                        : positionals[0] === "stats" ? "stats"
                            : positionals[0] === "doctor" ? "doctor"
                                : "query";
    const query = command === "query" ? positionals[0] ?? null : null;
    const batchFile = command === "batch" ? positionals[1] ?? null : null;
    const dir = values.dir || process.cwd();
    const outputMode = values.output;
    if (outputMode && !["text", "json", "stream"].includes(outputMode)) {
        console.error(`Error: --output must be text, json, or stream (got "${outputMode}")`);
        process.exit(1);
    }
    // Validate --tools
    const toolsRaw = values.tools;
    if (toolsRaw && !["core", "standard", "full"].includes(toolsRaw)) {
        console.error(`Error: --tools must be core, standard, or full (got "${toolsRaw}")`);
        process.exit(1);
    }
    // Validate --thinking
    const thinkingRaw = values.thinking;
    if (thinkingRaw && !isValidThinkingLevel(thinkingRaw)) {
        console.error(`Error: --thinking must be minimal, low, medium, or high (got "${thinkingRaw}")`);
        process.exit(1);
    }
    // Parse --ext
    const extRaw = values.ext;
    const ext = extRaw
        ? extRaw.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`))
        : null;
    return {
        query,
        command,
        context: values.context || null,
        output: outputMode || "text",
        verbose: values.verbose,
        maxIterations: parseInt(values["max-iterations"], 10) || 30,
        timeout: parseInt(values.timeout, 10) || 300000,
        dir: resolve(dir),
        stats: values.stats,
        log: values.log || null,
        tools: toolsRaw || null,
        maxCost: values["max-cost"] ? parseFloat(values["max-cost"]) : null,
        maxTokens: values["max-tokens"] ? parseInt(values["max-tokens"], 10) : null,
        maxDepth: values["max-depth"] ? parseInt(values["max-depth"], 10) : null,
        ext,
        thinking: thinkingRaw || null,
        cache: values.cache,
        estimate: values.estimate,
        batchFile,
        parallel: parseInt(values.parallel, 10) || 1,
        batchApi: values["batch-api"],
        noSession: values["no-session"],
        template: values.template || "default",
    };
}
async function runInit(dir, template) {
    await mkdir(dir, { recursive: true });
    try {
        const created = await scaffold(dir, template);
        if (created.length === 0) {
            console.log("Config already exists in", dir);
        }
        else {
            console.log(`Created ${created.join(", ")} in .rlmx/ (${dir})`);
        }
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
async function runQuery(opts) {
    const configDir = process.cwd();
    const startTime = Date.now();
    // Check Python version at startup
    try {
        const pyVersion = await checkPythonVersion();
        if (!pyVersion.valid) {
            console.error(`Error: rlmx requires Python 3.10+, found ${pyVersion.version}.\n` +
                `Please upgrade Python and try again.`);
            process.exit(1);
        }
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    // Auto-scaffold on first run
    if (await needsScaffold(configDir)) {
        if (opts.verbose) {
            console.error("rlmx: auto-scaffolding config files...");
        }
        const created = await scaffold(configDir, "default");
        if (opts.verbose && created.length > 0) {
            console.error(`  Created: ${created.join(", ")}`);
        }
    }
    // Load config
    const config = await loadConfig(configDir);
    applySettingsModelOverrides(config);
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
                console.error(`rlmx: context exceeds model limit (~${validation.estimatedTokens.toLocaleString()} tokens > ${validation.limit.toLocaleString()}), disabling cache mode`);
                opts.cache = false;
                config.cache.enabled = false;
            }
            // Signal storage mode when enabled is 'auto' or 'always'
            if (config.storage.enabled === "auto" || config.storage.enabled === "always") {
                storageMode = true;
                console.error(`rlmx: storage mode activated for large context (~${validation.estimatedTokens.toLocaleString()} tokens)`);
            }
        }
    }
    // Force storage mode when explicitly set to 'always'
    if (config.storage.enabled === "always" && !storageMode) {
        storageMode = true;
        if (opts.verbose) {
            console.error("rlmx: storage mode forced (storage.enabled: always)");
        }
    }
    // Read query from stdin if not provided as argument
    let query = opts.query;
    if (!query && !process.stdin.isTTY) {
        const stdinCtx = await loadContextFromStdin();
        query = stdinCtx.content;
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
        }
        else {
            outputResult(result, opts.output);
            emitStats(stats);
        }
    }
    else {
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
                config: config,
                logPath: opts.log,
            });
        }
        catch (err) {
            console.error(`rlmx: session save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Exit with non-zero code on empty response abort (issue #14)
    if (result.budgetHit === "empty_responses") {
        process.exit(1);
    }
}
// Rough cost estimate per 1M input tokens by provider (USD)
const COST_PER_1M_INPUT = {
    anthropic: 3.0, // Claude Sonnet ~$3/M input
    openai: 2.5, // GPT-4o ~$2.50/M input
    google: 0.075, // Gemini 2.0 Flash — very cheap
    "amazon-bedrock": 3.0,
};
async function runCache(opts) {
    if (!opts.context) {
        console.error("Error: --context is required for the cache command.");
        console.error("Usage: rlmx cache --context <path> [--estimate]");
        process.exit(1);
    }
    // Load config
    const configDir = process.cwd();
    const config = await loadConfig(configDir);
    applySettingsModelOverrides(config);
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
    }
    catch {
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
async function runBatchCommand(opts) {
    if (!opts.batchFile) {
        console.error("Error: batch command requires a questions file path.");
        console.error("Usage: rlmx batch <questions.txt> [--context <path>] [--max-cost <n>]");
        process.exit(1);
    }
    const configDir = process.cwd();
    // Load config
    const config = await loadConfig(configDir);
    applySettingsModelOverrides(config);
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
    // Validate context size and auto-adjust cache/storage mode for batch
    let batchCache = true;
    let batchStorageMode = false;
    if (context) {
        const validation = validateContextSize(context, config.model.provider);
        if (!validation.valid) {
            console.error(`rlmx: context exceeds model limit (~${validation.estimatedTokens.toLocaleString()} tokens > ${validation.limit.toLocaleString()}), disabling cache mode`);
            batchCache = false;
            config.cache.enabled = false;
            if (config.storage.enabled === "auto" || config.storage.enabled === "always") {
                batchStorageMode = true;
                console.error(`rlmx: storage mode activated for batch (~${validation.estimatedTokens.toLocaleString()} tokens)`);
            }
        }
    }
    // Force storage mode when explicitly set to 'always'
    if (config.storage.enabled === "always" && !batchStorageMode) {
        batchStorageMode = true;
    }
    if (opts.verbose) {
        console.error(`rlmx batch: processing ${opts.batchFile}`);
    }
    await runBatch(resolve(opts.batchFile), context, config, {
        maxIterations: opts.maxIterations,
        timeout: opts.timeout,
        verbose: opts.verbose,
        cache: batchCache,
        storageMode: batchStorageMode,
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
async function runConfig(args) {
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
async function runBenchmarkCommand(opts, args) {
    const mode = args[0];
    const configDir = process.cwd();
    const config = await loadConfig(configDir);
    applySettingsModelOverrides(config);
    if (opts.tools)
        config.toolsLevel = opts.tools;
    if (mode === "cost") {
        const { runCostBenchmark, formatBenchmarkTable, saveBenchmarkResults } = await import("./benchmark.js");
        const outputIdx = args.indexOf("--output");
        const outputFormat = outputIdx >= 0 && args[outputIdx + 1] === "json" ? "json" : "table";
        const results = await runCostBenchmark(config, { outputFormat });
        if (outputFormat === "json") {
            console.log(JSON.stringify(results, null, 2));
        }
        else {
            console.error(formatBenchmarkTable(results));
        }
        const savedPath = await saveBenchmarkResults(results);
        console.error(`Results saved to ${savedPath}`);
    }
    else if (mode === "oolong") {
        const samplesIdx = args.indexOf("--samples");
        const samples = samplesIdx >= 0 ? parseInt(args[samplesIdx + 1], 10) : 5;
        const idxArgIdx = args.indexOf("--idx");
        const idx = idxArgIdx >= 0 ? parseInt(args[idxArgIdx + 1], 10) : undefined;
        const { runOolongBenchmark, formatBenchmarkTable, saveBenchmarkResults } = await import("./benchmark.js");
        const results = await runOolongBenchmark(config, { samples, idx });
        console.error(formatBenchmarkTable(results));
        const savedPath = await saveBenchmarkResults(results);
        console.error(`Results saved to ${savedPath}`);
    }
    else {
        console.log(`rlmx benchmark — compare RLM vs direct LLM\n\nUsage:\n  rlmx benchmark cost                     Run cost benchmark with built-in dataset\n  rlmx benchmark cost --output json       Output results as JSON\n  rlmx benchmark oolong                   Run Oolong Synth (auto-installs HF datasets)\n  rlmx benchmark oolong --samples 5       Run N samples (default 5)\n  rlmx benchmark oolong --idx 42          Run specific sample by index`);
    }
}
/**
 * rlmx doctor — report health of providers, RTK, and config.
 *
 * Exit codes:
 *   0 = all nominal
 *   1 = at least one provider API key is missing (warning)
 *   2 = rtk.enabled=always but rtk is not installed (error)
 */
async function runDoctor() {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    // dist/src/cli.js → ../../package.json
    const pkg = require("../../package.json");
    // Load config from cwd (falls back to defaults if no .rlmx/rlmx.yaml)
    const configDir = process.cwd();
    const config = await loadConfig(configDir);
    applySettingsModelOverrides(config);
    // Detect RTK (cached for process lifetime)
    const rtk = await detectRtk();
    // Settings file presence
    const settingsPath = getSettingsPath();
    const { access } = await import("node:fs/promises");
    let settingsExists = false;
    try {
        await access(settingsPath);
        settingsExists = true;
    }
    catch {
        // missing
    }
    // Active template — inferred from whether .rlmx exists; we report the default
    // the user selects at init (wish scope: print template only when determinable).
    // With no easy on-disk marker, we just show "default" as the library default.
    const activeTemplate = config.configSource === "yaml" ? "(from rlmx.yaml)" : "default";
    // Provider key status — mirrors settings.ENV_KEY_MAP
    const providerKeys = [
        { label: "google   ", envVar: "GEMINI_API_KEY" },
        { label: "openai   ", envVar: "OPENAI_API_KEY" },
        { label: "anthropic", envVar: "ANTHROPIC_API_KEY" },
        { label: "groq     ", envVar: "GROQ_API_KEY" },
        { label: "xai      ", envVar: "XAI_API_KEY" },
        { label: "openrouter", envVar: "OPENROUTER_API_KEY" },
    ];
    let anyKeyMissing = false;
    for (const { envVar } of providerKeys) {
        if (!process.env[envVar])
            anyKeyMissing = true;
    }
    // RTK mode text
    const rtkMode = config.rtk.enabled;
    let rtkModeText;
    if (rtkMode === "always") {
        rtkModeText = rtk.available ? "always (enabled)" : "always (MISSING — error)";
    }
    else if (rtkMode === "never") {
        rtkModeText = "never (disabled)";
    }
    else {
        rtkModeText = rtk.available ? "auto (enabled)" : "auto (disabled)";
    }
    // ─── Output ────────────────────────────────────────────
    console.log(`rlmx ${pkg.version}`);
    console.log(`node: ${process.version}`);
    console.log("");
    console.log("LLM providers:");
    for (const { label, envVar } of providerKeys) {
        const set = Boolean(process.env[envVar]);
        console.log(`  ${label} : ${envVar} set (${set ? "yes" : "no"})`);
    }
    console.log("");
    console.log("RTK (token optimizer):");
    console.log(`  installed : ${rtk.available ? "yes" : "no"}`);
    if (rtk.available) {
        console.log(`  version   : ${rtk.version ?? "(unknown)"}`);
        if (rtk.path)
            console.log(`  path      : ${rtk.path}`);
    }
    console.log(`  mode      : ${rtkModeText}`);
    console.log("");
    console.log("Config:");
    console.log(`  ${settingsPath} (${settingsExists ? "exists" : "missing"})`);
    console.log(`  Active template: ${activeTemplate}`);
    // ─── Exit code ────────────────────────────────────────
    // Exit 2 — rtk.enabled=always but rtk is absent (error, overrides warning)
    if (rtkMode === "always" && !rtk.available) {
        console.error("");
        console.error("Error: rlmx config: rtk.enabled=always but rtk is not installed on PATH.");
        process.exit(2);
    }
    // Exit 1 — at least one provider API key missing (warning)
    if (anyKeyMissing) {
        process.exit(1);
    }
    // Exit 0 — nominal
}
async function main() {
    const opts = parseCliArgs(process.argv.slice(2));
    // Load global settings and inject API keys before any command
    const globalSettings = await loadSettings();
    _globalSettings = globalSettings;
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
            await runInit(opts.dir, opts.template);
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
        case "stats": {
            const { runStatsCommand } = await import("./stats.js");
            await runStatsCommand(process.argv.slice(3));
            break;
        }
        case "doctor":
            await runDoctor();
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
//# sourceMappingURL=cli.js.map