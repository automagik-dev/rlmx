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
	readonly type?:
		| "object"
		| "string"
		| "number"
		| "integer"
		| "boolean"
		| "array"
		| "null";
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
export const MAX_VALIDATE_ATTEMPTS = 2;

/**
 * Extract the first JSON schema fenced block from a `VALIDATE.md`
 * markdown file. Accepts ```json, ```jsonc, and bare ``` fences.
 * Returns `null` when no block is present or the block is not valid
 * JSON — the caller decides whether that is fatal or abstains.
 */
export function parseValidateMd(markdown: string): {
	schema: ValidateSchema | null;
	rawBlock: string | null;
} {
	const fence =
		/```(?:json[cC]?|jsonc)?\s*\n([\s\S]*?)```|```\s*\n([\s\S]*?)```/m;
	const match = fence.exec(markdown);
	if (!match) return { schema: null, rawBlock: null };
	const body = (match[1] ?? match[2] ?? "").trim();
	if (body.length === 0) return { schema: null, rawBlock: null };
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return { schema: null, rawBlock: body };
		}
		return { schema: parsed as ValidateSchema, rawBlock: body };
	} catch {
		return { schema: null, rawBlock: body };
	}
}

function describePath(path: readonly (string | number)[]): string {
	if (path.length === 0) return "<root>";
	return path
		.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
		.join("")
		.replace(/^\./, "");
}

function typeOfValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}

function checkType(expected: string, actual: string): boolean {
	if (expected === "number") return actual === "integer" || actual === "number";
	return expected === actual;
}

/**
 * Recursively check `value` against `schema`. Accumulates errors
 * instead of throwing — callers want the full list for retry-hint
 * synthesis, not just the first failure.
 */
export function validateAgainstSchema(
	value: unknown,
	schema: ValidateSchema,
	schemaSource?: string,
): ValidateResult {
	const errors: string[] = [];

	function walk(
		v: unknown,
		s: ValidateSchema,
		path: readonly (string | number)[],
	): void {
		const where = describePath(path);
		if (s.type) {
			const actual = typeOfValue(v);
			if (!checkType(s.type, actual)) {
				errors.push(`${where}: expected ${s.type}, got ${actual}`);
				return; // type mismatch — don't descend
			}
		}

		if (s.enum && !s.enum.some((opt) => Object.is(opt, v))) {
			errors.push(`${where}: value not in enum (${s.enum.join(", ")})`);
		}

		if (s.type === "object" && v && typeof v === "object" && !Array.isArray(v)) {
			const obj = v as Record<string, unknown>;
			if (s.required) {
				for (const key of s.required) {
					if (!(key in obj)) errors.push(`${where}: missing required "${key}"`);
				}
			}
			if (s.properties) {
				for (const [key, childSchema] of Object.entries(s.properties)) {
					if (key in obj) {
						walk(obj[key], childSchema, [...path, key]);
					}
				}
			}
		}

		if (s.type === "array" && Array.isArray(v) && s.items) {
			v.forEach((item, idx) => walk(item, s.items as ValidateSchema, [...path, idx]));
		}
	}

	walk(value, schema, []);
	return { ok: errors.length === 0, errors, schemaSource };
}

/**
 * Retry policy. The SDK calls this after each failed validate to
 * decide whether to prepend the schema hint and loop once more, or
 * surface the terminal failure. First failure (attempt 1) → retry.
 * Second failure (attempt 2) → stop.
 */
export function shouldRetry(
	result: ValidateResult,
	attempt: number,
): boolean {
	if (result.ok) return false;
	return attempt < MAX_VALIDATE_ATTEMPTS;
}

/**
 * Build the retry hint prepended to the next iteration's user turn
 * when validation fails. Keeps the language stable so the LLM learns
 * the shape over repeated runs.
 */
export function buildRetryHint(result: ValidateResult): string {
	if (result.ok) return "";
	const lines: string[] = [];
	lines.push("Your previous `emit_done` payload did not match VALIDATE.md:");
	for (const err of result.errors) lines.push(`  - ${err}`);
	if (result.schemaSource) {
		lines.push("");
		lines.push("Schema (JSON):");
		lines.push(result.schemaSource);
	}
	lines.push("");
	lines.push("Emit a corrected payload.");
	return lines.join("\n");
}
