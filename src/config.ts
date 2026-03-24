import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Parsed tool from TOOLS.md: heading = name, python code block = implementation */
export interface ToolDef {
  name: string;
  code: string;
}

/** Parsed MODEL.md config */
export interface ModelConfig {
  provider: string;
  model: string;
  subCallModel?: string;
}

/** Full rlmx config loaded from .md files in cwd */
export interface RlmxConfig {
  system: string | null;
  context: string | null;
  tools: ToolDef[];
  criteria: string | null;
  model: ModelConfig;
  /** Directory the config was loaded from */
  configDir: string;
}

const CONFIG_FILES = [
  "SYSTEM.md",
  "CONTEXT.md",
  "TOOLS.md",
  "CRITERIA.md",
  "MODEL.md",
] as const;

async function readMdFile(dir: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(dir, name), "utf-8");
  } catch {
    return null;
  }
}

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
 * Parse MODEL.md format:
 *   provider: anthropic
 *   model: claude-sonnet-4-5-20250514
 *   sub-call-model: claude-haiku-4-5-20251001
 *
 * Or simple YAML-like key: value pairs. Supports free-form markdown — extracts key-value lines.
 */
export function parseModelMd(content: string): ModelConfig {
  const config: ModelConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250514",
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
 * Load all .md config files from a directory.
 * Missing files return null / defaults — no errors for absent configs.
 */
export async function loadConfig(dir: string): Promise<RlmxConfig> {
  const [system, context, toolsRaw, criteria, modelRaw] = await Promise.all(
    CONFIG_FILES.map((f) => readMdFile(dir, f))
  );

  const tools = toolsRaw ? parseToolsMd(toolsRaw) : [];
  const model = modelRaw
    ? parseModelMd(modelRaw)
    : { provider: "anthropic", model: "claude-sonnet-4-5-20250514" };

  return {
    system,
    context,
    tools,
    criteria,
    model,
    configDir: dir,
  };
}
