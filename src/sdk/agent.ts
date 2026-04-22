/**
 * `runAgent()` — Wish B Group 2b.
 *
 * Ties the Group 1 event stream and the Group 2 primitives (session,
 * permissions, validate) into a single driving loop. The actual LLM /
 * REPL iteration is supplied by the caller via an `IterationDriver`
 * async generator — this keeps the wiring logic hermetic and
 * testable without needing a live model. When `runAgent` eventually
 * becomes the CLI entry, `rlm.ts` will be adapted into one of these
 * drivers; nothing in this file needs to change for that cutover.
 *
 * Lifecycle:
 *
 *   emit  AgentStart
 *   (if sessionStore)
 *     try resumeAgent → emit SessionOpen{resumed}
 *   loop iteration:
 *     emit IterationStart
 *     consume driver's steps:
 *       "message"     → emit Message; append history
 *       "tool_call"   → permission chain → emit ToolCallBefore/After
 *                       (deny ⇒ emit Error{phase:"tool-denied"})
 *       "emit_done"   → validate if schema supplied:
 *                         pass   → emit Validation{pass} + EmitDone; complete
 *                         fail@1 → emit Validation{fail,1}; loop with hint
 *                         fail@2 → emit Validation{fail,2} + Error; abort
 *                       no schema ⇒ emit EmitDone; complete
 *       "error"       → emit Error; abort
 *     emit IterationOutput (iteration summary)
 *     checkpoint via sessionStore.save
 *   emit SessionClose{reason}
 *   close emitter
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L110-158.
 */

import { createEmitter, type EventStream } from "./emitter.js";
import {
	type AgentStartEvent,
	type EmitDoneEvent,
	type ErrorEvent,
	type IterationOutputEvent,
	type IterationStartEvent,
	makeEvent,
	type MessageEvent,
	type SessionCloseReason,
	type ToolCallAfterEvent,
	type ToolCallBeforeEvent,
	type ValidationEvent,
} from "./events.js";
import {
	type PermissionHook,
	type PermissionHookContext,
	runPermissionChain,
} from "./permissions.js";
import { iso } from "./events.js";
import {
	type BudgetSnapshot,
	type HistoryTurn,
	pauseAgent,
	resumeAgent,
	type SessionState,
	type SessionStore,
} from "./session.js";
import {
	buildRetryHint,
	MAX_VALIDATE_ATTEMPTS,
	shouldRetry,
	type ValidateResult,
	type ValidateSchema,
	validateAgainstSchema,
} from "./validate.js";

/** One step produced by an `IterationDriver` during a single iteration. */
export type IterationStep =
	| {
			readonly kind: "message";
			readonly role: "system" | "user" | "assistant";
			readonly content: string;
	  }
	| {
			readonly kind: "tool_call";
			readonly tool: string;
			readonly args: unknown;
	  }
	| { readonly kind: "emit_done"; readonly payload: unknown }
	| { readonly kind: "error"; readonly error: Error };

export interface IterationRequest {
	readonly sessionId: string;
	readonly iteration: number;
	readonly history: readonly HistoryTurn[];
	/** Present when the previous emit_done failed validation — the
	 *  driver should prepend this to its next model turn. */
	readonly retryHint?: string;
}

export type IterationDriver = (
	req: IterationRequest,
	signal: AbortSignal,
) => AsyncIterable<IterationStep>;

/** Resolves a tool invocation. Called after a non-deny permission
 *  decision. When omitted, tool calls are recorded but not executed
 *  (the `ToolCallAfter.result` is `null`). */
export type ToolResolver = (
	tool: string,
	args: unknown,
	signal: AbortSignal,
) => Promise<unknown>;

export interface AgentConfig {
	readonly agentId: string;
	readonly sessionId: string;
	/** Shown to the first iteration as the user turn; stored in history. */
	readonly input: string;

	readonly driver: IterationDriver;
	readonly toolResolver?: ToolResolver;

	readonly sessionStore?: SessionStore;
	readonly permissionHooks?: readonly PermissionHook[];
	readonly validateSchema?: ValidateSchema;
	readonly validateSchemaSource?: string;

	readonly budget?: BudgetSnapshot;
	/** Hard ceiling to protect against runaway loops. Default 32. */
	readonly maxIterations?: number;

	readonly signal?: AbortSignal;

	/** Opaque snapshot attached to the AgentStart event for consumers. */
	readonly configSnapshot?: Readonly<Record<string, unknown>>;
}

const DEFAULT_MAX_ITERATIONS = 32;
/**
 * Default budget — `limit` is set to `Number.MAX_SAFE_INTEGER` rather
 * than `Infinity` so the snapshot survives `JSON.stringify` roundtrip
 * (which coerces `Infinity` to `null` and would fail the `isSessionState`
 * number check on reload).
 */
const DEFAULT_BUDGET: BudgetSnapshot = {
	spent: 0,
	limit: Number.MAX_SAFE_INTEGER,
	currency: "usd",
};

/** Background driver returned to the caller. Iterate events via `for await`. */
export function runAgent(config: AgentConfig): EventStream {
	const em = createEmitter();
	void drive(config, em).catch((err) => {
		if (!em.closed) {
			const ev: ErrorEvent = makeEvent("Error", {
				sessionId: config.sessionId,
				phase: "runAgent",
				error: {
					name: err instanceof Error ? err.name : "Error",
					message: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				},
			} as Omit<ErrorEvent, "type" | "timestamp">);
			em.emit(ev);
			em.close();
		}
	});
	return em;
}

async function drive(
	config: AgentConfig,
	em: ReturnType<typeof createEmitter>,
): Promise<void> {
	const {
		agentId,
		sessionId,
		input,
		driver,
		toolResolver,
		sessionStore,
		permissionHooks = [],
		validateSchema,
		validateSchemaSource,
		budget = DEFAULT_BUDGET,
		maxIterations = DEFAULT_MAX_ITERATIONS,
		signal,
		configSnapshot = {},
	} = config;

	// ── emit AgentStart ──────────────────────────────────────────────
	const startEv: AgentStartEvent = makeEvent("AgentStart", {
		agentId,
		sessionId,
		config: configSnapshot,
	} as Omit<AgentStartEvent, "type" | "timestamp">);
	em.emit(startEv);

	// ── resume / open session ────────────────────────────────────────
	let history: HistoryTurn[] = [{ role: "user", content: input }];
	let iteration = 0;
	let budgetSnap: BudgetSnapshot = budget;
	let closeReason: SessionCloseReason = "complete";

	if (sessionStore) {
		const prior = await resumeAgent(sessionId, sessionStore, em);
		if (prior) {
			history = [...prior.history];
			iteration = prior.iteration;
			budgetSnap = prior.budget;
		}
	}

	// Propagate abort → emit Error{phase:"abort"} and mark reason.
	const ac = new AbortController();
	const linkAbort = () => {
		closeReason = "abort";
		ac.abort();
	};
	if (signal) {
		if (signal.aborted) linkAbort();
		else signal.addEventListener("abort", linkAbort, { once: true });
	}

	let retryHint: string | undefined;
	let validateAttempt = 0;
	let done = false;

	try {
		iterationLoop: while (!done && iteration < maxIterations && !ac.signal.aborted) {
			iteration++;
			const iterStart: IterationStartEvent = makeEvent("IterationStart", {
				sessionId,
				iteration,
			} as Omit<IterationStartEvent, "type" | "timestamp">);
			em.emit(iterStart);

			const req: IterationRequest = {
				sessionId,
				iteration,
				history: [...history],
				retryHint,
			};
			let iterOutput = "";

			for await (const step of driver(req, ac.signal)) {
				if (ac.signal.aborted) break iterationLoop;

				switch (step.kind) {
					case "message": {
						const ev: MessageEvent = makeEvent("Message", {
							sessionId,
							role: step.role,
							content: step.content,
						} as Omit<MessageEvent, "type" | "timestamp">);
						em.emit(ev);
						history.push({ role: step.role, content: step.content });
						iterOutput += step.content;
						continue;
					}

					case "tool_call": {
						const ctx: PermissionHookContext = {
							tool: step.tool,
							args: step.args,
							sessionId,
							iteration,
							history: [...history],
						};
						const decision = await runPermissionChain(permissionHooks, ctx);
						const effectiveArgs =
							decision.decision === "modify"
								? decision.modifiedArgs
								: step.args;

						const before: ToolCallBeforeEvent = makeEvent("ToolCallBefore", {
							sessionId,
							iteration,
							tool: step.tool,
							args: effectiveArgs,
						} as Omit<ToolCallBeforeEvent, "type" | "timestamp">);
						em.emit(before);

						if (decision.decision === "deny") {
							const afterDeny: ToolCallAfterEvent = makeEvent(
								"ToolCallAfter",
								{
									sessionId,
									iteration,
									tool: step.tool,
									result: null,
									durationMs: 0,
									ok: false,
								} as Omit<ToolCallAfterEvent, "type" | "timestamp">,
							);
							em.emit(afterDeny);
							const err: ErrorEvent = makeEvent("Error", {
								sessionId,
								phase: "tool-denied",
								error: {
									name: "PermissionDenied",
									message: decision.reason,
								},
							} as Omit<ErrorEvent, "type" | "timestamp">);
							em.emit(err);
							continue;
						}

						const t0 = Date.now();
						let result: unknown = null;
						let ok = true;
						try {
							if (toolResolver) {
								result = await toolResolver(
									step.tool,
									effectiveArgs,
									ac.signal,
								);
							}
						} catch (e) {
							ok = false;
							result = e instanceof Error ? e.message : String(e);
							const err: ErrorEvent = makeEvent("Error", {
								sessionId,
								phase: "tool",
								error: {
									name: e instanceof Error ? e.name : "Error",
									message: e instanceof Error ? e.message : String(e),
								},
							} as Omit<ErrorEvent, "type" | "timestamp">);
							em.emit(err);
						}
						const after: ToolCallAfterEvent = makeEvent("ToolCallAfter", {
							sessionId,
							iteration,
							tool: step.tool,
							result,
							durationMs: Date.now() - t0,
							ok,
						} as Omit<ToolCallAfterEvent, "type" | "timestamp">);
						em.emit(after);
						continue;
					}

					case "emit_done": {
						if (validateSchema) {
							validateAttempt++;
							const result: ValidateResult = validateAgainstSchema(
								step.payload,
								validateSchema,
								validateSchemaSource,
							);
							if (result.ok) {
								const v: ValidationEvent = makeEvent("Validation", {
									sessionId,
									status: "pass",
									attempt: validateAttempt,
								} as Omit<ValidationEvent, "type" | "timestamp">);
								em.emit(v);
								const dn: EmitDoneEvent = makeEvent("EmitDone", {
									sessionId,
									payload: step.payload,
								} as Omit<EmitDoneEvent, "type" | "timestamp">);
								em.emit(dn);
								done = true;
								break;
							}
							const vf: ValidationEvent = makeEvent("Validation", {
								sessionId,
								status: "fail",
								attempt: validateAttempt,
								errors: result.errors,
							} as Omit<ValidationEvent, "type" | "timestamp">);
							em.emit(vf);
							if (shouldRetry(result, validateAttempt)) {
								retryHint = buildRetryHint(result);
								// Break out of the inner driver-step loop; the
								// outer `while` restarts with the hint set. The
								// next driver request sees the same history.
								break;
							}
							// Terminal failure.
							const err: ErrorEvent = makeEvent("Error", {
								sessionId,
								phase: "validate",
								error: {
									name: "ValidationFailed",
									message: `retry ceiling (${MAX_VALIDATE_ATTEMPTS}) reached`,
								},
							} as Omit<ErrorEvent, "type" | "timestamp">);
							em.emit(err);
							done = true;
							closeReason = "error";
							break;
						}
						const dn: EmitDoneEvent = makeEvent("EmitDone", {
							sessionId,
							payload: step.payload,
						} as Omit<EmitDoneEvent, "type" | "timestamp">);
						em.emit(dn);
						done = true;
						break;
					}

					case "error": {
						const err: ErrorEvent = makeEvent("Error", {
							sessionId,
							phase: "driver",
							error: {
								name: step.error.name,
								message: step.error.message,
								stack: step.error.stack,
							},
						} as Omit<ErrorEvent, "type" | "timestamp">);
						em.emit(err);
						done = true;
						closeReason = "error";
						break;
					}
				}
			}

			// ── iteration-tail observability + checkpoint ──────────────
			const out: IterationOutputEvent = makeEvent("IterationOutput", {
				sessionId,
				iteration,
				output: iterOutput,
			} as Omit<IterationOutputEvent, "type" | "timestamp">);
			em.emit(out);

			if (sessionStore && !ac.signal.aborted) {
				const snapshot: SessionState = {
					sessionId,
					iteration,
					history: [...history],
					budget: budgetSnap,
					createdAt: iso(),
					updatedAt: iso(),
				};
				await sessionStore.save(snapshot);
			}

			if (!done && retryHint) {
				// Consume the hint on the next turn's driver call.
				// (retryHint is set in the emit_done branch; leave it set so
				// the next loop iteration sees it, then the driver decides
				// whether to clear or retain.)
				// Driver authors can inspect req.retryHint themselves.
			}
		}

		if (ac.signal.aborted && closeReason !== "error") closeReason = "abort";
	} catch (err) {
		closeReason = "error";
		const ev: ErrorEvent = makeEvent("Error", {
			sessionId,
			phase: "runAgent",
			error: {
				name: err instanceof Error ? err.name : "Error",
				message: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			},
		} as Omit<ErrorEvent, "type" | "timestamp">);
		em.emit(ev);
	} finally {
		// Persist final state + emit SessionClose.
		if (sessionStore) {
			const finalSnapshot: SessionState = {
				sessionId,
				iteration,
				history: [...history],
				budget: budgetSnap,
				createdAt: iso(),
				updatedAt: iso(),
			};
			await pauseAgent(finalSnapshot, sessionStore, closeReason, em);
		} else {
			em.emit(
				makeEvent("SessionClose", {
					sessionId,
					reason: closeReason,
				} as never),
			);
		}
		em.close();
	}
}
