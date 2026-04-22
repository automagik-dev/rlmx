#!/usr/bin/env node
/**
 * Cross-context `prepare` hook.
 *
 * npm / bun run `prepare` in two very different situations:
 *
 *   1. **Local development checkout** — `npm install` inside rlmx's
 *      own repo. husky is present as a devDependency; we want it to
 *      set up git hooks. Downstream consumers haven't installed us
 *      yet, so building `dist/` is nice-to-have (covered by `npm run
 *      build` when the dev actually works).
 *
 *   2. **Git-URL install by a consumer** — e.g.
 *      `npm install git+https://github.com/automagik-dev/rlmx#<sha>`.
 *      Consumers only install our `dependencies`, so husky is NOT
 *      present. But they rely on our `main` field
 *      (`./dist/src/index.js`) which DOES NOT EXIST in git (we publish
 *      it via the `files` field in the npm tarball, which git doesn't
 *      mirror). So we must build `dist/` at install time.
 *
 * This script handles both: try to run husky (no-op in consumer
 * context where it's missing), then run the build unconditionally.
 * Any build failure is loud — a consumer with a broken install is a
 * landmine; better to fail the install than to leave it silent.
 *
 * Spec: dogfood-fresh + simone feedback on brain PR #352's dist-copy
 * caveat (2026-04-22).
 */

import { spawnSync } from "node:child_process";

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
		...opts,
	});
	return r.status ?? 1;
}

function runOptional(cmd, args) {
	const r = spawnSync(cmd, args, {
		stdio: ["ignore", "ignore", "ignore"],
		shell: process.platform === "win32",
	});
	// Silently ignore — husky absence isn't an error in a consumer
	// install, only a dev-env miss.
	return r.status === 0;
}

// 1. husky — dev git hooks. Silent fallthrough when missing.
runOptional("husky", []);

// 2. build — required in consumer contexts. Loud failure.
const buildStatus = run("npm", ["run", "build"]);
if (buildStatus !== 0) {
	console.error(
		`[rlmx prepare] build failed (exit ${buildStatus}). dist/ not produced — consumers will fail to import. See the build output above.`,
	);
	process.exit(buildStatus);
}
