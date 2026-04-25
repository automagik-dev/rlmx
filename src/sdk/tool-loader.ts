/**
 * Plugin loader — Wish B Group 3a.
 *
 * Reads an `AgentSpec.tools[]` list and populates a `ToolRegistry` by
 * dynamically importing each plugin file from `<agent-dir>/tools/`.
 * TypeScript-source loading is deferred to G3b (needs a TS runtime
 * like tsx when plugins haven't been pre-compiled). This PR supports
 * the universally-portable extensions: `.mjs` and `.js`.
 *
 * Contract for a plugin file (`tools/<name>.js` or `.mjs`):
 *
 *   export default async function(args, ctx) { return result; }
 *
 * The default export must be a function satisfying `ToolHandler`.
 * Named exports are ignored; the loader only looks at `module.default`.
 *
 * Resolution algorithm:
 *   1. `<agentDir>/tools/<name>.mjs`  ← preferred (ESM, explicit)
 *   2. `<agentDir>/tools/<name>.js`   ← fallback
 *   3. Miss → `MissingPluginError` with every attempted path listed.
 *
 * Plugins that aren't listed in `AgentSpec.tools` are NEVER loaded, so
 * a stray file under `tools/` can't sneak in. Conversely, tool names
 * already present in the registry (e.g. RTK pre-registered at startup)
 * are skipped silently — the agent.yaml declaration is a *request*,
 * not an override.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSpec } from "./agent-spec.js";
import type { ToolHandler, ToolRegistry } from "./tool-registry.js";

/** Extensions the loader will try, in priority order. */
const PLUGIN_EXTENSIONS = [".mjs", ".js"] as const;

export interface LoadResult {
	/** Names that were newly added to the registry. */
	readonly loaded: readonly string[];
	/** Names already in the registry (pre-registered, e.g. RTK). */
	readonly skipped: readonly string[];
	/** Tool names missing a plugin file — a warning, not a fatal error. */
	readonly missing: readonly string[];
}

export class MissingPluginError extends Error {
	readonly toolName: string;
	readonly triedPaths: readonly string[];
	constructor(toolName: string, triedPaths: readonly string[]) {
		super(
			`plugin for tool "${toolName}" not found. Tried:\n  ${triedPaths.join("\n  ")}`,
		);
		this.name = "MissingPluginError";
		this.toolName = toolName;
		this.triedPaths = triedPaths;
	}
}

export class InvalidPluginError extends Error {
	readonly toolName: string;
	readonly pluginPath: string;
	constructor(toolName: string, pluginPath: string, reason: string) {
		super(
			`plugin "${toolName}" at ${pluginPath} is invalid: ${reason}`,
		);
		this.name = "InvalidPluginError";
		this.toolName = toolName;
		this.pluginPath = pluginPath;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

async function resolvePluginPath(
	agentDir: string,
	name: string,
): Promise<{ path: string | null; tried: readonly string[] }> {
	const tried: string[] = [];
	for (const ext of PLUGIN_EXTENSIONS) {
		const candidate = join(agentDir, "tools", `${name}${ext}`);
		tried.push(candidate);
		if (await fileExists(candidate)) return { path: candidate, tried };
	}
	return { path: null, tried };
}

function coerceDefaultExport(
	mod: unknown,
	toolName: string,
	pluginPath: string,
): ToolHandler {
	if (!mod || typeof mod !== "object") {
		throw new InvalidPluginError(
			toolName,
			pluginPath,
			"module did not evaluate to an object",
		);
	}
	const m = mod as Record<string, unknown>;
	const handler = m.default;
	if (typeof handler !== "function") {
		throw new InvalidPluginError(
			toolName,
			pluginPath,
			"missing default export (expected `export default async (args, ctx) => ...`)",
		);
	}
	return handler as ToolHandler;
}

export interface LoadOptions {
	/** When true, missing plugin files throw `MissingPluginError` instead
	 *  of accumulating on `LoadResult.missing`. Default: false (non-fatal).
	 *  Use `strict: true` for production startup to fail-fast on typos. */
	readonly strict?: boolean;
}

/**
 * Load every plugin listed in `spec.tools` into `registry`. Returns a
 * breakdown of loaded / skipped / missing names so callers can log
 * the outcome. Tool names already in the registry are skipped (not
 * overridden) — pre-registered handlers (RTK, consumer-supplied)
 * always win.
 */
export async function loadPluginTools(
	spec: AgentSpec,
	registry: ToolRegistry,
	options: LoadOptions = {},
): Promise<LoadResult> {
	const loaded: string[] = [];
	const skipped: string[] = [];
	const missing: string[] = [];

	for (const name of spec.tools) {
		if (registry.has(name)) {
			skipped.push(name);
			continue;
		}

		const { path, tried } = await resolvePluginPath(spec.dir, name);
		if (!path) {
			if (options.strict) throw new MissingPluginError(name, tried);
			missing.push(name);
			continue;
		}

		// Use the file:// URL form — dynamic import() on a bare absolute
		// path fails on Windows and in some Node configs. `pathToFileURL`
		// handles both without surprises.
		const mod = (await import(pathToFileURL(path).href)) as unknown;
		const handler = coerceDefaultExport(mod, name, path);
		registry.register(name, handler);
		loaded.push(name);
	}

	return { loaded, skipped, missing };
}
