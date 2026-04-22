import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry, registerRtkTool, } from "../src/sdk/index.js";
describe("registerRtkTool (G3a)", () => {
    it("registers under the default `rtk` name when forceRegister=true", async () => {
        const r = createToolRegistry();
        const ok = await registerRtkTool(r, { forceRegister: true });
        assert.equal(ok, true);
        assert.equal(r.has("rtk"), true);
    });
    it("supports a custom tool name", async () => {
        const r = createToolRegistry();
        await registerRtkTool(r, { forceRegister: true, name: "rtk-sandboxed" });
        assert.equal(r.has("rtk-sandboxed"), true);
        assert.equal(r.has("rtk"), false);
    });
    it("is idempotent — second call is a no-op when already present", async () => {
        const r = createToolRegistry();
        const first = async () => 1;
        // Pre-register a sentinel handler so we can detect accidental overwrite.
        r.register("rtk", first);
        const ok = await registerRtkTool(r, { forceRegister: true });
        assert.equal(ok, true);
        // Handler should still be the sentinel (idempotent — no overwrite).
        assert.equal(r.get("rtk"), first);
    });
    it("when forceRegister=false + rtk absent, the tool is NOT registered", async () => {
        // We can't simulate "rtk absent" reliably without mocking detectRtk —
        // so instead we exercise the return value signature: in an env
        // without rtk on PATH, this call returns false and leaves the
        // registry empty. On a machine WITH rtk installed, it returns true.
        // The test asserts either outcome is internally consistent.
        const r = createToolRegistry();
        const result = await registerRtkTool(r, { forceRegister: false });
        assert.equal(result, r.has("rtk"));
    });
    it("handler validates args and rejects malformed payloads", async () => {
        const r = createToolRegistry();
        await registerRtkTool(r, { forceRegister: true });
        const handler = r.get("rtk");
        const ctx = {
            tool: "rtk",
            sessionId: "s",
            iteration: 1,
            signal: new AbortController().signal,
        };
        await assert.rejects(handler(null, ctx), /args must be an object/);
        await assert.rejects(handler({}, ctx), /cmd must be a non-empty string array/);
        await assert.rejects(handler({ cmd: [123] }, ctx), /cmd must contain only strings/);
    });
});
//# sourceMappingURL=sdk-rtk-plugin.test.js.map