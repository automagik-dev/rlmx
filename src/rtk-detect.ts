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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RtkStatus {
  available: boolean;
  version?: string;
  path?: string;
}

let cached: RtkStatus | undefined;

/**
 * Detect whether `rtk` is installed and callable.
 * Result is cached for the lifetime of the Node process.
 */
export async function detectRtk(): Promise<RtkStatus> {
  if (cached) return cached;

  try {
    const { stdout: versionOut } = await execFileAsync("rtk", ["--version"], {
      timeout: 2_000,
    });
    const match = versionOut.match(/rtk\s+(\S+)/i);
    const version = match?.[1];

    let path: string | undefined;
    try {
      const { stdout: whichOut } = await execFileAsync("which", ["rtk"], {
        timeout: 2_000,
      });
      const trimmed = whichOut.trim();
      if (trimmed) path = trimmed;
    } catch {
      // `which` unavailable (e.g. Windows) — not fatal, skip path resolution.
    }

    cached = { available: true, version, path };
  } catch {
    cached = { available: false };
  }

  return cached;
}

/** Test-only: reset the cache so tests can re-probe with a stubbed PATH. */
export function _resetRtkCache(): void {
  cached = undefined;
}
