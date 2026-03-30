/**
 * Global settings management for rlmx.
 *
 * Stores API keys and defaults in ~/.rlmx/settings.json.
 * Priority: CLI flags > rlmx.yaml > settings.json > hardcoded defaults.
 */

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────

export interface GlobalSettings {
  [key: string]: unknown;
}

// ─── Constants ──────────────────────────────────────────

/** Keys that contain secrets and must be masked in output */
const SENSITIVE_PATTERNS = ["API_KEY", "SECRET", "TOKEN"];

/** Map of settings keys to environment variable names (for API key injection) */
const ENV_KEY_MAP: Record<string, string> = {
  GEMINI_API_KEY: "GEMINI_API_KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  GROQ_API_KEY: "GROQ_API_KEY",
  XAI_API_KEY: "XAI_API_KEY",
  OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
};

// ─── Paths ──────────────────────────────────────────────

export function getSettingsDir(): string {
  return join(homedir(), ".rlmx");
}

export function getSettingsPath(): string {
  return join(getSettingsDir(), "settings.json");
}

// ─── CRUD ───────────────────────────────────────────────

export async function loadSettings(): Promise<GlobalSettings> {
  try {
    const content = await readFile(getSettingsPath(), "utf-8");
    return JSON.parse(content) as GlobalSettings;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: GlobalSettings): Promise<void> {
  const dir = getSettingsDir();
  await mkdir(dir, { recursive: true });
  const filePath = getSettingsPath();
  await writeFile(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  await chmod(filePath, 0o600);
}

// ─── Env Injection ──────────────────────────────────────

/**
 * Inject API keys from settings into process.env.
 * Only sets env vars that are NOT already set (env takes priority).
 */
export function injectApiKeysToEnv(settings: GlobalSettings): void {
  for (const [settingsKey, envVar] of Object.entries(ENV_KEY_MAP)) {
    const value = settings[settingsKey];
    if (typeof value === "string" && value && !process.env[envVar]) {
      process.env[envVar] = value;
    }
  }
}

// ─── Display Helpers ────────────────────────────────────

/** Check if a key is sensitive (contains API_KEY, SECRET, or TOKEN) */
export function isSensitiveKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_PATTERNS.some((p) => upper.includes(p));
}

/** Mask a value for display: "val...lue" (first 3 + last 3) */
export function maskValue(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

/** Format a value for display, masking if sensitive */
export function formatValue(key: string, value: unknown): string {
  if (isSensitiveKey(key) && typeof value === "string") {
    return maskValue(value);
  }
  return String(value);
}

// ─── Config Defaults ────────────────────────────────────

/**
 * Parse a settings value with type coercion.
 * Numbers, booleans, and arrays (comma-separated) are auto-detected.
 */
export function parseSettingValue(value: string): unknown {
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;
  // Number
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;
  // String
  return value;
}
