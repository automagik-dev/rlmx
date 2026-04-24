/**
 * PgStorage — embedded pgserve lifecycle, context ingestion, and query interface.
 *
 * Spawns pgserve as a child process (Bun-based TCP proxy over embedded PostgreSQL),
 * connects via node-postgres, and provides methods for context storage and retrieval.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import pg from "pg";
import { PROVIDER_LIMITS } from "./cache.js";
const { Client } = pg;
/** Database name used for rlmx context storage */
const RLMX_DB = "rlmx";
/** Schema DDL for the records table */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS records (
  line_num       INT PRIMARY KEY,
  timestamp      TIMESTAMPTZ,
  type           TEXT,
  source         TEXT,
  session_id     TEXT,
  content        TEXT NOT NULL,
  content_tsvector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', left(content, 500000))) STORED
);

CREATE INDEX IF NOT EXISTS idx_records_tsvector ON records USING GIN (content_tsvector);
CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records (timestamp) WHERE timestamp IS NOT NULL;
`;
/** Schema DDL for observability tables */
const OBSERVABILITY_DDL = `
CREATE TABLE IF NOT EXISTS rlmx_sessions (
  id             TEXT PRIMARY KEY,
  query          TEXT NOT NULL,
  context_path   TEXT,
  model          TEXT NOT NULL,
  provider       TEXT NOT NULL,
  status         TEXT DEFAULT 'running',
  config         JSONB,
  started_at     TIMESTAMPTZ DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  iterations     INT,
  input_tokens   BIGINT DEFAULT 0,
  output_tokens  BIGINT DEFAULT 0,
  cached_tokens  BIGINT DEFAULT 0,
  total_cost     NUMERIC(10,6) DEFAULT 0,
  answer_length  INT,
  budget_hit     TEXT
);

CREATE TABLE IF NOT EXISTS rlmx_events (
  id             BIGSERIAL PRIMARY KEY,
  session_id     TEXT REFERENCES rlmx_sessions(id),
  iteration      INT,
  kind           TEXT NOT NULL,
  input_tokens   INT,
  output_tokens  INT,
  cost           NUMERIC(10,6),
  model          TEXT,
  code           TEXT,
  stdout         TEXT,
  stderr         TEXT,
  request_type   TEXT,
  prompt_preview TEXT,
  duration_ms    INT,
  is_error       BOOLEAN DEFAULT false,
  error_message  TEXT,
  data           JSONB,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE VIEW v_cost_breakdown AS
SELECT session_id, model,
  COUNT(*) AS calls,
  SUM(input_tokens) AS total_input,
  SUM(output_tokens) AS total_output,
  SUM(cost) AS total_cost,
  AVG(duration_ms)::INT AS avg_duration_ms
FROM rlmx_events WHERE kind = 'llm_call'
GROUP BY session_id, model;

CREATE OR REPLACE VIEW v_repl_usage AS
SELECT session_id, request_type,
  COUNT(*) AS calls,
  SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS errors,
  AVG(duration_ms)::INT AS avg_duration_ms
FROM rlmx_events WHERE kind IN ('sub_call', 'pg_query', 'repl_exec')
GROUP BY session_id, request_type;
`;
/** Resolve ~ in paths to the user's home directory */
function expandHome(p) {
    if (p.startsWith("~/") || p === "~") {
        return join(homedir(), p.slice(1));
    }
    return p;
}
/**
 * Find a free TCP port by binding to port 0 and reading the assigned port.
 */
async function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            if (addr && typeof addr === "object") {
                const port = addr.port;
                srv.close(() => resolve(port));
            }
            else {
                srv.close(() => reject(new Error("Failed to get free port")));
            }
        });
        srv.on("error", reject);
    });
}
/**
 * Compute adaptive chunk size based on provider limits and storage config.
 */
export function getChunkSize(provider, config) {
    if (config.chunkSize)
        return config.chunkSize;
    const limit = PROVIDER_LIMITS[provider] ?? 128000;
    return Math.floor(limit * config.chunkUtilization * config.charsPerToken);
}
/**
 * PgStorage manages an embedded pgserve instance for large context handling.
 */
export class PgStorage {
    process = null;
    client = null;
    port = 0;
    stopping = false;
    cleanupRegistered = false;
    /** Connection string for the running pgserve instance */
    get connectionString() {
        return `postgresql://postgres:postgres@127.0.0.1:${this.port}/${RLMX_DB}`;
    }
    /** Get the underlying pg Client (for observability recorder). */
    getClient() {
        return this.client;
    }
    /**
     * Start pgserve and connect to it.
     * Returns the connection string once ready.
     */
    async start(config) {
        // Resolve pgserve binary path
        const pgserveBin = this.findPgserveBin();
        // Build CLI args
        const args = [];
        // Port: 0 means auto-assign a free port; otherwise use the specified port
        const requestedPort = config.port === 0 ? await findFreePort() : config.port;
        args.push("--port", String(requestedPort));
        // Mode: persistent uses dataDir, memory uses temp
        if (config.mode === "persistent") {
            const dataDir = expandHome(config.dataDir);
            mkdirSync(dataDir, { recursive: true });
            args.push("--data", dataDir);
        }
        // memory mode: no --data flag = in-memory (pgserve default)
        // Quiet output for embedded use
        args.push("--log", "error");
        args.push("--no-cluster");
        args.push("--no-stats");
        // Spawn pgserve
        this.process = spawn(pgserveBin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });
        // Drain stdio so the 64KB pipe buffers never fill — during WAL
        // recovery of existing persistent-mode data, postgres writes
        // kilobytes of startup logs to stderr. If those pipes aren't
        // drained, the child blocks on write() and exits -2 before the
        // TCP listener comes up (bug #80). Events are consumed and
        // discarded; callers get exit code and error via waitForReady.
        this.process.stdout?.on("data", () => { });
        this.process.stderr?.on("data", () => { });
        // Register cleanup handlers (only once per process)
        if (!this.cleanupRegistered) {
            this.registerCleanup();
            this.cleanupRegistered = true;
        }
        // Wait for pgserve to be ready by polling for connection
        this.port = requestedPort;
        await this.waitForReady();
        // Connect pg client and create schema
        this.client = new Client({ connectionString: this.connectionString });
        await this.client.connect();
        await this.client.query(SCHEMA_DDL);
        await this.client.query(OBSERVABILITY_DDL);
        return this.connectionString;
    }
    /**
     * Ingest a loaded context into the records table.
     * For JSONL: parses each line as JSON, extracts timestamp/type fields.
     * For other text: one record per line.
     */
    async ingest(context, sessionId) {
        if (!this.client)
            throw new Error("PgStorage not started");
        // Clear stale records so re-runs with different context don't keep old data
        await this.client.query("TRUNCATE records");
        // Collect all lines from context, tracking source file when available
        let lines;
        if (context.type === "list") {
            const items = context.content;
            lines = items.flatMap((item) => item.content.split("\n").map((text) => ({ text, source: item.path })));
        }
        else {
            lines = context.content
                .split("\n")
                .map((text) => ({ text, source: null }));
        }
        // Batch insert using multi-row VALUES
        const BATCH_SIZE = 500;
        let ingested = 0;
        for (let i = 0; i < lines.length; i += BATCH_SIZE) {
            const batch = lines.slice(i, i + BATCH_SIZE);
            const values = [];
            const placeholders = [];
            for (let j = 0; j < batch.length; j++) {
                const lineNum = i + j;
                const { text, source } = batch[j];
                if (text.trim() === "")
                    continue;
                const { timestamp, type, content } = parseLine(text);
                const idx = values.length;
                placeholders.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6})`);
                values.push(lineNum, timestamp, type, source, sessionId ?? null, content);
            }
            if (placeholders.length > 0) {
                await this.client.query(`INSERT INTO records (line_num, timestamp, type, source, session_id, content)
           VALUES ${placeholders.join(", ")}`, values);
                ingested += placeholders.length;
            }
        }
        return ingested;
    }
    /**
     * Full-text search via tsvector.
     */
    async search(pattern, limit = 20) {
        if (!this.client)
            throw new Error("PgStorage not started");
        // Convert pattern to tsquery: split words and join with &
        const tsquery = pattern
            .trim()
            .split(/\s+/)
            .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
            .filter(Boolean)
            .join(" & ");
        if (!tsquery)
            return [];
        const result = await this.client.query(`SELECT line_num, source, content, ts_rank(content_tsvector, to_tsquery('english', $1)) AS rank
       FROM records
       WHERE content_tsvector @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`, [tsquery, limit]);
        return result.rows.map((r) => ({
            line_num: r.line_num,
            source: r.source,
            content: r.content,
            rank: parseFloat(r.rank),
        }));
    }
    /**
     * Get records by line number range (inclusive).
     */
    async slice(start, end) {
        if (!this.client)
            throw new Error("PgStorage not started");
        const result = await this.client.query(`SELECT line_num, source, content FROM records
       WHERE line_num >= $1 AND line_num < $2
       ORDER BY line_num`, [start, end]);
        return result.rows;
    }
    /**
     * Filter records by timestamp range.
     */
    async timeRange(from, to) {
        if (!this.client)
            throw new Error("PgStorage not started");
        const result = await this.client.query(`SELECT line_num, timestamp, content FROM records
       WHERE timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
       ORDER BY timestamp`, [from, to]);
        return result.rows;
    }
    /**
     * Count total records.
     */
    async count() {
        if (!this.client)
            throw new Error("PgStorage not started");
        const result = await this.client.query("SELECT COUNT(*)::int AS cnt FROM records");
        return result.rows[0].cnt;
    }
    /**
     * Execute raw SQL (read-only). Supports parameterized queries.
     */
    async query(sql, params) {
        if (!this.client)
            throw new Error("PgStorage not started");
        // Wrap in read-only transaction for safety
        await this.client.query("BEGIN TRANSACTION READ ONLY");
        try {
            const result = params
                ? await this.client.query(sql, params)
                : await this.client.query(sql);
            await this.client.query("COMMIT");
            return result.rows;
        }
        catch (err) {
            await this.client.query("ROLLBACK").catch(() => { });
            throw err;
        }
    }
    /**
     * Stop pgserve: graceful 3s timeout, then SIGKILL.
     */
    async stop() {
        if (this.stopping)
            return;
        this.stopping = true;
        // Close pg client
        if (this.client) {
            try {
                await this.client.end();
            }
            catch {
                // Ignore client close errors
            }
            this.client = null;
        }
        // Kill pgserve process
        const proc = this.process;
        if (proc && proc.pid && !proc.killed) {
            await new Promise((resolve) => {
                const forceKillTimer = setTimeout(() => {
                    try {
                        proc.kill("SIGKILL");
                    }
                    catch {
                        // Already dead
                    }
                    resolve();
                }, 3000);
                proc.once("exit", () => {
                    clearTimeout(forceKillTimer);
                    resolve();
                });
                try {
                    proc.kill("SIGTERM");
                }
                catch {
                    clearTimeout(forceKillTimer);
                    resolve();
                }
            });
        }
        this.process = null;
        this.stopping = false;
    }
    // ─── Private helpers ──────────────────────────────────────
    /** Find the pgserve CLI binary in node_modules */
    findPgserveBin() {
        // Try package-relative first (works for global installs), then cwd fallback
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkgBin = join(__dirname, "..", "..", "node_modules", ".bin", "pgserve");
        if (existsSync(pkgBin))
            return pkgBin;
        // Fallback: resolve from cwd (works for local dev)
        return resolve("node_modules", ".bin", "pgserve");
    }
    /**
     * Wait for pgserve to accept connections (poll with backoff).
     * Throws if not ready within 10 seconds.
     */
    async waitForReady() {
        const deadline = Date.now() + 10_000;
        let lastError = null;
        // Also capture process errors
        const procError = new Promise((_, reject) => {
            if (!this.process)
                return;
            this.process.once("exit", (code) => {
                if (code !== null && code !== 0) {
                    reject(new Error(`pgserve exited with code ${code}`));
                }
            });
            this.process.once("error", (err) => {
                reject(new Error(`pgserve spawn error: ${err.message}`));
            });
        });
        while (Date.now() < deadline) {
            // Fail fast if the process already exited
            if (this.process && typeof this.process.exitCode === 'number') {
                throw new Error(`pgserve exited with code ${this.process.exitCode} before becoming ready`);
            }
            try {
                const testClient = new Client({
                    connectionString: this.connectionString,
                    connectionTimeoutMillis: 1000,
                });
                await Promise.race([testClient.connect(), procError]);
                await testClient.end();
                return;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw new Error(`pgserve did not become ready within 10s: ${lastError?.message ?? "unknown error"}`);
    }
    /** Register process exit handlers for cleanup */
    registerCleanup() {
        const cleanup = () => {
            if (this.process && this.process.pid && !this.process.killed) {
                try {
                    this.process.kill("SIGKILL");
                }
                catch {
                    // Best effort
                }
            }
        };
        process.once("exit", cleanup);
        process.once("SIGTERM", () => {
            cleanup();
            process.exit(128 + 15);
        });
        process.once("SIGINT", () => {
            cleanup();
            process.exit(128 + 2);
        });
        process.once("uncaughtException", (err) => {
            console.error("rlmx: uncaught exception, cleaning up pgserve:", err.message);
            cleanup();
            process.exit(1);
        });
    }
}
// ─── Line parsing ───────────────────────────────────────
/** Common timestamp field names in JSONL data */
const TIMESTAMP_FIELDS = [
    "timestamp",
    "ts",
    "time",
    "datetime",
    "date",
    "created_at",
    "createdAt",
    "@timestamp",
];
/** Common type/category field names in JSONL data */
const TYPE_FIELDS = ["type", "kind", "level", "severity", "category", "event"];
/**
 * Parse a single line of context data.
 * Tries JSON first (JSONL), falls back to plain text.
 */
function parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
        return { timestamp: null, type: null, content: trimmed };
    }
    try {
        const obj = JSON.parse(trimmed);
        if (typeof obj !== "object" || obj === null) {
            return { timestamp: null, type: null, content: trimmed };
        }
        // Extract timestamp
        let timestamp = null;
        for (const field of TIMESTAMP_FIELDS) {
            if (obj[field] !== undefined && obj[field] !== null) {
                timestamp = String(obj[field]);
                break;
            }
        }
        // Extract type
        let type = null;
        for (const field of TYPE_FIELDS) {
            if (obj[field] !== undefined && obj[field] !== null) {
                type = String(obj[field]);
                break;
            }
        }
        return { timestamp, type, content: trimmed };
    }
    catch {
        // Malformed JSON — log warning and treat as plain text
        process.stderr.write(`rlmx: warning: skipping malformed JSONL line: ${trimmed.slice(0, 80)}...\n`);
        return { timestamp: null, type: null, content: trimmed };
    }
}
//# sourceMappingURL=storage.js.map