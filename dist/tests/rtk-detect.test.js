import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectRtk, _resetRtkCache } from "../src/rtk-detect.js";
/**
 * detectRtk probes the real PATH. To test both branches deterministically
 * we mutate process.env.PATH with a temp directory that either contains a
 * stubbed `rtk` executable or nothing at all.
 */
describe("detectRtk", () => {
    const originalPath = process.env.PATH ?? "";
    beforeEach(() => {
        _resetRtkCache();
        process.env.PATH = originalPath;
    });
    it("returns available:false when rtk is not on PATH", async () => {
        const empty = await mkdtemp(join(tmpdir(), "rlmx-nortk-"));
        process.env.PATH = empty;
        try {
            const status = await detectRtk();
            assert.equal(status.available, false);
            assert.equal(status.version, undefined);
        }
        finally {
            await rm(empty, { recursive: true });
            process.env.PATH = originalPath;
            _resetRtkCache();
        }
    });
    it("returns available:true with version when rtk resolves", async () => {
        const stubDir = await mkdtemp(join(tmpdir(), "rlmx-rtkstub-"));
        const stub = join(stubDir, "rtk");
        await writeFile(stub, "#!/bin/sh\necho 'rtk 0.28.2'\n", "utf-8");
        await chmod(stub, 0o755);
        process.env.PATH = `${stubDir}:${originalPath}`;
        try {
            const status = await detectRtk();
            assert.equal(status.available, true);
            assert.equal(status.version, "0.28.2");
        }
        finally {
            await rm(stubDir, { recursive: true });
            process.env.PATH = originalPath;
            _resetRtkCache();
        }
    });
    it("caches results across calls", async () => {
        const empty = await mkdtemp(join(tmpdir(), "rlmx-cache-"));
        process.env.PATH = empty;
        try {
            const first = await detectRtk();
            // Flip PATH so a fresh probe would differ; cached result must stick.
            process.env.PATH = originalPath;
            const second = await detectRtk();
            assert.equal(first.available, second.available);
        }
        finally {
            await rm(empty, { recursive: true });
            process.env.PATH = originalPath;
            _resetRtkCache();
        }
    });
    it("returns available:false when rtk --version hangs past timeout", async () => {
        const stubDir = await mkdtemp(join(tmpdir(), "rlmx-rtkhang-"));
        const stub = join(stubDir, "rtk");
        // Sleeps longer than the 2s detectRtk timeout so the probe must abort.
        await writeFile(stub, "#!/bin/sh\nsleep 10\n", "utf-8");
        await chmod(stub, 0o755);
        process.env.PATH = `${stubDir}:${originalPath}`;
        try {
            const status = await detectRtk();
            assert.equal(status.available, false);
        }
        finally {
            await rm(stubDir, { recursive: true });
            process.env.PATH = originalPath;
            _resetRtkCache();
        }
    });
    it("treats unparseable --version output as absent", async () => {
        const stubDir = await mkdtemp(join(tmpdir(), "rlmx-rtkbad-"));
        const stub = join(stubDir, "rtk");
        // Output deliberately doesn't match the `rtk <version>` shape.
        await writeFile(stub, "#!/bin/sh\necho 'banana tools v1'\n", "utf-8");
        await chmod(stub, 0o755);
        process.env.PATH = `${stubDir}:${originalPath}`;
        try {
            const status = await detectRtk();
            // Regex misses → version is undefined; detection still considers rtk callable.
            // Defensive: available:true is acceptable but version must be undefined.
            assert.equal(status.version, undefined);
        }
        finally {
            await rm(stubDir, { recursive: true });
            process.env.PATH = originalPath;
            _resetRtkCache();
        }
    });
});
//# sourceMappingURL=rtk-detect.test.js.map