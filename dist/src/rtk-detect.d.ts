/**
 * RTK (Rust Token Killer) detection.
 *
 * Probes for `rtk` on the user's PATH once per rlmx process and caches the
 * result. Used by the REPL to decide whether the `run_cli` battery should
 * auto-prefix `rtk` for 60-90% token savings on captured CLI output.
 *
 * Fail-open: if rtk is absent, detection returns `{ available: false }` and
 * rlmx continues to work identically without it.
 */
export interface RtkStatus {
    available: boolean;
    version?: string;
    path?: string;
}
/**
 * Detect whether `rtk` is installed and callable.
 * Result is cached for the lifetime of the Node process.
 */
export declare function detectRtk(): Promise<RtkStatus>;
/** Test-only: reset the cache so tests can re-probe with a stubbed PATH. */
export declare function _resetRtkCache(): void;
//# sourceMappingURL=rtk-detect.d.ts.map