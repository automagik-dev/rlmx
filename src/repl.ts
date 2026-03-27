/**
 * REPL manager — Node.js side.
 *
 * Spawns a Python subprocess running repl_server.py, communicates via
 * JSON lines over stdin/stdout, handles lifecycle and per-execution timeout.
 *
 * Features:
 *   - Crash recovery: restarts subprocess and retries once on crash
 *   - Battery tracking: records which battery functions were called
 *   - Tool levels: core / standard (+ batteries) / full (+ package info)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ExecuteResult,
  LLMRequest,
  PythonToNode,
} from "./ipc.js";
import type { ToolsLevel } from "./config.js";
import type { Logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default paths — __dirname is dist/src/ when compiled, python/ is at repo root (../../python/)
const REPL_SERVER_PATH = join(__dirname, "..", "..", "python", "repl_server.py");
const BATTERIES_PATH = join(__dirname, "..", "..", "python", "batteries.py");
const GEMINI_BATTERIES_PATH = join(__dirname, "..", "..", "python", "gemini_batteries.py");

/** Battery function names — tracked for stats. */
const BATTERY_FUNCTION_NAMES = [
  "describe_context",
  "preview_context",
  "search_context",
  "grep_context",
  "chunk_context",
  "chunk_text",
  "map_query",
  "reduce_query",
] as const;

/** Gemini battery function names — tracked for Gemini stats. */
const GEMINI_BATTERY_FUNCTION_NAMES = [
  "web_search",
  "fetch_url",
  "generate_image",
] as const;

/** Options passed to REPL.start() */
export interface REPLStartOptions {
  /** Context to inject (string, list, or dict serialized as JSON string). */
  context?: string | string[] | Record<string, unknown>;
  /** Custom tools to inject as Python code strings (name -> code). */
  tools?: Record<string, string>;
  /** Tool level: core (6 paper functions), standard (+ batteries), full (+ package info). */
  toolsLevel?: ToolsLevel;
  /** Whether to load Gemini batteries (web_search, fetch_url, generate_image). */
  loadGeminiBatteries?: boolean;
  /** Python executable path (default: "python3"). */
  pythonPath?: string;
  /** Path to repl_server.py (auto-detected). */
  serverPath?: string;
  /** Optional logger for crash events and diagnostics. */
  logger?: Logger;
}

/** Callback for handling LLM requests from the Python REPL. */
export type LLMRequestHandler = (
  request: LLMRequest
) => Promise<string[]>;

export class REPL {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private ready = false;
  private pendingResolve: ((msg: PythonToNode) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private llmHandler: LLMRequestHandler | null = null;
  private messageBuffer: PythonToNode[] = [];

  // Crash recovery state
  private _startOptions: REPLStartOptions = {};
  private _recovering = false;

  // Battery tracking
  private _batteriesUsed = new Set<string>();
  private _geminiBatteriesUsed = new Set<string>();
  private _skipTracking = false;

  // Optional logger
  private _logger: Logger | null = null;

  /** Set a handler for LLM requests from Python REPL code. */
  onLLMRequest(handler: LLMRequestHandler): void {
    this.llmHandler = handler;
  }

  /** Start the Python REPL subprocess. */
  async start(options: REPLStartOptions = {}): Promise<void> {
    this._startOptions = options;
    this._logger = options.logger ?? null;

    const pythonPath = options.pythonPath ?? "python3";
    const serverPath = options.serverPath ?? REPL_SERVER_PATH;

    this.process = spawn(pythonPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    this.readline = createInterface({ input: this.process.stdout! });

    // Route each JSON line from Python
    this.readline.on("line", (line: string) => {
      let msg: PythonToNode;
      try {
        msg = JSON.parse(line) as PythonToNode;
      } catch {
        // Not JSON — ignore (should not happen with correct server)
        return;
      }
      this._handleMessage(msg);
    });

    // Collect stderr for diagnostics
    this.process.stderr?.on("data", () => {
      // stderr from Python subprocess — swallow silently
    });

    // Detect unexpected subprocess exit for crash recovery
    this.process.on("exit", () => {
      this.ready = false;
      if (this.pendingReject) {
        this.pendingReject(new Error("REPL subprocess exited unexpectedly"));
        this.pendingReject = null;
        this.pendingResolve = null;
      }
    });

    // Wait for the "ready" message
    await this._waitForMessage("ready");
    this.ready = true;

    // Inject context if provided
    if (options.context !== undefined) {
      await this._injectContext(options.context);
    }

    // Inject custom tools if provided
    if (options.tools) {
      for (const [, code] of Object.entries(options.tools)) {
        await this.execute(code);
      }
    }

    // Load batteries for standard/full tool levels
    const level = options.toolsLevel ?? "core";
    if (level === "standard" || level === "full") {
      await this._loadBatteries();

      // Load Gemini batteries when requested (Google provider with standard/full tools)
      if (options.loadGeminiBatteries) {
        await this._loadGeminiBatteries();
      }
    }
  }

  /** Execute Python code in the REPL and return the result. */
  async execute(code: string, timeoutMs = 30_000): Promise<ExecuteResult> {
    // Distinguish "never started" from "started but crashed"
    if (!this.process) {
      throw new Error("REPL not started. Call start() first.");
    }

    // Process was started but has since crashed — attempt recovery
    if (!this.ready && !this._recovering) {
      return this._recoverAndRetry(
        code,
        timeoutMs,
        new Error("REPL subprocess exited unexpectedly")
      );
    }

    if (!this.ready) {
      throw new Error("REPL not started. Call start() first.");
    }

    // Track battery usage
    this._trackBatteryUsage(code);

    try {
      this._send({ type: "execute", code });
      return await this._waitForExecuteResult(timeoutMs);
    } catch (err) {
      // Attempt crash recovery if process died (not during recovery itself)
      if (!this._recovering && !this.isRunning()) {
        return this._recoverAndRetry(code, timeoutMs, err as Error);
      }
      throw err;
    }
  }

  /** Reset the REPL namespace. */
  async reset(): Promise<void> {
    if (!this.process || !this.ready) return;
    this._send({ type: "reset" });
    await this._waitForMessage("execute_result");
  }

  /** Stop the Python subprocess. */
  async stop(): Promise<void> {
    if (!this.process) return;

    try {
      this._send({ type: "shutdown" });
    } catch {
      // stdin may already be closed
    }

    // Give it 2s to exit gracefully, then kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 2000);

      this.process!.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.readline?.close();
    this.process = null;
    this.readline = null;
    this.ready = false;
  }

  /** Check if the REPL subprocess is running. */
  isRunning(): boolean {
    return this.ready && this.process !== null && this.process.exitCode === null;
  }

  /** Get list of battery functions that were called during this session. */
  getBatteriesUsed(): string[] {
    return [...this._batteriesUsed];
  }

  /** Get list of Gemini battery functions that were called during this session. */
  getGeminiBatteriesUsed(): string[] {
    return [...this._geminiBatteriesUsed];
  }

  // ─── Internal ────────────────────────────────────────────

  private async _loadBatteries(): Promise<void> {
    const code = await readFile(BATTERIES_PATH, "utf-8");
    // Skip battery tracking for the definition code itself
    this._skipTracking = true;
    await this.execute(code);
    this._skipTracking = false;
  }

  private async _loadGeminiBatteries(): Promise<void> {
    const code = await readFile(GEMINI_BATTERIES_PATH, "utf-8");
    this._skipTracking = true;
    await this.execute(code);
    this._skipTracking = false;
  }

  /** Track which battery functions appear in executed code. */
  private _trackBatteryUsage(code: string): void {
    if (this._skipTracking) return;
    for (const name of BATTERY_FUNCTION_NAMES) {
      if (code.includes(name)) {
        this._batteriesUsed.add(name);
      }
    }
    for (const name of GEMINI_BATTERY_FUNCTION_NAMES) {
      if (code.includes(name)) {
        this._geminiBatteriesUsed.add(name);
      }
    }
  }

  /** Restart subprocess after a crash and retry the failed code once. */
  private async _recoverAndRetry(
    code: string,
    timeoutMs: number,
    originalError: Error
  ): Promise<ExecuteResult> {
    this._recovering = true;
    this._logger?.log("repl_exec", {
      crash_recovery: true,
      code_length: code.length,
      original_error: originalError.message,
    });

    try {
      // Clean up dead process state
      this.readline?.close();
      this.process = null;
      this.readline = null;
      this.ready = false;
      this.messageBuffer = [];
      this.pendingResolve = null;
      this.pendingReject = null;

      // Restart with same options
      await this.start(this._startOptions);

      // Retry execution once
      this._send({ type: "execute", code });
      return await this._waitForExecuteResult(timeoutMs);
    } catch (retryErr) {
      throw new Error(
        `REPL subprocess crashed and recovery failed. ` +
          `Original: ${originalError.message}. ` +
          `Retry: ${(retryErr as Error).message}`
      );
    } finally {
      this._recovering = false;
    }
  }

  private _send(msg: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("REPL subprocess stdin not writable");
    }
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  private _handleMessage(msg: PythonToNode): void {
    if (this.pendingResolve) {
      this.pendingResolve(msg);
      this.pendingResolve = null;
      this.pendingReject = null;
    } else {
      this.messageBuffer.push(msg);
    }
  }

  private _nextMessage(): Promise<PythonToNode> {
    // Check buffer first
    if (this.messageBuffer.length > 0) {
      return Promise.resolve(this.messageBuffer.shift()!);
    }
    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  private async _waitForMessage(
    expectedType: string,
    timeoutMs = 10_000
  ): Promise<PythonToNode> {
    return new Promise<PythonToNode>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for "${expectedType}" message`));
      }, timeoutMs);

      const check = async () => {
        const msg = await this._nextMessage();
        if (msg.type === expectedType) {
          clearTimeout(timeout);
          resolve(msg);
        } else {
          // Unexpected message type — keep waiting
          check().catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
        }
      };
      check().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async _waitForExecuteResult(
    timeoutMs: number
  ): Promise<ExecuteResult> {
    return new Promise<ExecuteResult>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Kill the subprocess on timeout
          this.process?.kill("SIGKILL");
          reject(new Error(`REPL execution timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const processMessages = async () => {
        while (!settled) {
          const msg = await this._nextMessage();

          if (msg.type === "execute_result") {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(msg as ExecuteResult);
            }
            return;
          }

          if (msg.type === "llm_request") {
            // Handle LLM request from Python
            const llmReq = msg as LLMRequest;
            let results: string[];

            if (this.llmHandler) {
              try {
                results = await this.llmHandler(llmReq);
              } catch (err) {
                results = llmReq.prompts.map(
                  () => `Error: LLM handler failed — ${err}`
                );
              }
            } else {
              results = llmReq.prompts.map(
                () => "Error: No LLM handler configured"
              );
            }

            // Send response back to Python
            this._send({ type: "llm_response", results });
          }
          // Other message types during execution — ignore
        }
      };

      processMessages().catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private async _injectContext(
    context: string | string[] | Record<string, unknown>
  ): Promise<void> {
    let value: string;
    let valueType: "str" | "list" | "dict";

    if (typeof context === "string") {
      value = context;
      valueType = "str";
    } else if (Array.isArray(context)) {
      value = JSON.stringify(context);
      valueType = "list";
    } else {
      value = JSON.stringify(context);
      valueType = "dict";
    }

    this._send({
      type: "inject",
      name: "context_0",
      value,
      value_type: valueType,
    });

    await this._waitForMessage("execute_result");
  }
}
