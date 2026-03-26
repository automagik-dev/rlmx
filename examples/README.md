# rlmx Examples

Example `rlmx.yaml` configurations for different use cases.

## Tauri Docs

Research agent for Tauri v2 documentation. Loads `.md` and `.mdx` files, uses `standard` tools with custom API reference search.

```bash
cd my-tauri-project
cp ../examples/tauri-docs/rlmx.yaml .
rlmx "How does IPC work in Tauri v2?" --context ./docs/
```

## Codebase Q&A

Code analysis agent that traces execution flows across a project. Loads `.ts`, `.js`, `.py`, and `.json` files. Uses `full` tools with import tracing and definition search.

```bash
cd my-project
cp ../examples/codebase-qa/rlmx.yaml .
rlmx "How does authentication work?" --context ./src/
```

## Paper Review

Academic peer reviewer that systematically evaluates research papers. Uses `core` tools (paper-faithful) with custom claim extraction and methodology analysis.

```bash
cp examples/paper-review/rlmx.yaml .
rlmx "Review this paper" --context paper.md
```

## Customizing

Copy any example and edit:

- **model** — change provider/model for different LLMs
- **system** — customize the agent's persona and instructions
- **tools** — add Python functions the LLM can call in the REPL
- **criteria** — control the output format
- **context** — set file extensions and exclude patterns
- **budget** — set cost/token/depth limits
- **tools-level** — `core` (6 functions), `standard` (+batteries), `full` (+package detection)
