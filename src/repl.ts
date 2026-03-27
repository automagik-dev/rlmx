/**
 * REPL manager — Node.js side.
 *
 * Spawns a Python subprocess running repl_server.py, communicates via
 * JSON lines over stdin/stdout, handles lifecycle and per-execution timeout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ExecuteResult,
  LLMRequest,
  PythonToNode,
} from "./ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default Python path for repl_server.py — relative to dist/
const REPL_SERVER_PATH = join(__dirname, "..", "python", "repl_server.py");

/** Options passed to REPL.start() */
export interface REPLStartOptions {
  /** Context to inject (string, array, or dict — arrays/dicts are JSON-serialized). */
  context?: string | unknown[] | Record<string, unknown>;
  /** Custom tools to inject as Python code strings (name -> code). */
  tools?: Record<string, string>;
  /** Python executable path (default: "python3"). */
  pythonPath?: string;
  /** Path to repl_server.py (auto-detected). */
  serverPath?: string;
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
  private llmHandler: LLMRequestHandler | null = null;
  private messageBuffer: PythonToNode[] = [];

  /** Set a handler for LLM requests from Python REPL code. */
  onLLMRequest(handler: LLMRequestHandler): void {
    this.llmHandler = handler;
  }

  /** Start the Python REPL subprocess. */
  async start(options: REPLStartOptions = {}): Promise<void> {
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
  }

  /** Execute Python code in the REPL and return the result. */
  async execute(code: string, timeoutMs = 30_000): Promise<ExecuteResult> {
    if (!this.process || !this.ready) {
      throw new Error("REPL not started. Call start() first.");
    }

    this._send({ type: "execute", code });

    // Wait for execute_result, handling interleaved LLM requests
    const result = await this._waitForExecuteResult(timeoutMs);
    return result;
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

  // ─── Internal ────────────────────────────────────────────

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
    } else {
      this.messageBuffer.push(msg);
    }
  }

  private _nextMessage(): Promise<PythonToNode> {
    // Check buffer first
    if (this.messageBuffer.length > 0) {
      return Promise.resolve(this.messageBuffer.shift()!);
    }
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
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
          check();
        }
      };
      check();
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
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                results = llmReq.prompts.map(
                  () => `Error: LLM handler failed — ${msg}`
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

      processMessages();
    });
  }

  private async _injectContext(
    context: string | unknown[] | Record<string, unknown>
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
