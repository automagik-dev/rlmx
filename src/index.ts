export { loadConfig, parseToolsMd, parseModelMd } from "./config.js";
export type { RlmxConfig, ToolDef, ModelConfig } from "./config.js";

export { scaffold, needsScaffold, SCAFFOLD_FILE_NAMES } from "./scaffold.js";

export { loadContext, loadContextFromDir, loadContextFromFile, loadContextFromStdin } from "./context.js";
export type { LoadedContext, ContextItem } from "./context.js";

export { REPL } from "./repl.js";
export type { REPLStartOptions, LLMRequestHandler } from "./repl.js";

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

export { outputResult, emitStreamEvent, logVerbose } from "./output.js";
export type { RLMResult, StreamEvent } from "./output.js";
