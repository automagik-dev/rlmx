/**
 * PgStorage — embedded pgserve lifecycle, context ingestion, and query interface.
 *
 * Spawns pgserve as a child process (Bun-based TCP proxy over embedded PostgreSQL),
 * connects via node-postgres, and provides methods for context storage and retrieval.
 */
import type { StorageConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
declare const Client: typeof import("pg").Client;
/**
 * Compute adaptive chunk size based on provider limits and storage config.
 */
export declare function getChunkSize(provider: string, config: StorageConfig): number;
/**
 * PgStorage manages an embedded pgserve instance for large context handling.
 */
export declare class PgStorage {
    private process;
    private client;
    private port;
    private stopping;
    private cleanupRegistered;
    /** Connection string for the running pgserve instance */
    get connectionString(): string;
    /** Get the underlying pg Client (for observability recorder). */
    getClient(): InstanceType<typeof Client> | null;
    /**
     * Start pgserve and connect to it.
     * Returns the connection string once ready.
     */
    start(config: StorageConfig): Promise<string>;
    /**
     * Ingest a loaded context into the records table.
     * For JSONL: parses each line as JSON, extracts timestamp/type fields.
     * For other text: one record per line.
     */
    ingest(context: LoadedContext, sessionId?: string): Promise<number>;
    /**
     * Full-text search via tsvector.
     */
    search(pattern: string, limit?: number): Promise<Array<{
        line_num: number;
        content: string;
        rank: number;
    }>>;
    /**
     * Get records by line number range (inclusive).
     */
    slice(start: number, end: number): Promise<Array<{
        line_num: number;
        content: string;
    }>>;
    /**
     * Filter records by timestamp range.
     */
    timeRange(from: string, to: string): Promise<Array<{
        line_num: number;
        timestamp: string;
        content: string;
    }>>;
    /**
     * Count total records.
     */
    count(): Promise<number>;
    /**
     * Execute raw SQL (read-only). Supports parameterized queries.
     */
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
    /**
     * Stop pgserve: graceful 3s timeout, then SIGKILL.
     */
    stop(): Promise<void>;
    /** Find the pgserve CLI binary in node_modules */
    private findPgserveBin;
    /**
     * Wait for pgserve to accept connections (poll with backoff).
     * Throws if not ready within 10 seconds.
     */
    private waitForReady;
    /** Register process exit handlers for cleanup */
    private registerCleanup;
}
export {};
//# sourceMappingURL=storage.d.ts.map