import type { ThinkingLevel } from "./gemini.js";
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
    ttl?: number;
    expireTime?: string;
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
export declare const DEFAULT_STORAGE_CONFIG: StorageConfig;
export declare const DEFAULT_RTK_CONFIG: RtkConfig;
/**
 * Parse TOOLS.md format:
 *   ## tool_name
 *   ```python
 *   def tool_name(...):
 *       ...
 *   ```
 */
export declare function parseToolsMd(content: string): ToolDef[];
/**
 * Load rlmx config from .rlmx/ directory:
 *   1. .rlmx/rlmx.yaml (required for yaml source)
 *   2. .rlmx/SYSTEM.md (auto-loaded when present)
 *   3. .rlmx/CRITERIA.md (auto-loaded when present)
 *   4. .rlmx/TOOLS.md (auto-loaded and parsed when present)
 *   5. Defaults if no .rlmx/rlmx.yaml
 */
export declare function loadConfig(dir: string): Promise<RlmxConfig>;
/**
 * Check if any config exists in a directory.
 * Only checks .rlmx/rlmx.yaml.
 */
export declare function hasConfig(dir: string): Promise<boolean>;
//# sourceMappingURL=config.d.ts.map