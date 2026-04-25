/**
 * RTK integration test — end-to-end subprocess routing through the Python REPL.
 *
 * Boots the same REPL surface that `rlmLoop` uses, executes `run_cli` against a
 * stubbed `rtk` on PATH, and asserts the stub was invoked (the command did go
 * through rtk) when rtkEnabled is on.
 *
 * Skips gracefully when the host Python or `git` is missing so CI with a thin
 * toolchain does not break.
 */
export {};
//# sourceMappingURL=rtk-integration.test.d.ts.map