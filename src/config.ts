import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

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
  /** Config source: "yaml" | "md" | "defaults" */
  configSource: "yaml" | "md" | "defaults";
}

// ─── Defaults ────────────────────────────────────────────

const DEFAULT_MODEL: ModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
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

// ─── YAML Schema ─────────────────────────────────────────

/** Shape of rlmx.yaml on disk */
interface RawYamlConfig {
  model?: {
    provider?: string;
    model?: string;
    "sub-call-model"?: string;
  };
  system?: string;
  tools?: Record<string, string>;
  criteria?: string;
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
  cache?: {
    enabled?: boolean;
    strategy?: string;
    "session-prefix"?: string;
    retention?: string;
    ttl?: number;
    "expire-time"?: string;
  };
}

// ─── YAML Loading ────────────────────────────────────────

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
 * Parse and validate an rlmx.yaml file.
 */
function parseYamlConfig(content: string, dir: string): RlmxConfig {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (err: any) {
    throw new Error(
      `Invalid YAML in rlmx.yaml: ${err.message ?? err}\n` +
        `Hint: check for indentation errors or unquoted special characters.`
    );
  }

  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(
      `rlmx.yaml is empty or not a YAML mapping.\n` +
        `Expected a YAML object with keys like model, system, tools, etc.`
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

  // Parse tools (name → Python code)
  const tools: ToolDef[] = [];
  if (cfg.tools && typeof cfg.tools === "object") {
    for (const [name, code] of Object.entries(cfg.tools)) {
      if (typeof code !== "string") {
        throw new Error(
          `Invalid tool "${name}" in rlmx.yaml: expected Python code string, got ${typeof code}.`
        );
      }
      tools.push({ name, code: code.trim() });
    }
  }

  // Parse context config
  const contextConfig: ContextConfig = {
    extensions: cfg.context?.extensions ?? DEFAULT_CONTEXT_CONFIG.extensions,
    exclude: cfg.context?.exclude ?? DEFAULT_CONTEXT_CONFIG.exclude,
  };

  // Validate extensions format
  for (const ext of contextConfig.extensions) {
    if (typeof ext !== "string") {
      throw new Error(
        `Invalid extension in context.extensions: expected string, got ${typeof ext}.`
      );
    }
  }

  // Parse budget
  const budget: BudgetConfig = {
    maxCost: cfg.budget?.["max-cost"] ?? DEFAULT_BUDGET.maxCost,
    maxTokens: cfg.budget?.["max-tokens"] ?? DEFAULT_BUDGET.maxTokens,
    maxDepth: cfg.budget?.["max-depth"] ?? DEFAULT_BUDGET.maxDepth,
  };

  // Validate budget values
  if (budget.maxCost !== null && (typeof budget.maxCost !== "number" || budget.maxCost <= 0)) {
    throw new Error(
      `Invalid budget.max-cost: must be a positive number or null, got ${budget.maxCost}.`
    );
  }
  if (budget.maxTokens !== null && (typeof budget.maxTokens !== "number" || budget.maxTokens <= 0)) {
    throw new Error(
      `Invalid budget.max-tokens: must be a positive number or null, got ${budget.maxTokens}.`
    );
  }
  if (budget.maxDepth !== null && (typeof budget.maxDepth !== "number" || budget.maxDepth <= 0)) {
    throw new Error(
      `Invalid budget.max-depth: must be a positive number or null, got ${budget.maxDepth}.`
    );
  }

  // Parse tools-level
  const rawLevel = cfg["tools-level"] ?? "core";
  if (!["core", "standard", "full"].includes(rawLevel)) {
    throw new Error(
      `Invalid tools-level "${rawLevel}" in rlmx.yaml. Must be one of: core, standard, full.`
    );
  }
  const toolsLevel = rawLevel as ToolsLevel;

  // Parse system and criteria (multiline strings)
  const system = cfg.system?.trim() || null;
  const criteria = cfg.criteria?.trim() || null;

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

  return {
    system,
    tools,
    criteria,
    model,
    configDir: dir,
    budget,
    contextConfig,
    toolsLevel,
    cache,
    configSource: "yaml",
  };
}

// ─── .md File Parsing (backward compat) ──────────────────

const MD_CONFIG_FILES = [
  "SYSTEM.md",
  "CONTEXT.md",
  "TOOLS.md",
  "CRITERIA.md",
  "MODEL.md",
] as const;

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

/**
 * Parse MODEL.md format: key: value pairs.
 */
export function parseModelMd(content: string): ModelConfig {
  const config: ModelConfig = {
    provider: DEFAULT_MODEL.provider,
    model: DEFAULT_MODEL.model,
  };

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("<!--") || !trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (!value) continue;

    switch (key) {
      case "provider":
        config.provider = value;
        break;
      case "model":
        config.model = value;
        break;
      case "sub-call-model":
      case "sub_call_model":
      case "subcallmodel":
        config.subCallModel = value;
        break;
    }
  }

  return config;
}

/**
 * Load config from individual .md files (v0.1 compat fallback).
 */
async function loadConfigFromMd(dir: string): Promise<RlmxConfig> {
  const [system, _context, toolsRaw, criteria, modelRaw] = await Promise.all(
    MD_CONFIG_FILES.map((f) => readOptionalFile(join(dir, f)))
  );

  const tools = toolsRaw ? parseToolsMd(toolsRaw) : [];
  const model = modelRaw ? parseModelMd(modelRaw) : { ...DEFAULT_MODEL };

  return {
    system,
    tools,
    criteria,
    model,
    configDir: dir,
    budget: { ...DEFAULT_BUDGET },
    contextConfig: { ...DEFAULT_CONTEXT_CONFIG },
    toolsLevel: "core",
    cache: { ...DEFAULT_CACHE_CONFIG },
    configSource: "md",
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
    configSource: "defaults",
  };
}

// ─── Main loader ─────────────────────────────────────────

/**
 * Load rlmx config with lookup chain:
 *   1. rlmx.yaml
 *   2. .rlmx.yaml
 *   3. Individual .md files (SYSTEM.md, TOOLS.md, etc.)
 *   4. Defaults
 */
export async function loadConfig(dir: string): Promise<RlmxConfig> {
  // 1. Try rlmx.yaml
  const yamlContent = await readOptionalFile(join(dir, "rlmx.yaml"));
  if (yamlContent !== null) {
    return parseYamlConfig(yamlContent, dir);
  }

  // 2. Try .rlmx.yaml (hidden file)
  const dotYamlContent = await readOptionalFile(join(dir, ".rlmx.yaml"));
  if (dotYamlContent !== null) {
    return parseYamlConfig(dotYamlContent, dir);
  }

  // 3. Try individual .md files
  const hasMdFiles = await hasMdConfigFiles(dir);
  if (hasMdFiles) {
    return loadConfigFromMd(dir);
  }

  // 4. Defaults
  return defaultConfig(dir);
}

/**
 * Check if any .md config files exist in the directory.
 */
async function hasMdConfigFiles(dir: string): Promise<boolean> {
  for (const name of MD_CONFIG_FILES) {
    const content = await readOptionalFile(join(dir, name));
    if (content !== null) return true;
  }
  return false;
}

/**
 * Check if any config (yaml or .md) exists in a directory.
 */
export async function hasConfig(dir: string): Promise<boolean> {
  // Check YAML files
  if (await readOptionalFile(join(dir, "rlmx.yaml")) !== null) return true;
  if (await readOptionalFile(join(dir, ".rlmx.yaml")) !== null) return true;
  // Check .md files
  return hasMdConfigFiles(dir);
}
