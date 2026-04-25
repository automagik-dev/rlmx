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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectRtk } from "../rtk-detect.js";
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Validate the args shape at call time — the SDK's ToolResolver hands
 * us `unknown`, so we guard before spawning a subprocess.
 */
function validateArgs(raw) {
    if (!raw || typeof raw !== "object") {
        throw new TypeError("rtk: args must be an object");
    }
    const r = raw;
    if (!Array.isArray(r.cmd) || r.cmd.length === 0) {
        throw new TypeError("rtk: args.cmd must be a non-empty string array");
    }
    const cmd = r.cmd.filter((c) => typeof c === "string");
    if (cmd.length !== r.cmd.length) {
        throw new TypeError("rtk: args.cmd must contain only strings");
    }
    const timeoutMs = typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs)
        ? r.timeoutMs
        : undefined;
    return { cmd, timeoutMs };
}
function makeRtkHandler() {
    return async (argsRaw, ctx) => {
        const args = validateArgs(argsRaw);
        const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const t0 = Date.now();
        const [bin, ...rest] = args.cmd;
        // cmd[0] shadows the rtk binary on PATH — spawn it directly.
        // This matches the "auto-prefix" behaviour rlmx's run_cli uses
        // (cf. rlm.ts). Consumers that want literal `rtk <subcmd>`
        // invocations should pass `cmd: ["rtk", ...]` explicitly.
        try {
            const { stdout, stderr } = await execFileAsync(bin ?? "rtk", rest, {
                timeout: timeoutMs,
                signal: ctx.signal,
                maxBuffer: 4 * 1024 * 1024,
            });
            const result = {
                stdout,
                stderr,
                exitCode: 0,
                durationMs: Date.now() - t0,
            };
            return result;
        }
        catch (err) {
            if (err && typeof err === "object" && "code" in err) {
                const e = err;
                const code = typeof e.code === "number" ? e.code : 1;
                return {
                    stdout: e.stdout ?? "",
                    stderr: e.stderr ?? e.message,
                    exitCode: code,
                    durationMs: Date.now() - t0,
                };
            }
            throw err;
        }
    };
}
/**
 * Register RTK as a first-class tool in `registry`. Returns `true`
 * when the tool was registered, `false` when RTK isn't on PATH (and
 * `forceRegister` wasn't set). Idempotent: a second call with RTK
 * already present in the registry is a no-op.
 */
export async function registerRtkTool(registry, options = {}) {
    const name = options.name ?? "rtk";
    if (registry.has(name))
        return true;
    const detected = await detectRtk();
    if (!detected.available && !options.forceRegister)
        return false;
    registry.register(name, makeRtkHandler());
    return true;
}
//# sourceMappingURL=rtk-plugin.js.map