export { loadConfig, hasConfig, parseToolsMd, parseModelMd } from "./config.js";
export type { RlmxConfig, ToolDef, ModelConfig, BudgetConfig, ContextConfig, ToolsLevel } from "./config.js";

export { scaffold, needsScaffold, SCAFFOLD_FILE_NAMES } from "./scaffold.js";

export { loadContext, loadContextFromDir, loadContextFromFile, loadContextFromStdin } from "./context.js";
export type { LoadedContext, ContextItem, CollectOptions } from "./context.js";

export { REPL } from "./repl.js";
export type { REPLStartOptions, LLMRequestHandler } from "./repl.js";

export { detectPackages, formatPackagePrompt, PROBE_PACKAGES } from "./detect.js";
export type { PackageAvailability } from "./detect.js";

export { rlmLoop } from "./rlm.js";
export type { RLMOptions } from "./rlm.js";

export {
  llmComplete,
  llmCompleteSimple,
  llmCompleteBatched,
  handleLLMRequest,
  createUsage,
  mergeUsage,
} from "./llm.js";
export type { ChatMessage, LLMResponse, UsageStats } from "./llm.js";

export {
  extractCodeBlocks,
  detectFinal,
  formatIterationResult,
} from "./parser.js";
export type { CodeBlock, FinalSignal, ExecutionResult } from "./parser.js";

export { outputResult, emitStreamEvent, emitStats, buildStats, logVerbose } from "./output.js";
export type { RLMResult, StreamEvent, StatsData } from "./output.js";

export { Logger, createLogger } from "./logger.js";
export type { EventType, LogEvent } from "./logger.js";
