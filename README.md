# rlmx

RLM algorithm CLI for coding agents — prompt externalization, Python REPL with symbolic recursion, code-driven navigation.

Based on the [RLM paper](https://arxiv.org/abs/2501.12599) (REPL-based LLM Method). Uses [pi/ai](https://github.com/nickarora/pi-ai) as the multi-provider LLM client.

## Production validation (2026-04-22)

The SDK (`rlmx.sdk.*`) is production-validated via its first consumer,
`khal-os/brain`, a multi-agent pipeline over WhatsApp / long-form
archives. Three agent bridges run through `sdk.runAgent()`:

| bridge | role | slate | status |
|---|---|---|---|
| L1 triage | worth-processing filter | 30 windows | **SHIP 30/30** structural match vs legacy path |
| L2 preservation | multi-step extraction + brain mutation | 24 windows | **SHIP at variance ceiling** (baseline×baseline ≈ baseline×bridge) |
| L3 audit | sampled self-audit | slate in flight | pending verdict |

Evidence depth (metadata only — no content):

- Dogfood reports live in the brain repo under
  `brain-lab/rlmx-sdk-bridge-report/` (L1) and
  `brain-lab/rlmx-sdk-bridge-report-l2/` (L2). Each carries a
  `SHIP-decision.md` with the baseline-vs-bridge delta table + stop-
  reason distribution.
- Event streams, permission hooks, validate-with-retry, and session
  checkpoints are all exercised per-window. Cost and latency are
  captured per iteration.
- Brain's bridge pattern (an outer `IterationDriver` wrapping the
  legacy pi-agent loop) is a reusable template for consumers that
  want to migrate a working agent into the SDK without rewriting
  its internals. See `src/agent/rlmx-bridge.ts` in `khal-os/brain`
  for the reference implementation.

**Stability stamp:** `schema_version: 1` + `tools_api: 1` are the
fields every bridge has shipped against. See
[`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md) for the
schema itself.

## Install

```bash
npm install -g rlmx
```

## Quick Start

```bash
# Scaffold config files in current directory
rlmx init

# Run a query
rlmx "What is the meaning of life?"

# Query with context (directory of docs)
rlmx "How does IPC work?" --context ./docs/

# Query with a single file as context
rlmx "Summarize this paper" --context paper.md --output json

# Pipe data in
cat data.csv | rlmx "Analyze this dataset"
```

## SDK (`rlmx.sdk.*`)

rlmx also ships a programmatic SDK for consumers that need to drive
agents from code — with per-iteration observability, permission
hooks, validate-with-retry, session checkpointing, and a pluggable
tool registry. The CLI path above is untouched; the SDK is purely
additive.

```ts
import { sdk } from "@automagik/rlmx";

const spec = await sdk.loadAgentSpec("./my-agent");
const registry = sdk.createToolRegistry();
await sdk.registerRtkTool(registry);
await sdk.loadPluginTools(spec, registry);

for await (const ev of sdk.runAgent({
	agentId: "my-agent",
	sessionId: "s-1",
	input: "what's new?",
	driver: sdk.rlmDriver({
		model: { provider: "google", model: "gemini-2.5-flash" },
		system: await Bun.file("./my-agent/SYSTEM.md").text(),
	}),
	toolRegistry: registry,
})) {
	console.log(ev.type, ev.timestamp);
}
```

Deeper dives:

- [`docs/sdk-overview.md`](docs/sdk-overview.md) — layered architecture + design principles.
- [`docs/events.md`](docs/events.md) — the 12-event catalogue + emitter contract.
- [`docs/tool-authoring.md`](docs/tool-authoring.md) — TS/MJS + Python plugin recipes, RTK integration.
- [`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md) — `agent.yaml` field reference.
- [`examples/`](examples/) — three runnable example agents (hello-world / research-agent / brain-triage) with smoke tests.

## RTK Integration (token savings)

rlmx auto-detects [RTK](https://github.com/rtk-ai/rtk) and routes CLI subprocess calls through it when available, for 60-90% token savings on tool outputs.

### Install RTK (optional)

```bash
brew install rtk                                                                             # macOS
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh    # Linux/macOS
cargo install --git https://github.com/rtk-ai/rtk                                            # Rust
```

### How it works

- In your `TOOLS.md`, use `run_cli(cmd, *args)` instead of raw `subprocess.run(...)`
- When RTK is installed, `run_cli` transparently prefixes with `rtk` → filtered output
- When RTK is absent, `run_cli` passes through unchanged — no behavior break

### Configuration

```yaml
# rlmx.yaml
rtk:
  enabled: auto   # auto | always | never (default: auto)
```

- `auto` — use RTK when detected on PATH, otherwise pass through (fail-open)
- `always` — require RTK; `rlmx doctor` exits non-zero if missing
- `never` — disable prefix even when RTK is installed

### Verify

```bash
rlmx doctor         # shows RTK status (installed version + mode)
rtk gain            # shows token savings from rlmx + other RTK integrations
```

### Before / after

```python
# Before — raw subprocess, full git output consumes tokens
import subprocess
out = subprocess.run(["git", "log", "-n", "10"], capture_output=True, text=True).stdout

# After — run_cli auto-routes through rtk when available
r = run_cli("git", "log", "-n", "10")
out = r["stdout"]   # filtered + compact; ~60-90% fewer tokens
```

## How It Works

rlmx implements the RLM (REPL-LM) algorithm:

1. **Prompt externalization** — Your context (files, directories) is loaded into a Python REPL as the `context` variable. Only metadata (type, size, chunk lengths) appears in the LLM message history. The LLM never sees the raw context in its messages.

2. **Iterative REPL loop** — The LLM writes Python code in ` ```repl``` ` blocks. rlmx executes each block in a persistent Python subprocess, feeds results back, and the LLM iterates until it calls `FINAL()` or `FINAL_VAR()`.

3. **Recursive sub-calls** — Inside REPL code, the LLM can call:
   - `llm_query(prompt)` — single LLM completion (fast, one-shot)
   - `llm_query_batched(prompts)` — concurrent LLM calls
   - `rlm_query(prompt)` — spawn a child RLM session (full iterative loop)
   - `rlm_query_batched(prompts)` — parallel child RLM sessions

4. **Termination** — The loop ends when the LLM calls `FINAL("answer")` or `FINAL_VAR("variable_name")`, or when max iterations (default 30) is reached.

## CAG Mode (Cache-Augmented Generation)

CAG mode bakes your full context into the system prompt and leverages provider-level caching so that subsequent queries against the same context are dramatically cheaper and faster.

### When to use `--cache` vs default RLM

| Mode | Best for | How it works |
|------|----------|-------------|
| **Default (RLM)** | Large corpora, exploratory analysis | Context loaded into REPL `context` variable; LLM navigates it programmatically |
| **`--cache`** | Repeated questions on same docs, study sessions, batch Q&A | Full context injected into system prompt and cached at the provider |

Use `--cache` when you plan to ask multiple questions about the same set of documents. Use default RLM when the context is too large for a single system prompt or you need programmatic navigation.

### Cost comparison

| Query | Cost |
|-------|------|
| First query (cache miss) | Full input token cost (context + prompt) |
| Subsequent queries (cache hit) | **50-90% cheaper** -- only cache-read tokens are billed |

The exact savings depend on your provider. Google and Anthropic both offer significant discounts on cached input tokens.

### Batch usage

Process a list of questions against cached context:

```bash
rlmx batch questions.txt --context ./docs/
rlmx batch questions.txt --context ./docs/ --output json
```

Each question in the file is run sequentially, reusing the cached context. The first question pays full cost; subsequent questions benefit from the cache.

### Cache warmup and estimation

Warm the cache and estimate costs before running queries:

```bash
rlmx cache --context ./docs/ --estimate
```

This loads your context, calculates token counts, and shows estimated costs for cached vs uncached queries without making any LLM calls.

### YAML configuration

Enable cache in your `rlmx.yaml`:

```yaml
cache:
  enabled: true              # or use --cache flag per-invocation
  retention: long            # short|long -- maps to provider cache retention
  ttl: 3600                  # seconds -- provider-specific TTL
  expire-time: ""            # ISO 8601 -- for Google explicit caching
  session-prefix: "myproject" # prepended to content hash for sessionId
```

For detailed provider-specific TTL behavior (Google, Anthropic, Bedrock, OpenAI), see [docs/TTL_CONTROL.md](docs/TTL_CONTROL.md).

## Gemini 3 Native (v0.4)

rlmx v0.4 integrates 14 Gemini 3 native features, making it the cheapest and most capable context agent available. All features are opt-in, additive, and silently ignored on non-Google providers.

### Quick Start

```yaml
# rlmx.yaml
model:
  provider: google
  model: gemini-3.1-flash-lite-preview

gemini:
  thinking-level: medium      # Control thinking depth
  google-search: true          # Web search in REPL
  url-context: true            # Fetch URLs in REPL
  code-execution: true         # Server-side Python
  media-resolution:
    images: high               # ~1120 tokens/image
    pdfs: medium               # ~560 tokens/page
    video: low                 # ~70 tokens/frame
```

```bash
rlmx "Research latest AI developments" --context ./notes/ --tools standard --thinking high
```

### Features

| Feature | Config | CLI Flag | Description |
|---------|--------|----------|-------------|
| Thinking levels | `gemini.thinking-level` | `--thinking` | minimal/low/medium/high — controls reasoning depth |
| Thought signatures | automatic | — | Multi-turn quality via pi/ai signature circulation |
| Structured output | `output.schema` | — | JSON Schema enforcement via API (not text parsing) |
| Google Search | `gemini.google-search` | — | `web_search()` battery in REPL |
| URL Context | `gemini.url-context` | — | `fetch_url()` battery in REPL |
| Code Execution | `gemini.code-execution` | — | Server-side Python alongside local REPL |
| Image Generation | `gemini.image-gen` | — | `generate_image()` via Nano Banana |
| Media Resolution | `gemini.media-resolution` | — | Per-type token cost control |
| Batch API | — | `--batch-api` | 50% cost reduction for bulk operations |
| Context Caching | `cache.enabled` | `--cache` | 90% discount on cached tokens |
| Computer Use | `gemini.computer-use` | — | Planned for v0.5 |
| Maps Grounding | `gemini.maps-grounding` | — | Planned for v0.5 |
| File Search | `gemini.file-search` | — | Planned for v0.5 |
| Function + Tools | automatic | — | Custom functions + built-in tools in one API call |

### Cost Comparison

| Mode | Cost (per 1M tokens) | Savings |
|------|---------------------|---------|
| Base (flash-lite) | $0.075 input / $0.30 output | — |
| + Context caching | ~$0.0075 input (cached) | 90% on input |
| + Batch API | ~$0.0375 input / $0.15 output | 50% on all |
| Cache + Batch | ~$0.00375 input (cached+batch) | 95% on cached input |

**100 queries over 500K context: < $2.00** with cache + batch stacking.

### Provider Compatibility

| Feature | Google | Anthropic | OpenAI | Others |
|---------|--------|-----------|--------|--------|
| Thinking levels | native | ignored | ignored | ignored |
| Thought signatures | native | ignored | ignored | ignored |
| Structured output | API-enforced | FINAL() fallback | FINAL() fallback | FINAL() fallback |
| Web search/URL | native | error msg | error msg | error msg |
| Code execution | native | local only | local only | local only |
| Media resolution | native | ignored | ignored | ignored |
| Batch API | native | standard batch | standard batch | standard batch |
| Context caching | native | native | native | provider-dependent |

### Gemini Batteries (REPL Functions)

Available with `--tools standard` or `--tools full` when provider is Google:

```python
# In REPL code:
result = web_search("latest nodejs version")
print(result)

page = fetch_url("https://example.com/docs")
print(page[:500])

img_path = generate_image("architecture diagram of microservices")
print(img_path)
```

Non-Google providers get clear error messages: `"web_search() requires provider: google"`.

### Examples

See `examples/` for complete configs:
- `gemini-research/` — Web search + URL context research agent
- `gemini-multimodal/` — Media resolution + image analysis
- `gemini-cheap-batch/` — Maximum cost stacking example

## Config Files

Drop `.md` files in your working directory to customize behavior. Run `rlmx init` to scaffold defaults with inline comments.

| File | Purpose |
|------|---------|
| `SYSTEM.md` | System prompt sent to the LLM. Default: exact RLM paper prompt. |
| `CONTEXT.md` | Context loading documentation (informational). |
| `TOOLS.md` | Custom Python functions injected into the REPL namespace. |
| `CRITERIA.md` | Output format criteria appended to the system prompt. |
| `MODEL.md` | LLM provider and model selection. |

### TOOLS.md Format

Define custom REPL tools as `## heading` + `python` code block:

```markdown
## search_docs
` ``python
def search_docs(keyword):
    """Search context for files matching keyword."""
    matches = [item for item in context if keyword.lower() in item['content'].lower()]
    return [m['path'] for m in matches]
` ``

## summarize_chunk
` ``python
def summarize_chunk(text, max_words=100):
    """Summarize a chunk of text."""
    return llm_query(f"Summarize in {max_words} words:\n{text}")
` ``
```

### MODEL.md Format

```markdown
provider: google
model: gemini-3.1-flash-lite-preview
sub-call-model: gemini-3.1-flash-lite-preview
```

Supports any provider available in [pi/ai](https://github.com/nickarora/pi-ai): `anthropic`, `openai`, `google`, etc.

## CLI Reference

```
rlmx "query" [options]                Run an RLM query
rlmx init [--dir <path>]             Scaffold config files
rlmx batch <file> [options]           Run batch queries from a file
rlmx cache [options]                  Cache management (warmup, estimate)

Options:
  --context <path>        Path to context (directory or file)
  --cache                 Enable CAG mode (cache context in system prompt)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Directory for init command (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version

Gemini options:
  --thinking <level>      Thinking level: minimal, low, medium, high
  --batch-api             Use Gemini Batch API for 50% cost reduction

Cache options:
  --estimate              Estimate cache costs without making LLM calls
  --session-prefix <str>  Override session prefix for cache key
```

## Output Modes

### Text (default)

Prints the final answer to stdout.

### JSON

```bash
rlmx "query" --output json
```

Returns:

```json
{
  "answer": "The answer to your query...",
  "references": ["docs/start/create-project.md", "docs/concept/inter-process-communication.md"],
  "usage": { "inputTokens": 12500, "outputTokens": 3200, "llmCalls": 5 },
  "iterations": 3,
  "model": "google/gemini-3.1-flash-lite-preview"
}
```

### Stream

```bash
rlmx "query" --output stream
```

Emits JSONL events per iteration, then a final event.

## Context Loading

| Input | Behavior |
|-------|----------|
| `--context dir/` | Recursively reads `*.md` files as `list[{path, content}]` |
| `--context file.md` | Reads as single string |
| `--context file.json` | Parses JSON as dict or list |
| stdin pipe | Reads as single string |

## Environment Variables

rlmx uses pi/ai for LLM calls. Set the appropriate API key for your provider:

- `GEMINI_API_KEY` — for Google Gemini models (default provider)
- `ANTHROPIC_API_KEY` — for Anthropic models
- `OPENAI_API_KEY` — for OpenAI models

## Programmatic API

```typescript
import { rlmLoop, loadConfig, loadContext } from "rlmx";

const config = await loadConfig("./");
const context = await loadContext("./docs/");

const result = await rlmLoop("How does IPC work?", context, config, {
  maxIterations: 10,
  timeout: 60000,
  verbose: false,
  output: "json",
});

console.log(result.answer);
console.log(result.references);
```

## Requirements

- Node.js >= 18
- Python 3.10+ (for the REPL subprocess)
- An LLM API key (Anthropic, OpenAI, Google, etc.)

## License

MIT
