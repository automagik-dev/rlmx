#!/usr/bin/env node

/**
 * Version bump script for rlmx.
 *
 * Format: 0.YYMMDD.N
 *   - 0       fixed major prefix
 *   - YYMMDD  today's date (UTC)
 *   - N       1-based daily build counter (from git tags)
 *
 * Env override: RLMX_BUILD_NUMBER — forces N to the given value.
 *
 * Syncs the computed version into:
 *   - package.json         ("version" field)
 *   - src/version.ts       (VERSION export)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTodayPublishCount(datePrefix) {
  try {
    const output = execSync(`git tag --list "v0.${datePrefix}.*"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function generateVersion() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePrefix = `${yy}${mm}${dd}`;

  const envBuild = process.env.RLMX_BUILD_NUMBER;
  const n = envBuild ? Number(envBuild) : getTodayPublishCount(datePrefix) + 1;

  return `0.${datePrefix}.${n}`;
}

// ---------------------------------------------------------------------------
// Sync files
// ---------------------------------------------------------------------------

function syncPackageJson(version) {
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`  package.json -> ${version}`);
}

function syncVersionTs(version) {
  const versionPath = join(root, 'src', 'version.ts');
  const content = `export const VERSION = '${version}';\n`;
  writeFileSync(versionPath, content, 'utf-8');
  console.log(`  src/version.ts -> ${version}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const version = generateVersion();
console.log(`Bumping to ${version}`);
syncPackageJson(version);
syncVersionTs(version);
console.log('Done.');
