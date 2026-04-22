/**
 * LLM client wrapper using pi/ai.
 *
 * Provides completeSimple wrapper, batched calls, IPC request handling
 * from the Python REPL, and rlm_query child process spawning.
 */
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import { buildGeminiOnPayload, isGoogleProvider } from "./gemini.js";
/** Create a fresh usage tracker. */
export function createUsage() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, llmCalls: 0 };
}
/** Create a fresh Gemini call counter. */
export function createGeminiCallCounts() {
    return { webSearch: 0, fetchUrl: 0, generateImage: 0, codeExecutionsServerSide: 0, thoughtSignatures: 0 };
}
/** Merge child usage into parent. */
export function mergeUsage(parent, child) {
    parent.inputTokens += child.inputTokens;
    parent.outputTokens += child.outputTokens;
    parent.cacheReadTokens += child.cacheReadTokens;
    parent.cacheWriteTokens += child.cacheWriteTokens;
    parent.totalCost += child.totalCost;
    parent.llmCalls += child.llmCalls;
}
/**
 * Resolve a pi/ai model, trying the exact ID first, then stripping the date suffix.
 */
function resolveModel(provider, modelId) {
    let model = getModel(provider, modelId);
    if (!model) {
        // Try stripping date suffix (e.g., "claude-sonnet-4-5-20250514" -> "claude-sonnet-4-5")
        const stripped = modelId.replace(/-\d{8}$/, "");
        if (stripped !== modelId) {
            model = getModel(provider, stripped);
        }
    }
    if (!model) {
        throw new Error(`Unknown model "${modelId}" for provider "${provider}". ` +
            `Try updating MODEL.md or check pi/ai supported models.`);
    }
    return model;
}
/**
 * Call pi/ai completeSimple with messages.
 * Tracks cost and time_ms per call. Optionally emits to a Logger.
 */
export async function llmComplete(messages, modelConfig, options) {
    const model = resolveModel(modelConfig.provider, modelConfig.model);
    const startTime = Date.now();
    const systemPrompt = messages.find((m) => m.role === "system")?.content;
    const piMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => {
        if (m.role === "user") {
            return {
                role: "user",
                content: m.content,
                timestamp: Date.now(),
            };
        }
        // For assistant messages from our history, we store full PiAssistantMessage
        // objects. If we have a raw ChatMessage (string content), wrap minimally.
        if (m.piMessage) {
            return m.piMessage;
        }
        // Fallback: construct a minimal assistant message for the API.
        // This happens when we synthesize assistant messages (e.g., forced final).
        return {
            role: "assistant",
            content: [{ type: "text", text: m.content }],
            api: "anthropic-messages",
            provider: modelConfig.provider,
            model: modelConfig.model,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
        };
    });
    // Build cache options for pi/ai when cache is enabled
    const cacheOpts = options?.cacheConfig?.enabled
        ? {
            cacheRetention: options.cacheConfig.retention,
            sessionId: options.cacheConfig.sessionId,
        }
        : {};
    // Build pi/ai options with thinking level and onPayload hook
    const piOptions = {
        maxTokens: options?.maxTokens ?? 16384,
        signal: options?.signal,
        ...cacheOpts,
    };
    // Add thinking level for Gemini
    if (options?.thinkingLevel) {
        piOptions.reasoning = options.thinkingLevel;
    }
    // Build onPayload hook for Gemini-specific features (media resolution, structured outputs, tools, etc.)
    if (isGoogleProvider(modelConfig.provider) && options?.geminiConfig) {
        const onPayload = buildGeminiOnPayload(options.geminiConfig, modelConfig.provider, options?.outputSchema);
        if (onPayload) {
            piOptions.onPayload = onPayload;
        }
    }
    const response = await completeSimple(model, {
        systemPrompt,
        messages: piMessages,
    }, piOptions);
    const timeMs = Date.now() - startTime;
    const inputTokens = response.usage?.input ?? 0;
    const outputTokens = response.usage?.output ?? 0;
    const cacheReadTokens = response.usage?.cacheRead ?? 0;
    const cacheWriteTokens = response.usage?.cacheWrite ?? 0;
    const usageRecord = response.usage;
    const cost = usageRecord?.cost != null
        ? usageRecord.cost?.total ?? 0
        : 0;
    // Single pass: extract text, count thought signatures, collect code execution results
    const textParts = [];
    let thoughtSignatureCount = 0;
    const codeExecutionResults = [];
    for (const block of response.content ?? []) {
        const b = block;
        if (b.type === "text") {
            textParts.push(block.text);
        }
        if (b.thinkingSignature || b.textSignature) {
            thoughtSignatureCount++;
        }
        if (b.type === "executionResult") {
            codeExecutionResults.push({
                code: b.code ?? "",
                outcome: (b.outcome ?? "OUTCOME_FAILED"),
                output: b.output ?? "",
            });
        }
    }
    const text = textParts.join("");
    // Emit to logger if provided
    if (options?.logger) {
        options.logger.llmCall({
            iteration: options.iteration ?? -1,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost,
            time_ms: timeMs,
        });
    }
    return {
        text,
        usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalCost: cost,
            llmCalls: 1,
        },
        piMessage: response,
        thoughtSignatureCount,
        codeExecutionResults: codeExecutionResults.length > 0 ? codeExecutionResults : undefined,
    };
}
/**
 * Call pi/ai completeSimple for a single prompt (no conversation history).
 * Used for llm_query() sub-calls from the REPL.
 */
export async function llmCompleteSimple(prompt, modelConfig, signal) {
    return llmComplete([{ role: "user", content: prompt }], modelConfig, { signal });
}
/**
 * Run multiple llm_query calls concurrently.
 */
export async function llmCompleteBatched(prompts, modelConfig, signal) {
    const responses = await Promise.all(prompts.map((p) => llmCompleteSimple(p, modelConfig, signal)));
    const usage = createUsage();
    const results = responses.map((r) => {
        mergeUsage(usage, r.usage);
        return r.text;
    });
    return { results, usage };
}
/**
 * Spawn a child rlmx process for rlm_query() recursive sub-calls.
 * The child inherits the parent's cwd (and thus .md configs).
 */
export async function rlmQuery(prompt, cwd, signal) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [process.argv[1], prompt, "--output", "json"], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
        });
        if (signal) {
            signal.addEventListener("abort", () => child.kill("SIGTERM"), {
                once: true,
            });
        }
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => {
            if (code !== 0) {
                resolve(`Error: child rlmx exited with code ${code}. ${stderr}`.trim());
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result.answer ?? stdout);
            }
            catch {
                resolve(stdout.trim() || `Error: empty response from child rlmx`);
            }
        });
        child.on("error", (err) => {
            resolve(`Error: failed to spawn child rlmx: ${err.message}`);
        });
    });
}
/**
 * Run multiple rlm_query calls concurrently (max 4).
 */
export async function rlmQueryBatched(prompts, cwd, signal) {
    const MAX_CONCURRENT = 4;
    const results = new Array(prompts.length);
    for (let i = 0; i < prompts.length; i += MAX_CONCURRENT) {
        const batch = prompts.slice(i, i + MAX_CONCURRENT);
        const batchResults = await Promise.all(batch.map((p) => rlmQuery(p, cwd, signal)));
        for (let j = 0; j < batchResults.length; j++) {
            results[i + j] = batchResults[j];
        }
    }
    return results;
}
/**
 * Handle an LLM IPC request from the Python REPL.
 * Routes to the appropriate handler based on request_type.
 * When geminiCounts is provided, increments Gemini-specific call counters.
 */
export async function handleLLMRequest(request, config, usage, signal, geminiCounts, storage) {
    const subCallModel = config.model.subCallModel
        ? { ...config.model, model: config.model.subCallModel }
        : config.model;
    switch (request.request_type) {
        case "llm_query": {
            const resp = await llmCompleteSimple(request.prompts[0], request.model ? { ...subCallModel, model: request.model } : subCallModel, signal);
            mergeUsage(usage, resp.usage);
            return [resp.text];
        }
        case "llm_query_batched": {
            const modelCfg = request.model
                ? { ...subCallModel, model: request.model }
                : subCallModel;
            const resp = await llmCompleteBatched(request.prompts, modelCfg, signal);
            mergeUsage(usage, resp.usage);
            return resp.results;
        }
        case "rlm_query": {
            const result = await rlmQuery(request.prompts[0], config.configDir, signal);
            return [result];
        }
        case "rlm_query_batched": {
            const results = await rlmQueryBatched(request.prompts, config.configDir, signal);
            return results;
        }
        case "web_search": {
            if (!isGoogleProvider(config.model.provider)) {
                return [
                    `Error: web_search() requires provider: google. Current provider: ${config.model.provider}`,
                ];
            }
            if (geminiCounts)
                geminiCounts.webSearch++;
            const wsResp = await llmComplete([{ role: "user", content: request.prompts[0] }], config.model, {
                signal,
                geminiConfig: { ...config.gemini, googleSearch: true },
            });
            mergeUsage(usage, wsResp.usage);
            return [wsResp.text];
        }
        case "fetch_url": {
            if (!isGoogleProvider(config.model.provider)) {
                return [
                    `Error: fetch_url() requires provider: google. Current provider: ${config.model.provider}`,
                ];
            }
            if (geminiCounts)
                geminiCounts.fetchUrl++;
            const fuResp = await llmComplete([{ role: "user", content: `Fetch and return the content from: ${request.prompts[0]}` }], config.model, {
                signal,
                geminiConfig: { ...config.gemini, urlContext: true },
            });
            mergeUsage(usage, fuResp.usage);
            return [fuResp.text];
        }
        case "generate_image": {
            if (!isGoogleProvider(config.model.provider)) {
                return [
                    `Error: generate_image() requires provider: google. Current provider: ${config.model.provider}`,
                ];
            }
            if (geminiCounts)
                geminiCounts.generateImage++;
            // Image generation via Gemini: send prompt to model with image generation instruction.
            // The model returns a text description or URL depending on capabilities.
            const igResp = await llmComplete([{ role: "user", content: `Generate an image based on this description: ${request.prompts[0]}` }], config.model, {
                signal,
                geminiConfig: config.gemini,
            });
            mergeUsage(usage, igResp.usage);
            return [igResp.text];
        }
        case "pg_search": {
            if (!storage)
                return [`Error: storage not available`];
            const params = JSON.parse(request.prompts[0]);
            const rows = await storage.search(params.pattern, params.limit);
            return [JSON.stringify(rows)];
        }
        case "pg_slice": {
            if (!storage)
                return [`Error: storage not available`];
            const params = JSON.parse(request.prompts[0]);
            const rows = await storage.slice(params.start, params.end);
            return [JSON.stringify(rows)];
        }
        case "pg_time": {
            if (!storage)
                return [`Error: storage not available`];
            const params = JSON.parse(request.prompts[0]);
            const rows = await storage.timeRange(params.from, params.to);
            return [JSON.stringify(rows)];
        }
        case "pg_count": {
            if (!storage)
                return [`Error: storage not available`];
            const cnt = await storage.count();
            return [JSON.stringify({ count: cnt })];
        }
        case "pg_query": {
            if (!storage)
                return [`Error: storage not available`];
            const params = JSON.parse(request.prompts[0]);
            const rows = await storage.query(params.sql);
            return [JSON.stringify(rows)];
        }
        default:
            return request.prompts.map(() => `Error: unknown request type "${request.request_type}"`);
    }
}
//# sourceMappingURL=llm.js.map