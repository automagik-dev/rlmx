# rlmx

RLM algorithm CLI for coding agents — prompt externalization, Python REPL with symbolic recursion, code-driven navigation.

Based on the [RLM paper](https://arxiv.org/abs/2501.12599) (REPL-based LLM Method). Uses [pi/ai](https://github.com/nickarora/pi-ai) as the multi-provider LLM client.

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
