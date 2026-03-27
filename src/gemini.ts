/**
 * Gemini 3 native integration module.
 *
 * Provides:
 *   - GeminiConfig interface and defaults
 *   - onPayload hook builder for injecting Gemini-specific params
 *   - Provider detection (isGoogleProvider)
 *   - Feature flag resolution (what's enabled, what's not)
 *   - Structured output config
 *   - Future flag stubs (computer-use, maps, file-search)
 */

import type { GeminiConfig, MediaResolutionConfig } from "./config.js";

// ─── Provider Detection ──────────────────────────────────

/** Check if the provider is Google (gemini). */
export function isGoogleProvider(provider: string): boolean {
  return (
    provider === "google" ||
    provider === "google-vertex" ||
    provider === "google-gemini-cli" ||
    provider === "google-antigravity"
  );
}

// ─── Thinking Level ──────────────────────────────────────

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

const VALID_THINKING_LEVELS: readonly string[] = ["minimal", "low", "medium", "high"];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
  return VALID_THINKING_LEVELS.includes(level);
}

// ─── Future Flags ────────────────────────────────────────

const FUTURE_FLAGS: Record<string, string> = {
  "computer-use": "gemini.computer-use is planned for v0.5",
  "maps-grounding": "gemini.maps-grounding is planned for v0.5",
  "file-search": "gemini.file-search is planned for v0.5",
};

/** Check future flags and return warnings for any that are enabled. */
export function checkFutureFlags(gemini: GeminiConfig): string[] {
  const warnings: string[] = [];
  if (gemini.computerUse) {
    warnings.push(FUTURE_FLAGS["computer-use"]);
  }
  if (gemini.mapsGrounding) {
    warnings.push(FUTURE_FLAGS["maps-grounding"]);
  }
  if (gemini.fileSearch) {
    warnings.push(FUTURE_FLAGS["file-search"]);
  }
  return warnings;
}

// ─── Media Resolution Mapping ────────────────────────────

type GoogleMediaResolution = "low" | "medium" | "high" | "auto";

function mapMediaResolution(
  level: string | undefined
): GoogleMediaResolution | undefined {
  if (!level) return undefined;
  const valid = ["low", "medium", "high", "auto"];
  return valid.includes(level) ? (level as GoogleMediaResolution) : undefined;
}

// ─── onPayload Hook Builder ──────────────────────────────

/**
 * Build the onPayload hook that injects Gemini-specific params into API requests.
 * This is called once per run and returns a function compatible with pi/ai's
 * onPayload option.
 *
 * The hook only modifies the payload when the provider is Google.
 */
export function buildGeminiOnPayload(
  gemini: GeminiConfig,
  provider: string,
  outputSchema?: Record<string, unknown> | null,
  cacheTtl?: number,
  cacheExpireTime?: string
): ((payload: unknown) => unknown | undefined) | undefined {
  // No hook needed for non-Google providers
  if (!isGoogleProvider(provider)) {
    return undefined;
  }

  // Validate Google TTL range (60-86400 seconds)
  if (cacheTtl !== undefined && (cacheTtl < 60 || cacheTtl > 86400)) {
    console.error(
      `rlmx: warning: Google cache TTL must be 60-86400 seconds, got ${cacheTtl}s`
    );
  }

  // Collect all modifications needed
  const hasModifications =
    gemini.googleSearch ||
    gemini.urlContext ||
    gemini.codeExecution ||
    (gemini.mediaResolution !== null && gemini.mediaResolution !== undefined) ||
    outputSchema ||
    cacheTtl !== undefined ||
    cacheExpireTime !== undefined;

  if (!hasModifications) {
    return undefined;
  }

  return (payload: unknown): unknown => {
    const p = payload as Record<string, unknown>;
    const config = (p.config ?? {}) as Record<string, unknown>;

    // Inject tools array for built-in Gemini tools
    const tools = ((config.tools as unknown[]) ?? []).slice();
    let toolsModified = false;

    if (gemini.googleSearch) {
      tools.push({ googleSearch: {} });
      toolsModified = true;
    }

    if (gemini.urlContext) {
      tools.push({ urlContext: {} });
      toolsModified = true;
    }

    if (gemini.codeExecution) {
      tools.push({ codeExecution: {} });
      toolsModified = true;
    }

    if (toolsModified) {
      config.tools = tools;
    }

    // Inject media resolution
    if (gemini.mediaResolution) {
      const mediaRes: Record<string, unknown> = {};
      const imgRes = mapMediaResolution(gemini.mediaResolution.images);
      const pdfRes = mapMediaResolution(gemini.mediaResolution.pdfs);
      const vidRes = mapMediaResolution(gemini.mediaResolution.video);

      if (imgRes) mediaRes.imageResolution = imgRes;
      if (pdfRes) mediaRes.pdfResolution = pdfRes;
      if (vidRes) mediaRes.videoResolution = vidRes;

      if (Object.keys(mediaRes).length > 0) {
        (config as Record<string, unknown>).mediaResolution =
          mediaRes;
      }
    }

    // Inject structured output schema
    if (outputSchema) {
      config.responseMimeType = "application/json";
      config.responseSchema = outputSchema;
    }

    // Inject cache TTL into cachedContent (Google Duration format: "3600s")
    if (cacheTtl !== undefined || cacheExpireTime !== undefined) {
      const cachedContent = ((config.cachedContent as Record<string, unknown>) ?? {});
      if (cacheTtl !== undefined) {
        cachedContent.ttl = cacheTtl + "s";
      }
      if (cacheExpireTime !== undefined) {
        cachedContent.expireTime = cacheExpireTime;
      }
      config.cachedContent = cachedContent;
    }

    p.config = config;
    return p;
  };
}

// ─── Gemini Stats Tracking ───────────────────────────────

export interface GeminiStats {
  thinkingLevel: ThinkingLevel | null;
  thoughtSignaturesCirculated: number;
  webSearchCalls: number;
  fetchUrlCalls: number;
  codeExecutions: { local: number; serverSide: number };
  imageGenerations: number;
  mediaResolution: MediaResolutionConfig | null;
  geminiToolsUsed: string[];
  batchApi: boolean;
}

export function createGeminiStats(): GeminiStats {
  return {
    thinkingLevel: null,
    thoughtSignaturesCirculated: 0,
    webSearchCalls: 0,
    fetchUrlCalls: 0,
    codeExecutions: { local: 0, serverSide: 0 },
    imageGenerations: 0,
    mediaResolution: null,
    geminiToolsUsed: [],
    batchApi: false,
  };
}

// ─── Default Gemini Config ───────────────────────────────

export const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
  thinkingLevel: null,
  googleSearch: false,
  urlContext: false,
  codeExecution: false,
  mediaResolution: null,
  computerUse: false,
  mapsGrounding: false,
  fileSearch: false,
};
