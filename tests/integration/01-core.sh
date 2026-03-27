#!/usr/bin/env bash
# tests/integration/01-core.sh — Core verification tests 1-9 for rlmx
# Runs against a live Gemini API. Requires GEMINI_API_KEY.
#
# Usage: bash tests/integration/01-core.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# ── Setup ────────────────────────────────────────────────────
# Load API key from tools/.env if not already set
if [ -z "${GEMINI_API_KEY:-}" ]; then
  if [ -f /home/genie/tools/.env ]; then
    # .env doesn't use 'export', so we parse and export manually
    while IFS='=' read -r key value; do
      [[ -z "$key" || "$key" =~ ^# ]] && continue
      export "$key=$value"
    done < /home/genie/tools/.env
  fi
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "FATAL: GEMINI_API_KEY not set. Cannot run integration tests."
  exit 1
fi

CLI="node dist/src/cli.js"
PASS_COUNT=0
FAIL_COUNT=0
TMPDIR_BASE="/tmp/rlmx-integration-$$"
mkdir -p "$TMPDIR_BASE"

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  PASS"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  FAIL: $1"
}

cleanup() {
  rm -rf "$TMPDIR_BASE"
  # Clean up any .tgz files created during testing (leave pre-existing ones)
  rm -f "$REPO_ROOT/rlmx-0.4.0.tgz"
}
trap cleanup EXIT

echo "rlmx integration tests (01-core.sh)"
echo "====================================="
echo ""

# ── Test 1: npm pack produces .tgz ──────────────────────────
echo "Test 1: npm pack succeeds and produces .tgz"
rm -f rlmx-*.tgz 2>/dev/null || true
PACK_OUTPUT=$(npm pack 2>&1)
if ls rlmx-*.tgz >/dev/null 2>&1; then
  pass
else
  fail "npm pack did not produce a .tgz file"
fi

# ── Test 2: rlmx init creates valid rlmx.yaml ───────────────
echo "Test 2: rlmx init creates valid rlmx.yaml"
INIT_DIR="$TMPDIR_BASE/init-test"
$CLI init --dir "$INIT_DIR" >/dev/null 2>&1
if [ -f "$INIT_DIR/rlmx.yaml" ]; then
  # Validate it's parseable YAML with a model section
  if python3 -c "
import yaml, sys
with open('$INIT_DIR/rlmx.yaml') as f:
    cfg = yaml.safe_load(f)
assert isinstance(cfg, dict), 'not a dict'
assert 'model' in cfg, 'no model key'
assert cfg['model']['provider'] == 'google', 'provider not google'
" 2>/dev/null; then
    pass
  else
    fail "rlmx.yaml is not valid YAML or missing expected keys"
  fi
else
  fail "rlmx.yaml not created at $INIT_DIR/rlmx.yaml"
fi

# ── Test 3: rlmx "What is 2+2?" returns JSON with "4" ───────
echo "Test 3: rlmx 'What is 2+2?' --output json returns valid JSON with answer"
QUERY_OUTPUT=$($CLI "What is 2+2?" --output json --max-iterations 3 2>/dev/null)
if python3 -c "
import json, sys
data = json.loads('''$QUERY_OUTPUT''')
answer = str(data.get('answer', ''))
assert '4' in answer, f'answer does not contain 4: {answer!r}'
" 2>/dev/null; then
  pass
else
  # Retry once in case LLM gave a verbose answer
  QUERY_OUTPUT=$($CLI "What is 2+2? Reply with ONLY the number." --output json --max-iterations 3 2>/dev/null)
  if echo "$QUERY_OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
answer = str(data.get('answer', ''))
assert '4' in answer, f'answer does not contain 4: {answer!r}'
" 2>/dev/null; then
    pass
  else
    fail "JSON output does not contain '4' in answer field. Got: $(echo "$QUERY_OUTPUT" | head -c 200)"
  fi
fi

# ── Test 4: rlmx with --context + --tools standard ───────────
echo "Test 4: rlmx with --context ./src/ --tools standard loads context + batteries"
CTX_OUTPUT=$($CLI "List the files you see in context" --context ./src/ --tools standard --output json --max-iterations 2 2>/dev/null)
if echo "$CTX_OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
answer = str(data.get('answer', ''))
# The answer should mention at least some source files
found = 0
for name in ['cli', 'config', 'rlm', 'repl', 'llm']:
    if name in answer.lower():
        found += 1
assert found >= 2, f'answer references only {found} source files (need >= 2): {answer[:300]!r}'
" 2>/dev/null; then
  pass
else
  fail "context not loaded or source files not referenced. Got: $(echo "$CTX_OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("answer","")[:300])' 2>/dev/null || echo "$CTX_OUTPUT" | head -c 300)"
fi

# ── Test 5: --stats produces stats on stderr ─────────────────
echo "Test 5: --stats produces JSON stats on stderr"
STATS_FILE="$TMPDIR_BASE/stats.txt"
$CLI "Say hello" --stats --output text --max-iterations 2 >/dev/null 2>"$STATS_FILE"
if [ -s "$STATS_FILE" ]; then
  # The stats file may contain stderr lines from the REPL plus the JSON stats line
  # Find the JSON line with stats
  if python3 -c "
import json, sys
lines = open('$STATS_FILE').readlines()
found = False
for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        if 'total_tokens' in data and 'total_cost' in data:
            assert data['total_tokens'] > 0, 'total_tokens is 0'
            found = True
            break
    except json.JSONDecodeError:
        continue
assert found, f'no valid stats JSON found in stderr ({len(lines)} lines)'
" 2>/dev/null; then
    pass
  else
    fail "stderr does not contain valid JSON stats. Content: $(cat "$STATS_FILE" | head -c 300)"
  fi
else
  fail "stats file is empty"
fi

# ── Test 6: --log writes valid JSONL ──────────────────────────
echo "Test 6: --log writes valid JSONL"
LOG_FILE="$TMPDIR_BASE/run.jsonl"
$CLI "Say hello" --log "$LOG_FILE" --max-iterations 2 >/dev/null 2>/dev/null
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  if python3 -c "
import json, sys
valid = 0
with open('$LOG_FILE') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        data = json.loads(line)  # will throw if not valid JSON
        assert 'event' in data, 'missing event field'
        assert 'run_id' in data, 'missing run_id field'
        valid += 1
assert valid >= 2, f'expected at least 2 log entries, got {valid}'
" 2>/dev/null; then
    pass
  else
    fail "JSONL log entries are not valid JSON or missing required fields. Content: $(cat "$LOG_FILE" | head -c 300)"
  fi
else
  fail "log file not created or empty at $LOG_FILE"
fi

# ── Test 7: --max-cost budget control ────────────────────────
echo "Test 7: --max-cost 0.001 triggers budget_hit"
BUDGET_OUTPUT=$($CLI "Write a very long essay about everything" --max-cost 0.001 --max-iterations 100 --output json 2>/dev/null)
if echo "$BUDGET_OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
budget_hit = data.get('budgetHit', None)
# Budget should be hit (max-cost) since we set a very low limit
assert budget_hit is not None, f'budgetHit is null, expected max-cost'
assert budget_hit == 'max-cost', f'budgetHit is {budget_hit!r}, expected max-cost'
" 2>/dev/null; then
  pass
else
  fail "budget_hit not set to max-cost. Got: $(echo "$BUDGET_OUTPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"budgetHit={d.get(\"budgetHit\")}")' 2>/dev/null || echo "$BUDGET_OUTPUT" | head -c 300)"
fi

# ── Test 8: Python version check ────────────────────────────
echo "Test 8: Python version check returns valid result"
PY_CHECK=$(node -e "import('./dist/src/detect.js').then(m => m.checkPythonVersion().then(v => console.log(JSON.stringify(v))))" 2>/dev/null)
if echo "$PY_CHECK" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'version' in data, 'missing version field'
assert 'valid' in data, 'missing valid field'
assert data['valid'] == True, f'Python not valid: {data}'
# Version should be 3.10+
parts = data['version'].split('.')
major, minor = int(parts[0]), int(parts[1])
assert major >= 3 and minor >= 10, f'Python version too old: {data[\"version\"]}'
" 2>/dev/null; then
  pass
else
  fail "Python version check failed. Got: $PY_CHECK"
fi

# ── Test 9: REPL crash recovery ─────────────────────────────
echo "Test 9: REPL crash recovery — subprocess restart works"
# Test that the REPL can start, execute code, survive a crash (simulated via
# killing the python subprocess), and recover to execute more code.
REPL_OUTPUT=$(node -e "
import { REPL } from './dist/src/repl.js';

async function test() {
  const repl = new REPL();
  await repl.start();

  // Execute some code — should succeed
  const r1 = await repl.execute('x = 42; print(x)');
  if (!r1.stdout.includes('42')) {
    console.log(JSON.stringify({pass: false, reason: 'initial exec failed', stdout: r1.stdout}));
    await repl.stop();
    return;
  }

  // Kill the underlying python process to simulate crash
  // Access the internal process via the private field
  const proc = (repl as any).process;
  if (proc) {
    proc.kill('SIGKILL');
    // Wait a tick for the exit event to fire
    await new Promise(r => setTimeout(r, 200));
  }

  // Execute code again — should trigger crash recovery
  try {
    const r2 = await repl.execute('y = 99; print(y)');
    if (r2.stdout.includes('99')) {
      console.log(JSON.stringify({pass: true, reason: 'crash recovery succeeded'}));
    } else {
      console.log(JSON.stringify({pass: false, reason: 'recovery exec output wrong', stdout: r2.stdout}));
    }
  } catch (err) {
    console.log(JSON.stringify({pass: false, reason: 'recovery threw: ' + err.message}));
  }

  await repl.stop();
}

test().catch(err => console.log(JSON.stringify({pass: false, reason: 'test error: ' + err.message})));
" 2>/dev/null)

if echo "$REPL_OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data.get('pass') == True, f'REPL crash recovery failed: {data.get(\"reason\", \"unknown\")}'
" 2>/dev/null; then
  pass
else
  fail "REPL crash recovery failed. Got: $REPL_OUTPUT"
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "====================================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed (out of 9)"
echo "====================================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
