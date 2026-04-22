/**
 * rlm-driver — Wish B Group 2b/c.
 *
 * Adapts the rlmx LLM backend (`llmCompleteSimple` from `src/llm.ts`)
 * to the `IterationDriver` contract defined in `src/sdk/agent.ts`.
 * Lets `runAgent()` drive a real LLM end-to-end so permissions,
 * validate, session, and events tick through with production-shaped
 * responses instead of canned fixtures.
 *
 * Design constraints:
 *
 *   • Zero touch to `src/rlm.ts` — the existing CLI entry (`rlmLoop`)
 *     stays byte-for-byte unchanged. This module is additive.
 *   • Shares the same LLM transport (`llmCompleteSimple`) rlm.ts uses,
 *     so any provider / thinking-level / budget work that lands in
 *     `llm.ts` automatically benefits this driver.
 *   • Keeps the surface minimal: one LLM call per iteration, full
 *     response surfaced as a `Message` event, terminal `emit_done`
 *     with the response as payload. Parsing `rlmx`-specific Python
 *     tool-call code blocks is deliberately NOT done here — that's a
 *     larger slice that also requires a REPL executor. This driver
 *     proves the wiring; a follow-up can layer tool dispatch on top.
 *
 * Consumers compose it via `runAgent({ driver: rlmDriver(cfg) })` —
 * never called directly by user code.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L93 (wave 5
 * dogfood), plus the "prove end-to-end wiring against real LLM"
 * mandate added in the G2b review cycle.
 */

import type { ModelConfig } from "../config.js";
import { llmCompleteSimple, type LLMResponse } from "../llm.js";
import type { IterationDriver, IterationRequest } from "./agent.js";

export interface RlmDriverConfig {
	/** Model config — same shape rlm.ts uses. */
	readonly model: ModelConfig;
	/** Optional SYSTEM.md contents; prepended to each turn's prompt. */
	readonly system?: string;
	/**
	 * Injectable LLM completion fn. Defaults to the real
	 * `llmCompleteSimple` so production just calls Gemini. Tests pass a
	 * mock to validate the driver's event sequence without a live model.
	 */
	readonly llm?: (
		prompt: string,
		modelConfig: ModelConfig,
		signal?: AbortSignal,
	) => Promise<LLMResponse>;
	/**
	 * Hook for retry hints. When present, the driver injects the hint
	 * into the prompt prefix on iterations where `req.retryHint` is
	 * set by the runAgent validate pipeline. Default: prepends a
	 * labelled block.
	 */
	readonly retryHintFormatter?: (hint: string) => string;
}

const DEFAULT_RETRY_FORMATTER = (hint: string): string =>
	`# Retry hint from the validator\n\n${hint}\n\n`;

/**
 * Render the iteration's prompt. Keeps it intentionally simple — the
 * driver's job is to get a response surface, not to reproduce the
 * full SYSTEM.md / TOOLS.md / CRITERIA.md synthesis rlm.ts does.
 * Callers needing the full rlm.ts prompt stack should wait for the
 * CLI-cutover slice.
 */
export function formatRlmPrompt(
	config: RlmDriverConfig,
	req: IterationRequest,
): string {
	const parts: string[] = [];
	if (config.system) {
		parts.push(config.system.trim());
	}
	if (req.retryHint && req.retryHint.length > 0) {
		const formatter = config.retryHintFormatter ?? DEFAULT_RETRY_FORMATTER;
		parts.push(formatter(req.retryHint));
	}
	// Fold the user's input + any prior assistant turns into the prompt
	// body. First history entry is always the initial user input (runAgent
	// guarantees this); later assistant turns are appended so the model
	// has continuity across iterations.
	for (const turn of req.history) {
		const label =
			turn.role === "assistant"
				? "Assistant"
				: turn.role === "system"
					? "System"
					: "User";
		parts.push(`${label}: ${turn.content}`);
	}
	return parts.join("\n\n");
}

/**
 * Build an `IterationDriver` that drives one LLM call per iteration.
 * The returned async generator yields a single `message` step with the
 * full response text followed by an `emit_done` step carrying the
 * response as a structured payload: `{ answer: string; usage: UsageStats }`.
 *
 * When the LLM fails (throws, or returns an empty string), the driver
 * yields an `error` step so `runAgent` can surface it as `Error{phase:"driver"}`
 * and close the session with `reason: "error"`.
 */
export function rlmDriver(config: RlmDriverConfig): IterationDriver {
	const llm = config.llm ?? llmCompleteSimple;
	return async function* (req, signal) {
		const prompt = formatRlmPrompt(config, req);
		let response: LLMResponse;
		try {
			response = await llm(prompt, config.model, signal);
		} catch (err) {
			yield {
				kind: "error",
				error: err instanceof Error ? err : new Error(String(err)),
			};
			return;
		}

		const text = (response.text ?? "").trim();
		if (text.length === 0) {
			yield {
				kind: "error",
				error: new Error("rlmDriver: LLM returned empty response"),
			};
			return;
		}

		yield { kind: "message", role: "assistant", content: text };
		yield {
			kind: "emit_done",
			payload: {
				answer: text,
				usage: response.usage,
				iteration: req.iteration,
			},
		};
	};
}
