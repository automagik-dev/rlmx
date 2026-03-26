/**
 * Cache utilities for CAG (Context-Augmented Generation) mode.
 *
 * When --cache is enabled, full context content is embedded directly
 * in the system prompt instead of being externalized to the REPL.
 * This enables provider-level prompt caching (Gemini, Anthropic, etc.)
 * for repeated queries over the same context.
 */

import { createHash } from "node:crypto";
import type { RlmxConfig, CacheConfig } from "./config.js";
import type { LoadedContext, ContextItem } from "./context.js";

/**
 * Estimate token count from context.
 * Uses chars / 4 with a 20% safety margin (i.e., multiplied by 1.2).
 */
export function estimateTokens(context: LoadedContext): number {
  let totalChars: number;

  if (context.type === "list") {
    const items = context.content as ContextItem[];
    totalChars = items.reduce((sum, item) => sum + item.path.length + item.content.length, 0);
  } else {
    totalChars = (context.content as string).length;
  }

  // chars / 4, then 20% safety margin
  return Math.ceil((totalChars / 4) * 1.2);
}

/**
 * Compute a stable SHA256 content hash from context.
 * Sorts file paths alphabetically before hashing to ensure determinism.
 * Returns the first 12 hex characters of the hash.
 */
export function computeContentHash(context: LoadedContext): string {
  const hash = createHash("sha256");

  if (context.type === "list") {
    const items = context.content as ContextItem[];
    // Sort by path for deterministic ordering
    const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
    for (const item of sorted) {
      hash.update(item.path);
      hash.update("\0"); // separator
      hash.update(item.content);
      hash.update("\0");
    }
  } else {
    hash.update(context.content as string);
  }

  return hash.digest("hex").slice(0, 12);
}

/**
 * Build a session ID from an optional prefix and content hash.
 * Format: "{prefix}-{hash}" or just "{hash}" if no prefix.
 */
export function buildSessionId(prefix: string | undefined, hash: string): string {
  if (prefix) {
    return `${prefix}-${hash}`;
  }
  return hash;
}

/**
 * Build a system prompt with FULL context content embedded.
 * This is the CAG mode system prompt — all context is in the system message
 * so the provider can cache it across turns/requests.
 *
 * Format:
 *   {system prompt}
 *
 *   ## Context Files
 *
 *   ### {path}
 *   ```
 *   {content}
 *   ```
 */
export function buildCachedSystemPrompt(
  config: RlmxConfig,
  context: LoadedContext | null
): string {
  let system = config.system ?? "";

  // Append criteria if present
  if (config.criteria) {
    system +=
      "\n\n## Output Criteria\n\nWhen providing your FINAL answer, follow these criteria:\n" +
      config.criteria;
  }

  if (!context) {
    return system;
  }

  // Append full context content
  system += "\n\n## Context Files\n";

  if (context.type === "list") {
    const items = context.content as ContextItem[];
    for (const item of items) {
      system += `\n### ${item.path}\n\`\`\`\n${item.content}\n\`\`\`\n`;
    }
  } else {
    // String or dict context — embed as a single block
    const content = context.content as string;
    system += `\n### context\n\`\`\`\n${content}\n\`\`\`\n`;
  }

  return system;
}
