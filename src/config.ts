import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { ThinkingLevel } from "./gemini.js";

// ─── Interfaces ──────────────────────────────────────────

/** Parsed tool: name → Python code */
export interface ToolDef {
  name: string;
  code: string;
}

/** Model configuration */
export interface ModelConfig {
  provider: string;
  model: string;
  subCallModel?: string;
}

/** Budget limits (all optional — null means unlimited) */
export interface BudgetConfig {
  maxCost: number | null;
  maxTokens: number | null;
  maxDepth: number | null;
}

/** Cache configuration for CAG mode */
export interface CacheConfig {
  enabled: boolean;
  strategy: "full";
  sessionPrefix?: string;
  retention: "short" | "long";
  ttl?: number;       // seconds
  expireTime?: string; // ISO 8601
}

/** Context loading configuration */
export interface ContextConfig {
  extensions: string[];
  exclude: string[];
}

/** Media resolution configuration per content type */
export interface MediaResolutionConfig {
  images?: string;
  pdfs?: string;
  video?: string;
}

/** Gemini-specific configuration */
export interface GeminiConfig {
  thinkingLevel: ThinkingLevel | null;
  googleSearch: boolean;
  urlContext: boolean;
  codeExecution: boolean;
  mediaResolution: MediaResolutionConfig | null;
  computerUse: boolean;
  mapsGrounding: boolean;
  fileSearch: boolean;
}

/** Structured output schema configuration */
export interface OutputConfig {
  schema: Record<string, unknown> | null;
}

/** Storage configuration for pgserve-backed large context handling */
export interface StorageConfig {
  enabled: "auto" | "always" | "never";
  mode: "persistent" | "memory";
  dataDir: string;
  port: number;
  chunkSize: number | null;
  chunkUtilization: number;
  charsPerToken: number;
}

/** RTK (Rust Token Killer) integration config */
export interface RtkConfig {
  /**
   * auto   — use RTK when `which rtk` succeeds; fall through otherwise.
   * always — require RTK; throw at REPL startup if absent.
   * never  — disable the run_cli auto-prefix entirely.
   */
  enabled: "auto" | "always" | "never";
}

/** Tool level — controls which functions are available in the REPL */
export type ToolsLevel = "core" | "standard" | "full";

/** Full rlmx config */
export interface RlmxConfig {
  system: string | null;
  tools: ToolDef[];
  criteria: string | null;
  model: ModelConfig;
  /** Directory the config was loaded from */
  configDir: string;
  /** Budget limits */
  budget: BudgetConfig;
  /** Context loading settings */
  contextConfig: ContextConfig;
  /** Tool level */
  toolsLevel: ToolsLevel;
  /** Cache configuration for CAG mode */
  cache: CacheConfig;
  /** Gemini-specific configuration */
  gemini: GeminiConfig;
  /** Structured output configuration */
  output: OutputConfig;
  /** Storage configuration for pgserve */
  storage: StorageConfig;
  /** RTK (Rust Token Killer) integration */
  rtk: RtkConfig;
  /** Config source: "yaml" | "defaults" */
  configSource: "yaml" | "defaults";
}

// ─── Defaults ────────────────────────────────────────────

const DEFAULT_MODEL: ModelConfig = {
  provider: "google",
  model: "gemini-3.1-flash-lite-preview",
};

const DEFAULT_BUDGET: BudgetConfig = {
  maxCost: null,
  maxTokens: null,
  maxDepth: null,
};

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  enabled: false,
  strategy: "full",
  retention: "long",
};

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  extensions: [".md"],
  exclude: ["node_modules", ".git", "dist"],
};

const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
  thinkingLevel: null,
  googleSearch: false,
  urlContext: false,
  codeExecution: false,
  mediaResolution: null,
  computerUse: false,
  mapsGrounding: false,
  fileSearch: false,
};

const DEFAULT_OUTPUT_CONFIG: OutputConfig = {
  schema: null,
};

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  enabled: "auto",
  mode: "persistent",
  dataDir: "~/.rlmx/data",
  port: 0,
  chunkSize: null,
  chunkUtilization: 0.6,
  charsPerToken: 4,
};

export const DEFAULT_RTK_CONFIG: RtkConfig = {
  enabled: "auto",
};

// ─── YAML Schema ─────────────────────────────────────────

/** Shape of rlmx.yaml on disk (config-only — no system/criteria) */
interface RawYamlConfig {
  model?: {
    provider?: string;
    model?: string;
    "sub-call-model"?: string;
  };
  tools?: Record<string, string>;
  context?: {
    extensions?: string[];
    exclude?: string[];
  };
  budget?: {
    "max-cost"?: number | null;
    "max-tokens"?: number | null;
    "max-depth"?: number | null;
  };
  "tools-level"?: string;
  gemini?: {
    "thinking-level"?: string;
    "google-search"?: boolean;
    "url-context"?: boolean;
    "code-execution"?: boolean;
    "media-resolution"?: {
      images?: string;
      pdfs?: string;
      video?: string;
    };
    "computer-use"?: boolean;
    "maps-grounding"?: boolean;
    "file-search"?: boolean;
  };
  output?: {
    schema?: Record<string, unknown>;
  };
  cache?: {
    enabled?: boolean;
    strategy?: string;
    "session-prefix"?: string;
    retention?: string;
    ttl?: number;
    "expire-time"?: string;
  };
  storage?: {
    enabled?: string;
    mode?: string;
    "data-dir"?: string;
    port?: number;
    "chunk-size"?: number | null;
    "chunk-utilization"?: number;
    "chars-per-token"?: number;
  };
  rtk?: {
    enabled?: string;
  };
}

// ─── File Helpers ────────────────────────────────────────

/**
 * Try to read a file, returning null if it doesn't exist.
 */
async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Validate a budget value is a positive number or null.
 */
function validatePositiveBudget(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "number" || value <= 0)) {
    throw new Error(
      `Invalid ${field}: must be a positive number or null, got ${value}.`
    );
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
export function parseToolsMd(content: string): ToolDef[] {
  const tools: ToolDef[] = [];
  const headingRegex = /^## (.+)$/gm;
  const codeBlockRegex = /```python\s*\n([\s\S]*?)```/g;

  let headingMatch: RegExpExecArray | null;
  const headings: { name: string; index: number }[] = [];

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
function parseYamlConfig(content: string, dir: string): Omit<RlmxConfig, "system" | "criteria" | "tools"> {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid YAML in rlmx.yaml: ${msg}\n` +
        `Hint: check for indentation errors or unquoted special characters.`
    );
  }

  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(
      `rlmx.yaml is empty or not a YAML mapping.\n` +
        `Expected a YAML object with keys like model, context, budget, etc.`
    );
  }

  const cfg = raw as RawYamlConfig;

  // Parse model
  const model: ModelConfig = {
    provider: cfg.model?.provider ?? DEFAULT_MODEL.provider,
    model: cfg.model?.model ?? DEFAULT_MODEL.model,
  };
  if (cfg.model?.["sub-call-model"]) {
    model.subCallModel = cfg.model["sub-call-model"];
  }

  // Parse context config
  const contextConfig: ContextConfig = {
    extensions: cfg.context?.extensions ?? DEFAULT_CONTEXT_CONFIG.extensions,
    exclude: cfg.context?.exclude ?? DEFAULT_CONTEXT_CONFIG.exclude,
  };

  // Validate and normalize extensions format
  for (let i = 0; i < contextConfig.extensions.length; i++) {
    const ext = contextConfig.extensions[i];
    if (typeof ext !== "string") {
      throw new Error(
        `Invalid extension in context.extensions: expected string, got ${typeof ext}.`
      );
    }
    // Ensure leading dot: "mdx" → ".mdx"
    if (ext.length > 0 && !ext.startsWith(".")) {
      contextConfig.extensions[i] = `.${ext}`;
    }
  }

  // Parse budget
  const budget: BudgetConfig = {
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
    throw new Error(
      `Invalid tools-level "${rawLevel}" in rlmx.yaml. Must be one of: core, standard, full.`
    );
  }
  const toolsLevel = rawLevel as ToolsLevel;

  // Parse cache config
  const rawRetention = cfg.cache?.retention ?? "long";
  if (rawRetention && !["short", "long"].includes(rawRetention)) {
    throw new Error(
      `Invalid cache.retention "${rawRetention}" in rlmx.yaml. Must be one of: short, long.`
    );
  }
  const rawStrategy = cfg.cache?.strategy ?? "full";
  if (rawStrategy && rawStrategy !== "full") {
    throw new Error(
      `Invalid cache.strategy "${rawStrategy}" in rlmx.yaml. Only "full" is currently supported.`
    );
  }
  const cache: CacheConfig = {
    enabled: cfg.cache?.enabled ?? DEFAULT_CACHE_CONFIG.enabled,
    strategy: rawStrategy as "full",
    retention: rawRetention as "short" | "long",
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
  const gemini: GeminiConfig = {
    thinkingLevel: (cfg.gemini?.["thinking-level"] as ThinkingLevel | undefined) ?? DEFAULT_GEMINI_CONFIG.thinkingLevel,
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
      throw new Error(
        `Invalid gemini.thinking-level "${gemini.thinkingLevel}" in rlmx.yaml. ` +
        `Must be one of: minimal, low, medium, high.`
      );
    }
  }

  // Validate media resolution values if provided
  if (gemini.mediaResolution) {
    const validResolutions = ["low", "medium", "high", "auto"];
    for (const [key, value] of Object.entries(gemini.mediaResolution)) {
      if (value && !validResolutions.includes(value)) {
        throw new Error(
          `Invalid gemini.media-resolution.${key} "${value}" in rlmx.yaml. ` +
          `Must be one of: low, medium, high, auto.`
        );
      }
    }
  }

  // Parse output config
  const output: OutputConfig = {
    schema: cfg.output?.schema ?? DEFAULT_OUTPUT_CONFIG.schema,
  };

  // Validate output schema if provided
  if (output.schema !== null && typeof output.schema !== "object") {
    throw new Error(
      `Invalid output.schema in rlmx.yaml: must be a JSON Schema object or null.`
    );
  }

  // Parse storage config
  const rawEnabled = cfg.storage?.enabled ?? DEFAULT_STORAGE_CONFIG.enabled;
  if (!["auto", "always", "never"].includes(rawEnabled)) {
    throw new Error(
      `Invalid storage.enabled "${rawEnabled}" in rlmx.yaml. Must be one of: auto, always, never.`
    );
  }
  const rawMode = cfg.storage?.mode ?? DEFAULT_STORAGE_CONFIG.mode;
  if (!["persistent", "memory"].includes(rawMode)) {
    throw new Error(
      `Invalid storage.mode "${rawMode}" in rlmx.yaml. Must be one of: persistent, memory.`
    );
  }
  const storagePort = cfg.storage?.port ?? DEFAULT_STORAGE_CONFIG.port;
  if (typeof storagePort !== "number" || storagePort < 0 || !Number.isInteger(storagePort)) {
    throw new Error(
      `Invalid storage.port in rlmx.yaml: must be a non-negative integer, got ${storagePort}.`
    );
  }
  const chunkSize = cfg.storage?.["chunk-size"] ?? DEFAULT_STORAGE_CONFIG.chunkSize;
  if (chunkSize !== null && (typeof chunkSize !== "number" || chunkSize <= 0)) {
    throw new Error(
      `Invalid storage.chunk-size in rlmx.yaml: must be a positive number or null, got ${chunkSize}.`
    );
  }
  const chunkUtilization = cfg.storage?.["chunk-utilization"] ?? DEFAULT_STORAGE_CONFIG.chunkUtilization;
  if (typeof chunkUtilization !== "number" || chunkUtilization <= 0 || chunkUtilization > 1) {
    throw new Error(
      `Invalid storage.chunk-utilization in rlmx.yaml: must be a number between 0 (exclusive) and 1 (inclusive), got ${chunkUtilization}.`
    );
  }
  const charsPerToken = cfg.storage?.["chars-per-token"] ?? DEFAULT_STORAGE_CONFIG.charsPerToken;
  if (typeof charsPerToken !== "number" || charsPerToken <= 0) {
    throw new Error(
      `Invalid storage.chars-per-token in rlmx.yaml: must be a positive number, got ${charsPerToken}.`
    );
  }
  const storage: StorageConfig = {
    enabled: rawEnabled as StorageConfig["enabled"],
    mode: rawMode as StorageConfig["mode"],
    dataDir: cfg.storage?.["data-dir"] ?? DEFAULT_STORAGE_CONFIG.dataDir,
    port: storagePort,
    chunkSize,
    chunkUtilization,
    charsPerToken,
  };

  // Parse rtk config
  const rawRtkEnabled = cfg.rtk?.enabled ?? DEFAULT_RTK_CONFIG.enabled;
  if (!["auto", "always", "never"].includes(rawRtkEnabled)) {
    throw new Error(
      `Invalid rtk.enabled "${rawRtkEnabled}" in rlmx.yaml. Must be one of: auto, always, never.`
    );
  }
  const rtk: RtkConfig = {
    enabled: rawRtkEnabled as RtkConfig["enabled"],
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
function defaultConfig(dir: string): RlmxConfig {
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
export async function loadConfig(dir: string): Promise<RlmxConfig> {
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
export async function hasConfig(dir: string): Promise<boolean> {
  return (await readOptionalFile(join(dir, ".rlmx", "rlmx.yaml"))) !== null;
}
