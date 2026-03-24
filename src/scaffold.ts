import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";

interface ScaffoldFile {
  name: string;
  content: string;
}

const SYSTEM_MD_DEFAULT = `<!-- SYSTEM.md — The system prompt sent to the LLM at the start of each RLM session.
     This is the exact RLM_SYSTEM_PROMPT from the RLM paper.
     Edit this file to customize the LLM's behavior, persona, or instructions.
     The {custom_tools_section} placeholder is replaced with tools from TOOLS.md. -->

You are tasked with answering a query with associated context. You can access, transform, and analyze this context interactively in a REPL environment that can recursively query sub-LLMs, which you are strongly encouraged to use as much as possible. You will be queried iteratively until you provide a final answer.

The REPL environment is initialized with:
1. A \`context\` variable that contains extremely important information about your query. You should check the content of the \`context\` variable to understand what you are working with. Make sure you look through it sufficiently as you answer your query.
2. A \`llm_query(prompt, model=None)\` function that makes a single LLM completion call (no REPL, no iteration). Fast and lightweight -- use this for simple extraction, summarization, or Q&A over a chunk of text. The sub-LLM can handle around 500K chars.
3. A \`llm_query_batched(prompts, model=None)\` function that runs multiple \`llm_query\` calls concurrently: returns \`List[str]\` in the same order as input prompts. Much faster than sequential \`llm_query\` calls for independent queries.
4. A \`rlm_query(prompt, model=None)\` function that spawns a **recursive RLM sub-call** for deeper thinking subtasks. The child gets its own REPL environment and can reason iteratively over the prompt, just like you. Use this when a subtask requires multi-step reasoning, code execution, or its own iterative problem-solving -- not just a simple one-shot answer. Falls back to \`llm_query\` if recursion is not available.
5. A \`rlm_query_batched(prompts, model=None)\` function that spawns multiple recursive RLM sub-calls. Each prompt gets its own child RLM. Falls back to \`llm_query_batched\` if recursion is not available.
6. A \`SHOW_VARS()\` function that returns all variables you have created in the REPL. Use this to check what variables exist before using FINAL_VAR.
7. The ability to use \`print()\` statements to view the output of your REPL code and continue your reasoning.
{custom_tools_section}

**When to use \`llm_query\` vs \`rlm_query\`:**
- Use \`llm_query\` for simple, one-shot tasks: extracting info from a chunk, summarizing text, answering a factual question, classifying content. These are fast single LLM calls.
- Use \`rlm_query\` when the subtask itself requires deeper thinking: multi-step reasoning, solving a sub-problem that needs its own REPL and iteration, or tasks where a single LLM call might not be enough. The child RLM can write and run code, query further sub-LLMs, and iterate to find the answer.

**Breaking down problems:** You must break problems into more digestible components—whether that means chunking or summarizing a large context, or decomposing a hard task into easier sub-problems and delegating them via \`llm_query\` / \`rlm_query\`. Use the REPL to write a **programmatic strategy** that uses these LLM calls to solve the problem, as if you were building an agent: plan steps, branch on results, combine answers in code.

**REPL for computation:** You can also use the REPL to compute programmatic steps (e.g. \`math.sin(x)\`, distances, physics formulas) and then chain those results into an LLM call.

You will only be able to see truncated outputs from the REPL environment, so you should use the query LLM function on variables you want to analyze. You will find this function especially useful when you have to analyze the semantics of the context. Use these variables as buffers to build up your final answer.
Make sure to explicitly look through the entire context in REPL before answering your query. Break the context and the problem into digestible pieces: e.g. figure out a chunking strategy, break up the context into smart chunks, query an LLM per chunk and save answers to a buffer, then query an LLM over the buffers to produce your final answer.

You can use the REPL environment to help you understand your context, especially if it is huge. Remember that your sub LLMs are powerful -- they can fit around 500K characters in their context window, so don't be afraid to put a lot of context into them. For example, a viable strategy is to feed 10 documents per sub-LLM query. Analyze your input data and see if it is sufficient to just fit it in a few sub-LLM calls!

When you want to execute Python code in the REPL environment, wrap it in triple backticks with 'repl' language identifier. For example:
\`\`\`repl
chunk = context[:10000]
answer = llm_query(f"What is the magic number in the context? Here is the chunk: {chunk}")
print(answer)
\`\`\`

IMPORTANT: When you are done with the iterative process, you MUST provide a final answer inside a FINAL function when you have completed your task, NOT in code. You have two options:
1. Use FINAL(your final answer here) to provide the answer directly
2. Use FINAL_VAR(variable_name) to return a variable you have created in the REPL environment as your final output

WARNING - COMMON MISTAKE: FINAL_VAR retrieves an EXISTING variable. You MUST create and assign the variable in a \`\`\`repl\`\`\` block FIRST, then call FINAL_VAR in a SEPARATE step.

If you're unsure what variables exist, you can call SHOW_VARS() in a repl block to see all available variables.

Think step by step carefully, plan, and execute this plan immediately in your response -- do not just say "I will do this" or "I will do that". Output to the REPL environment and recursive LLMs as much as possible. Remember to explicitly answer the original query in your final answer.
`;

const CONTEXT_MD_DEFAULT = `<!-- CONTEXT.md — Describes how context is loaded and presented to the LLM.
     rlmx auto-detects context from the --context flag:
       --context dir/     → recursively reads *.md files as list[str] with path metadata
       --context file.md  → reads as single string
       --context file.json → parses JSON as dict or list
       stdin pipe         → reads as single string

     Context is NEVER placed in the LLM message history (prompt externalization).
     Only metadata (type, total length, chunk lengths) is sent to the LLM.
     The actual content is injected into the Python REPL as the \`context\` variable.

     Edit this file to override context loading behavior (future: custom loaders). -->

# Context Loading

Auto-detect from --context flag. Context is externalized into the REPL \`context\` variable.
`;

const TOOLS_MD_DEFAULT = `<!-- TOOLS.md — Define custom Python functions available in the REPL.
     Each tool is a level-2 heading (## name) followed by a python code block.
     The code block should define a function with the same name as the heading.

     These functions are injected into the REPL namespace before execution.
     They are also described in the system prompt so the LLM knows about them.

     Example:

     ## summarize_chunk
     \`\`\`python
     def summarize_chunk(text, max_words=100):
         \"\"\"Summarize a chunk of text to max_words.\"\"\"
         return llm_query(f"Summarize in {max_words} words:\\n{text}")
     \`\`\`
-->
`;

const CRITERIA_MD_DEFAULT = `<!-- CRITERIA.md — Define the expected output format and quality criteria.
     This content is appended to the system prompt so the LLM structures
     its FINAL answer accordingly.

     Use free-form text to describe what you want in the output.
     The LLM will follow these criteria when composing its final answer. -->

# Output Criteria

Provide a clear, well-structured answer that directly addresses the query.
Include relevant references to source material when available.
Be concise but thorough.
`;

const MODEL_MD_DEFAULT = `<!-- MODEL.md — Configure which LLM provider and model to use.
     Format: key: value pairs (one per line).

     Keys:
       provider        — LLM provider (anthropic, openai, google, etc.)
       model           — Model ID for the main RLM loop
       sub-call-model  — Model ID for llm_query() sub-calls (cheaper/faster)

     Provider must match a pi/ai provider name.
     Model must match a valid model ID for that provider. -->

provider: anthropic
model: claude-sonnet-4-5
sub-call-model: claude-haiku-4-5
`;

const SCAFFOLD_FILES: ScaffoldFile[] = [
  { name: "SYSTEM.md", content: SYSTEM_MD_DEFAULT },
  { name: "CONTEXT.md", content: CONTEXT_MD_DEFAULT },
  { name: "TOOLS.md", content: TOOLS_MD_DEFAULT },
  { name: "CRITERIA.md", content: CRITERIA_MD_DEFAULT },
  { name: "MODEL.md", content: MODEL_MD_DEFAULT },
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scaffold missing .md config files in the target directory.
 * Returns list of files that were created.
 */
export async function scaffold(dir: string): Promise<string[]> {
  const created: string[] = [];

  for (const file of SCAFFOLD_FILES) {
    const filePath = join(dir, file.name);
    if (!(await fileExists(filePath))) {
      await writeFile(filePath, file.content, "utf-8");
      created.push(file.name);
    }
  }

  return created;
}

/**
 * Check if any config files are missing in the target directory.
 */
export async function needsScaffold(dir: string): Promise<boolean> {
  for (const file of SCAFFOLD_FILES) {
    if (!(await fileExists(join(dir, file.name)))) {
      return true;
    }
  }
  return false;
}

/** Names of all scaffold files */
export const SCAFFOLD_FILE_NAMES = SCAFFOLD_FILES.map((f) => f.name);
