/**
 * RTK tool plugin — Wish B Group 3a.
 *
 * Exposes `rtk` (Rust Token Killer) as a first-class entry in the
 * SDK tool registry. When the `rtk` binary is on PATH, the plugin
 * shells out to it; otherwise the registration is a no-op and the
 * registry never gains the tool. This mirrors the existing rlmx
 * `rtk.enabled: auto` policy (`rlm.ts` + `rtk-detect.ts`): agents
 * that declare `rtk` in `agent.yaml` get it for free on machines
 * with rtk installed, and silently degrade on machines without.
 *
 * The plugin's handler signature:
 *
 *   args: { cmd: string[]; timeoutMs?: number }
 *   returns: { stdout: string; stderr: string; exitCode: number; durationMs: number }
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L27 (RTK fully wired
 * native, zero user config).
 */
import type { ToolRegistry } from "./tool-registry.js";
export interface RtkToolArgs {
    readonly cmd: readonly string[];
    readonly timeoutMs?: number;
}
export interface RtkToolResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly durationMs: number;
}
export interface RegisterRtkOptions {
    /** Override the tool name. Default: `"rtk"`. Use a distinct name
     *  if your agent needs two RTK-flavoured tools (e.g. one sandboxed
     *  + one raw) and you want both in the same registry. */
    readonly name?: string;
    /** When true, the registry always gains the tool even if
     *  `rtk-detect` says RTK is unavailable. The handler then fails at
     *  call time. Default: false (only register when detected). */
    readonly forceRegister?: boolean;
}
/**
 * Register RTK as a first-class tool in `registry`. Returns `true`
 * when the tool was registered, `false` when RTK isn't on PATH (and
 * `forceRegister` wasn't set). Idempotent: a second call with RTK
 * already present in the registry is a no-op.
 */
export declare function registerRtkTool(registry: ToolRegistry, options?: RegisterRtkOptions): Promise<boolean>;
//# sourceMappingURL=rtk-plugin.d.ts.map