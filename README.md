# pi-rlm

A [pi](https://github.com/badlogic/pi-mono) extension that implements **Recursive Language Models (RLMs)** — an inference strategy where LLMs recursively call themselves to process unbounded context lengths without context rot.

Based on the paper ["Recursive Language Models" (Zhang, Kraska, Khattab, 2025)](https://arxiv.org/abs/2512.24601v1) and the [DSPy RLM module](https://dspy.ai/api/modules/RLM/).

## What is an RLM?

Traditional LLM calls degrade as context grows ("context rot"). RLMs solve this by:

1. **Storing context as a variable** in a Python REPL environment
2. **Only showing metadata** (type, length, preview) to the root LLM
3. **Letting the LLM explore programmatically** — peek, grep, chunk, filter
4. **Enabling recursive sub-LLM calls** via `llm_query()` for semantic analysis
5. **Iterating** until the LLM calls `SUBMIT(answer)`

This means a small model using RLM can outperform a larger model on long-context tasks, at lower cost.

## Installation

**Option A: Use as a pi package (recommended)**
```bash
# From your project directory, add to .pi/settings.json:
{ "extensions": ["/path/to/pi-rlm/src/index.ts"] }
```

**Option B: Copy into project extensions**
```bash
cd your-project
mkdir -p .pi/extensions/rlm
cp /path/to/pi-rlm/src/*.ts .pi/extensions/rlm/
```

**Option C: Load directly with `-e` flag (for testing)**
```bash
pi -e /path/to/pi-rlm/src/index.ts
```

> ⚠️ Don't combine `-e` with auto-discovered `.pi/extensions/rlm/` — the tool name will conflict.

### Autoload during extension development

pi auto-discovers extensions from:

- `.pi/extensions/*.ts`
- `.pi/extensions/*/index.ts`
- `~/.pi/agent/extensions/...` (global)

This repo now includes a local autoload shim at:

- `.pi/extensions/rlm/index.ts` → re-exports `src/index.ts`

So when you run pi in this folder, it can pick up the extension automatically. While iterating, use `/reload` in pi after edits.

See also:
- pi docs: `docs/extensions.md` (autoload + `/reload` behavior)
- local notes: `docs/autoload-dev.md`

## Requirements

- **Python 3** — for the isolated REPL environment (not a hardened security sandbox)
- **pi** coding agent

## Quick Start

```bash
# Quickstart demo (~30 seconds, creates a tiny test file)
./examples/quickstart.sh
```

## Examples

Run any example to see the RLM iterating in your terminal:

```bash
./examples/run.sh              # List available examples
./examples/run.sh sales        # Analyze 2000-row sales CSV
./examples/run.sh logs         # Investigate 5000-line server log
./examples/run.sh puzzle       # Decode a ROT13+Base64 cipher
./examples/run.sh configs      # Diff two large JSON configs
./examples/run.sh all          # Run all examples
```

Each example is designed so that **only code execution can produce the correct answer** — an LLM reasoning alone would fail.

## Usage

The extension registers an `rlm` tool that the LLM can call:

```
Use the rlm tool to analyze this large log file and find all error patterns.
Context: file:/var/log/app.log
```

### Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The question/task about the context |
| `context` | string | required | Raw text or `file:/path` to read from disk |
| `max_iterations` | number | 15 | Maximum REPL interaction loops |
| `max_llm_calls` | number | 50 | Maximum sub-LLM calls budget (shared across recursive calls) |
| `max_depth` | number | 1 | Maximum recursion depth for `rlm_query` |

### How it works inside

```
User: "Find the magic number in this 1M-line file"
  │
  ├─ Iteration 1: print(len(context))  →  "5,432,100 chars"
  ├─ Iteration 2: print(context[:2000]) →  "blah random text..."
  ├─ Iteration 3: import re; matches = re.findall(r'magic number is (\d+)', context)
  │                print(matches)       →  "['1298418']"
  ├─ Iteration 4: SUBMIT("1298418")
  │
  └─ Result: "1298418"
```

## Architecture

```
┌─────────────────────────────────────┐
│  pi (root LLM)                      │
│  - Sees query + context metadata    │
│  - Writes Python code               │
│  - Decides exploration strategy     │
├─────────────────────────────────────┤
│  RLM Engine                         │
│  - Manages iteration loop           │
│  - Spawns Python REPL processes     │
│  - Runs HTTP server for llm_query   │
├─────────────────────────────────────┤
│  Python REPL (isolated session)     │
│  - context variable loaded          │
│  - llm_query() → HTTP → sub-LLM    │
│  - SUBMIT() → signal completion     │
└─────────────────────────────────────┘
```

## RLM-First Design Spec

For the repo-scale recursive design (wiki generation, deep review, persistent recursion trees), see:

- `docs/rlm-first-spec-v1.md`
- `docs/phase-1-implementation-plan.md`
- `docs/phase-2-implementation-plan.md`
- `docs/phase-3-implementation-plan.md`
- `docs/schemas/rlm-node.schema.json`
- `docs/schemas/rlm-result.schema.json`
- `docs/schemas/rlm-run.schema.json`

## Extension Docs

- `docs/tools.md` — all tool parameters/outputs
- `docs/cookbook.md` — practical runbooks
- `docs/ci-integration.md` — SARIF + codequality usage in CI
- `docs/prompt-playbook.md` — objective prompt templates
- `docs/autoload-dev.md` — local extension dev/autoload loop

## Repo-Scale RLM Workflow (Phase 3)

The extension now includes repo-level recursive tools:

- `repo_rlm_start`
- `repo_rlm_step`
- `repo_rlm_run`
- `repo_rlm_synthesize`
- `repo_rlm_status`
- `repo_rlm_export`

A typical flow inside pi:

1. Start a run
```text
Use repo_rlm_start with objective "full review of this repository" and mode "review".
```

2. Execute recursion
```text
Use repo_rlm_run for that run_id with max_nodes 500.
```

3. Generate deterministic synthesis artifacts
```text
Use repo_rlm_synthesize for that run_id with target "review".
```

4. Optionally generate semantic synthesis artifacts
```text
Use repo_rlm_synthesize for that run_id with target "review" and semantic true.
# optional: semantic_model "anthropic/claude-sonnet-4-5"
```

5. Export summary/topology
```text
Use repo_rlm_export for that run_id in markdown and json formats.
```

## License

MIT
