/**
 * Validate primitive — Wish B Group 2.
 *
 * `emit_done` payloads are schema-checked against a `VALIDATE.md` file
 * living next to the agent definition. On failure, the SDK retries
 * once with the schema + error hint prepended to the next iteration's
 * prompt. A second failure is terminal and surfaces as a
 * `Validation { status: "fail", attempt: 2 }` event.
 *
 * This module ships the PURE pieces: VALIDATE.md parsing + JSON schema
 * check + retry-hint synthesis + retry policy. Wiring into the loop's
 * emit_done pipeline arrives with `runAgent()` (Group 2b / 3).
 *
 * The schema implementation is a deliberately small JSON-Schema subset
 * — enough for Wish A/B agents (`type: object`, `properties`,
 * `required`, primitive `type`s, `items`). If a richer schema lands,
 * swap the checker for `ajv` without touching call sites.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L25, L142, L149.
 */
/** Minimal JSON-Schema subset we interpret. */
export interface ValidateSchema {
    readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
    readonly properties?: Readonly<Record<string, ValidateSchema>>;
    readonly required?: readonly string[];
    readonly items?: ValidateSchema;
    readonly enum?: readonly unknown[];
    readonly description?: string;
}
export interface ValidateResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    /** Original schema markdown snippet, used to build retry hints. */
    readonly schemaSource?: string;
}
/** Absolute max number of validate attempts. Fail on the 2nd. */
export declare const MAX_VALIDATE_ATTEMPTS = 2;
/**
 * Extract the first JSON schema fenced block from a `VALIDATE.md`
 * markdown file. Accepts ```json, ```jsonc, and bare ``` fences.
 * Returns `null` when no block is present or the block is not valid
 * JSON — the caller decides whether that is fatal or abstains.
 */
export declare function parseValidateMd(markdown: string): {
    schema: ValidateSchema | null;
    rawBlock: string | null;
};
/**
 * Recursively check `value` against `schema`. Accumulates errors
 * instead of throwing — callers want the full list for retry-hint
 * synthesis, not just the first failure.
 */
export declare function validateAgainstSchema(value: unknown, schema: ValidateSchema, schemaSource?: string): ValidateResult;
/**
 * Retry policy. The SDK calls this after each failed validate to
 * decide whether to prepend the schema hint and loop once more, or
 * surface the terminal failure. First failure (attempt 1) → retry.
 * Second failure (attempt 2) → stop.
 */
export declare function shouldRetry(result: ValidateResult, attempt: number): boolean;
/**
 * Build the retry hint prepended to the next iteration's user turn
 * when validation fails. Keeps the language stable so the LLM learns
 * the shape over repeated runs.
 */
export declare function buildRetryHint(result: ValidateResult): string;
//# sourceMappingURL=validate.d.ts.map