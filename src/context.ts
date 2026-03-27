import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface ContextItem {
  path: string;
  content: string;
}

export interface LoadedContext {
  type: "string" | "list" | "dict";
  content: string | ContextItem[];
  metadata: string;
}

export interface CollectOptions {
  extensions: string[];   // e.g. [".md", ".txt", ".py"]
  exclude: string[];      // e.g. ["node_modules", ".git", "dist", "*.log"]
}

const DEFAULT_COLLECT_OPTIONS: CollectOptions = {
  extensions: [".md"],
  exclude: ["node_modules", ".git", "dist"],
};

/**
 * Check if a name matches an exclude pattern.
 * Supports simple glob: if pattern contains `*`, convert to regex.
 * Otherwise, exact match on the name.
 */
function matchesExclude(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      // Convert glob pattern to regex: escape dots, replace * with .*
      const regexStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
      if (new RegExp(regexStr).test(name)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

/**
 * Recursively collect files matching a pattern from a directory.
 */
async function collectFiles(
  dir: string,
  baseDir: string,
  options: CollectOptions
): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Resolve symlinks: isDirectory/isFile return false for symlinks
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const resolved = await stat(fullPath); // stat follows symlinks
      isDir = resolved.isDirectory();
      isFile = resolved.isFile();
    }

    if (isDir) {
      // Always skip hidden directories (starting with .)
      if (entry.name.startsWith(".")) continue;
      // Skip directories matching exclude patterns
      if (matchesExclude(entry.name, options.exclude)) continue;
      const subItems = await collectFiles(fullPath, baseDir, options);
      items.push(...subItems);
    } else if (isFile) {
      // Skip files matching exclude patterns
      if (matchesExclude(entry.name, options.exclude)) continue;
      // Check if file matches any of the allowed extensions
      const matchesExt = options.extensions.some((ext) => entry.name.endsWith(ext));
      if (matchesExt) {
        const content = await readFile(fullPath, "utf-8");
        items.push({
          path: relative(baseDir, fullPath),
          content,
        });
      }
    }
  }

  return items;
}

/**
 * Generate metadata string describing the loaded context.
 */
function generateMetadata(ctx: LoadedContext): string {
  if (ctx.type === "string") {
    const content = ctx.content as string;
    const prefix = content.slice(0, 200).replace(/\n/g, " ");
    return `Context is a string with ${content.length} total characters. Preview: "${prefix}..."`;
  }

  if (ctx.type === "list") {
    const items = ctx.content as ContextItem[];
    const totalLength = items.reduce((sum, item) => sum + item.content.length, 0);
    const chunkLengths = items.map((item) => item.content.length);

    let chunkStr: string;
    if (chunkLengths.length > 100) {
      const shown = chunkLengths.slice(0, 100);
      chunkStr = `[${shown.join(", ")}... ${chunkLengths.length - 100} others]`;
    } else {
      chunkStr = `[${chunkLengths.join(", ")}]`;
    }

    return `Context is a list of ${items.length} items with ${totalLength} total characters, chunk lengths: ${chunkStr}`;
  }

  // dict type
  const content = ctx.content as string;
  return `Context is a dict/JSON with ${content.length} total characters.`;
}

/**
 * Load context from a directory path.
 * Recursively reads files matching the configured extensions.
 */
export async function loadContextFromDir(
  dirPath: string,
  options?: Partial<CollectOptions>
): Promise<LoadedContext> {
  const merged: CollectOptions = {
    extensions: options?.extensions ?? DEFAULT_COLLECT_OPTIONS.extensions,
    exclude: options?.exclude ?? DEFAULT_COLLECT_OPTIONS.exclude,
  };
  const items = await collectFiles(dirPath, dirPath, merged);
  items.sort((a, b) => a.path.localeCompare(b.path));

  const ctx: LoadedContext = {
    type: "list",
    content: items,
    metadata: "",
  };
  ctx.metadata = generateMetadata(ctx);
  return ctx;
}

/**
 * Load context from a single file.
 */
export async function loadContextFromFile(filePath: string): Promise<LoadedContext> {
  const content = await readFile(filePath, "utf-8");

  // JSON files → parse as dict or list
  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const items: ContextItem[] = parsed.map((item: unknown, i: number) => ({
          path: `[${i}]`,
          content: typeof item === "string" ? item : JSON.stringify(item),
        }));
        const ctx: LoadedContext = { type: "list", content: items, metadata: "" };
        ctx.metadata = generateMetadata(ctx);
        return ctx;
      }
      const ctx: LoadedContext = {
        type: "dict",
        content: JSON.stringify(parsed, null, 2),
        metadata: "",
      };
      ctx.metadata = generateMetadata(ctx);
      return ctx;
    } catch {
      // Fall through to string
    }
  }

  const ctx: LoadedContext = { type: "string", content, metadata: "" };
  ctx.metadata = generateMetadata(ctx);
  return ctx;
}

/**
 * Load context from stdin (non-blocking check).
 */
export async function loadContextFromStdin(): Promise<LoadedContext> {
  const chunks: Buffer[] = [];
  const stdin = process.stdin;

  return new Promise((resolve, reject) => {
    stdin.setEncoding("utf-8");
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      const content = chunks.join("");
      const ctx: LoadedContext = { type: "string", content, metadata: "" };
      ctx.metadata = generateMetadata(ctx);
      resolve(ctx);
    });
    stdin.on("error", reject);
    stdin.resume();
  });
}

/**
 * Load context from a path (auto-detect file vs directory).
 */
export async function loadContext(
  contextPath: string,
  options?: Partial<CollectOptions>
): Promise<LoadedContext> {
  const info = await stat(contextPath);

  if (info.isDirectory()) {
    return loadContextFromDir(contextPath, options);
  }
  return loadContextFromFile(contextPath);
}
