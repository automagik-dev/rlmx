import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
// ─── Defaults ────────────────────────────────────────────
const DEFAULT_MODEL = {
    provider: "google",
    model: "gemini-3.1-flash-lite-preview",
};
const DEFAULT_BUDGET = {
    maxCost: null,
    maxTokens: null,
    maxDepth: null,
};
const DEFAULT_CACHE_CONFIG = {
    enabled: false,
    strategy: "full",
    retention: "long",
};
const DEFAULT_CONTEXT_CONFIG = {
    extensions: [".md"],
    exclude: ["node_modules", ".git", "dist"],
};
const DEFAULT_GEMINI_CONFIG = {
    thinkingLevel: null,
    googleSearch: false,
    urlContext: false,
    codeExecution: false,
    mediaResolution: null,
    computerUse: false,
    mapsGrounding: false,
    fileSearch: false,
};
const DEFAULT_OUTPUT_CONFIG = {
    schema: null,
};
export const DEFAULT_STORAGE_CONFIG = {
    enabled: "auto",
    mode: "persistent",
    dataDir: "~/.rlmx/data",
    port: 0,
    chunkSize: null,
    chunkUtilization: 0.6,
    charsPerToken: 4,
};
export const DEFAULT_RTK_CONFIG = {
    enabled: "auto",
};
// ─── File Helpers ────────────────────────────────────────
/**
 * Try to read a file, returning null if it doesn't exist.
 */
async function readOptionalFile(path) {
    try {
        return await readFile(path, "utf-8");
    }
    catch {
        return null;
    }
}
/**
 * Validate a budget value is a positive number or null.
 */
function validatePositiveBudget(value, field) {
    if (value !== null && (typeof value !== "number" || value <= 0)) {
        throw new Error(`Invalid ${field}: must be a positive number or null, got ${value}.`);
    }
}
// ─── Tools.md Parsing ────────────────────────────────────
/**
 * Parse TOOLS.md format:
 *   ## tool_name
 *   ```python
 *   def tool_name(...):
 *       ...
 *   ```
 */
export function parseToolsMd(content) {
    const tools = [];
    const headingRegex = /^## (.+)$/gm;
    const codeBlockRegex = /```python\s*\n([\s\S]*?)```/g;
    let headingMatch;
    const headings = [];
    while ((headingMatch = headingRegex.exec(content)) !== null) {
        headings.push({ name: headingMatch[1].trim(), index: headingMatch.index });
    }
    for (let i = 0; i < headings.length; i++) {
        const start = headings[i].index;
        const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
        const section = content.slice(start, end);
        const codeMatch = codeBlockRegex.exec(section);
        codeBlockRegex.lastIndex = 0;
        if (codeMatch) {
            tools.push({
                name: headings[i].name,
                code: codeMatch[1].trim(),
            });
        }
    }
    return tools;
}
// ─── YAML Parsing ────────────────────────────────────────
/**
 * Parse and validate an rlmx.yaml file.
 */
function parseYamlConfig(content, dir) {
    let raw;
    try {
        raw = yaml.load(content);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid YAML in rlmx.yaml: ${msg}\n` +
            `Hint: check for indentation errors or unquoted special characters.`);
    }
    if (raw === null || raw === undefined || typeof raw !== "object") {
        throw new Error(`rlmx.yaml is empty or not a YAML mapping.\n` +
            `Expected a YAML object with keys like model, context, budget, etc.`);
    }
    const cfg = raw;
    // Parse model
    const model = {
        provider: cfg.model?.provider ?? DEFAULT_MODEL.provider,
        model: cfg.model?.model ?? DEFAULT_MODEL.model,
    };
    if (cfg.model?.["sub-call-model"]) {
        model.subCallModel = cfg.model["sub-call-model"];
    }
    // Parse context config
    const contextConfig = {
        extensions: cfg.context?.extensions ?? DEFAULT_CONTEXT_CONFIG.extensions,
        exclude: cfg.context?.exclude ?? DEFAULT_CONTEXT_CONFIG.exclude,
    };
    // Validate and normalize extensions format
    for (let i = 0; i < contextConfig.extensions.length; i++) {
        const ext = contextConfig.extensions[i];
        if (typeof ext !== "string") {
            throw new Error(`Invalid extension in context.extensions: expected string, got ${typeof ext}.`);
        }
        // Ensure leading dot: "mdx" → ".mdx"
        if (ext.length > 0 && !ext.startsWith(".")) {
            contextConfig.extensions[i] = `.${ext}`;
        }
    }
    // Parse budget
    const budget = {
        maxCost: cfg.budget?.["max-cost"] ?? DEFAULT_BUDGET.maxCost,
        maxTokens: cfg.budget?.["max-tokens"] ?? DEFAULT_BUDGET.maxTokens,
        maxDepth: cfg.budget?.["max-depth"] ?? DEFAULT_BUDGET.maxDepth,
    };
    // Validate budget values
    validatePositiveBudget(budget.maxCost, "budget.max-cost");
    validatePositiveBudget(budget.maxTokens, "budget.max-tokens");
    validatePositiveBudget(budget.maxDepth, "budget.max-depth");
    // Parse tools-level
    const rawLevel = cfg["tools-level"] ?? "core";
    if (!["core", "standard", "full"].includes(rawLevel)) {
        throw new Error(`Invalid tools-level "${rawLevel}" in rlmx.yaml. Must be one of: core, standard, full.`);
    }
    const toolsLevel = rawLevel;
    // Parse cache config
    const rawRetention = cfg.cache?.retention ?? "long";
    if (rawRetention && !["short", "long"].includes(rawRetention)) {
        throw new Error(`Invalid cache.retention "${rawRetention}" in rlmx.yaml. Must be one of: short, long.`);
    }
    const rawStrategy = cfg.cache?.strategy ?? "full";
    if (rawStrategy && rawStrategy !== "full") {
        throw new Error(`Invalid cache.strategy "${rawStrategy}" in rlmx.yaml. Only "full" is currently supported.`);
    }
    const cache = {
        enabled: cfg.cache?.enabled ?? DEFAULT_CACHE_CONFIG.enabled,
        strategy: rawStrategy,
        retention: rawRetention,
    };
    if (cfg.cache?.["session-prefix"]) {
        cache.sessionPrefix = cfg.cache["session-prefix"];
    }
    if (cfg.cache?.ttl !== undefined) {
        cache.ttl = cfg.cache.ttl;
    }
    if (cfg.cache?.["expire-time"]) {
        cache.expireTime = cfg.cache["expire-time"];
    }
    // Parse gemini config
    const gemini = {
        thinkingLevel: cfg.gemini?.["thinking-level"] ?? DEFAULT_GEMINI_CONFIG.thinkingLevel,
        googleSearch: cfg.gemini?.["google-search"] ?? DEFAULT_GEMINI_CONFIG.googleSearch,
        urlContext: cfg.gemini?.["url-context"] ?? DEFAULT_GEMINI_CONFIG.urlContext,
        codeExecution: cfg.gemini?.["code-execution"] ?? DEFAULT_GEMINI_CONFIG.codeExecution,
        mediaResolution: cfg.gemini?.["media-resolution"] ?? DEFAULT_GEMINI_CONFIG.mediaResolution,
        computerUse: cfg.gemini?.["computer-use"] ?? DEFAULT_GEMINI_CONFIG.computerUse,
        mapsGrounding: cfg.gemini?.["maps-grounding"] ?? DEFAULT_GEMINI_CONFIG.mapsGrounding,
        fileSearch: cfg.gemini?.["file-search"] ?? DEFAULT_GEMINI_CONFIG.fileSearch,
    };
    // Validate thinking level if provided
    if (gemini.thinkingLevel !== null) {
        const validLevels = ["minimal", "low", "medium", "high"];
        if (!validLevels.includes(gemini.thinkingLevel)) {
            throw new Error(`Invalid gemini.thinking-level "${gemini.thinkingLevel}" in rlmx.yaml. ` +
                `Must be one of: minimal, low, medium, high.`);
        }
    }
    // Validate media resolution values if provided
    if (gemini.mediaResolution) {
        const validResolutions = ["low", "medium", "high", "auto"];
        for (const [key, value] of Object.entries(gemini.mediaResolution)) {
            if (value && !validResolutions.includes(value)) {
                throw new Error(`Invalid gemini.media-resolution.${key} "${value}" in rlmx.yaml. ` +
                    `Must be one of: low, medium, high, auto.`);
            }
        }
    }
    // Parse output config
    const output = {
        schema: cfg.output?.schema ?? DEFAULT_OUTPUT_CONFIG.schema,
    };
    // Validate output schema if provided
    if (output.schema !== null && typeof output.schema !== "object") {
        throw new Error(`Invalid output.schema in rlmx.yaml: must be a JSON Schema object or null.`);
    }
    // Parse storage config
    const rawEnabled = cfg.storage?.enabled ?? DEFAULT_STORAGE_CONFIG.enabled;
    if (!["auto", "always", "never"].includes(rawEnabled)) {
        throw new Error(`Invalid storage.enabled "${rawEnabled}" in rlmx.yaml. Must be one of: auto, always, never.`);
    }
    const rawMode = cfg.storage?.mode ?? DEFAULT_STORAGE_CONFIG.mode;
    if (!["persistent", "memory"].includes(rawMode)) {
        throw new Error(`Invalid storage.mode "${rawMode}" in rlmx.yaml. Must be one of: persistent, memory.`);
    }
    const storagePort = cfg.storage?.port ?? DEFAULT_STORAGE_CONFIG.port;
    if (typeof storagePort !== "number" || storagePort < 0 || !Number.isInteger(storagePort)) {
        throw new Error(`Invalid storage.port in rlmx.yaml: must be a non-negative integer, got ${storagePort}.`);
    }
    const chunkSize = cfg.storage?.["chunk-size"] ?? DEFAULT_STORAGE_CONFIG.chunkSize;
    if (chunkSize !== null && (typeof chunkSize !== "number" || chunkSize <= 0)) {
        throw new Error(`Invalid storage.chunk-size in rlmx.yaml: must be a positive number or null, got ${chunkSize}.`);
    }
    const chunkUtilization = cfg.storage?.["chunk-utilization"] ?? DEFAULT_STORAGE_CONFIG.chunkUtilization;
    if (typeof chunkUtilization !== "number" || chunkUtilization <= 0 || chunkUtilization > 1) {
        throw new Error(`Invalid storage.chunk-utilization in rlmx.yaml: must be a number between 0 (exclusive) and 1 (inclusive), got ${chunkUtilization}.`);
    }
    const charsPerToken = cfg.storage?.["chars-per-token"] ?? DEFAULT_STORAGE_CONFIG.charsPerToken;
    if (typeof charsPerToken !== "number" || charsPerToken <= 0) {
        throw new Error(`Invalid storage.chars-per-token in rlmx.yaml: must be a positive number, got ${charsPerToken}.`);
    }
    const storage = {
        enabled: rawEnabled,
        mode: rawMode,
        dataDir: cfg.storage?.["data-dir"] ?? DEFAULT_STORAGE_CONFIG.dataDir,
        port: storagePort,
        chunkSize,
        chunkUtilization,
        charsPerToken,
    };
    // Parse rtk config
    const rawRtkEnabled = cfg.rtk?.enabled ?? DEFAULT_RTK_CONFIG.enabled;
    if (!["auto", "always", "never"].includes(rawRtkEnabled)) {
        throw new Error(`Invalid rtk.enabled "${rawRtkEnabled}" in rlmx.yaml. Must be one of: auto, always, never.`);
    }
    const rtk = {
        enabled: rawRtkEnabled,
    };
    return {
        model,
        configDir: dir,
        budget,
        contextConfig,
        toolsLevel,
        cache,
        gemini,
        output,
        storage,
        rtk,
        configSource: "yaml",
    };
}
/**
 * Build a config from defaults only (no files).
 */
function defaultConfig(dir) {
    return {
        system: null,
        tools: [],
        criteria: null,
        model: { ...DEFAULT_MODEL },
        configDir: dir,
        budget: { ...DEFAULT_BUDGET },
        contextConfig: { ...DEFAULT_CONTEXT_CONFIG },
        toolsLevel: "core",
        cache: { ...DEFAULT_CACHE_CONFIG },
        gemini: { ...DEFAULT_GEMINI_CONFIG },
        output: { ...DEFAULT_OUTPUT_CONFIG },
        storage: { ...DEFAULT_STORAGE_CONFIG },
        rtk: { ...DEFAULT_RTK_CONFIG },
        configSource: "defaults",
    };
}
// ─── Main loader ─────────────────────────────────────────
/**
 * Load rlmx config from .rlmx/ directory:
 *   1. .rlmx/rlmx.yaml (required for yaml source)
 *   2. .rlmx/SYSTEM.md (auto-loaded when present)
 *   3. .rlmx/CRITERIA.md (auto-loaded when present)
 *   4. .rlmx/TOOLS.md (auto-loaded and parsed when present)
 *   5. Defaults if no .rlmx/rlmx.yaml
 */
export async function loadConfig(dir) {
    const rlmxDir = join(dir, ".rlmx");
    // Try .rlmx/rlmx.yaml
    const yamlContent = await readOptionalFile(join(rlmxDir, "rlmx.yaml"));
    if (yamlContent !== null) {
        const partial = parseYamlConfig(yamlContent, dir);
        // Auto-load .md files from .rlmx/
        const [systemRaw, criteriaRaw, toolsRaw] = await Promise.all([
            readOptionalFile(join(rlmxDir, "SYSTEM.md")),
            readOptionalFile(join(rlmxDir, "CRITERIA.md")),
            readOptionalFile(join(rlmxDir, "TOOLS.md")),
        ]);
        const system = systemRaw?.trim() || null;
        const criteria = criteriaRaw?.trim() || null;
        const tools = toolsRaw ? parseToolsMd(toolsRaw) : [];
        return {
            ...partial,
            system,
            criteria,
            tools,
        };
    }
    // No .rlmx/rlmx.yaml — return defaults
    return defaultConfig(dir);
}
/**
 * Check if any config exists in a directory.
 * Only checks .rlmx/rlmx.yaml.
 */
export async function hasConfig(dir) {
    return (await readOptionalFile(join(dir, ".rlmx", "rlmx.yaml"))) !== null;
}
//# sourceMappingURL=config.js.map