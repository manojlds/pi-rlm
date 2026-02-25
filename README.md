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

```bash
# Clone into your project
cd your-project
git clone https://github.com/your-user/pi-rlm .pi/extensions/pi-rlm

# Or symlink for development
ln -s /path/to/pi-rlm .pi/extensions/pi-rlm
```

## Requirements

- **Python 3** — for the sandboxed REPL environment
- **pi** coding agent

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
| `max_llm_calls` | number | 30 | Maximum sub-LLM calls budget |

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
│  Python REPL (sandboxed)            │
│  - context variable loaded          │
│  - llm_query() → HTTP → sub-LLM    │
│  - SUBMIT() → signal completion     │
└─────────────────────────────────────┘
```

## License

MIT
