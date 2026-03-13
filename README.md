# pi-rlm

Recursive Language Model (RLM) extension for [Pi coding agent](https://github.com/badlogic/pi-mono).

This extension adds an `rlm` tool that performs depth-limited recursive decomposition:

1. planner node decides `solve` vs `decompose`
2. child nodes recurse on subtasks
3. synthesizer node merges child outputs

It includes guardrails for depth, node budget, branching, and cycle detection.

## Install

```bash
pi install /path/to/pi-rlm
```

Or as a package:

```bash
pi install npm:pi-rlm
```

## CLI Wrapper

This package also ships a lightweight CLI wrapper:

```bash
pi-rlm --task "Analyze architecture of this repo" --mode auto --tools-profile read-only
```

Or with a positional task:

```bash
pi-rlm "Find top reliability risks in this codebase" --backend sdk --max-depth 3
```

JSON output:

```bash
pi-rlm "Summarize repo" --mode solve --json
```

Live tree visualization (TTY):

```bash
pi-rlm "Analyze architecture of this repo" --tools-profile read-only --live
```

Notes:
- The wrapper runs a **single synchronous** `op=start` operation.
- It shells out to the installed `pi` CLI and loads this extension automatically.
- `--live` renders a real-time tree by reading `events.jsonl` while the run executes.
- CLI source is authored in TypeScript (`src/cli.ts`) and built with `npm run build:cli` (Node + `tsc`, no Bun runtime required).

## Tool API

The extension registers one tool: `rlm`.

### `op=start` (default)

```ts
rlm({
  task: "Implement auth refactor and validate tests",
  backend: "sdk",         // sdk | cli | tmux
  mode: "auto",           // auto | solve | decompose
  maxDepth: 2,
  maxNodes: 24,
  maxBranching: 3,
  concurrency: 2,
  toolsProfile: "coding", // coding | read-only
  timeoutMs: 180000,
  async: false
})
```

### `op=status`

```ts
rlm({ op: "status", id: "a1b2c3d4" })
```

If `id` is omitted, returns recent runs.

### `op=wait`

```ts
rlm({ op: "wait", id: "a1b2c3d4", waitTimeoutMs: 120000 })
```

### `op=cancel`

```ts
rlm({ op: "cancel", id: "a1b2c3d4" })
```

## Backend Behavior

### `backend: "sdk"` (default)

- Runs subcalls in-process via Pi SDK sessions
- No fresh `pi` CLI process per subcall
- Best default for low overhead and deterministic orchestration

### `backend: "cli"`

- Runs each subcall as a fresh `pi -p` subprocess
- Good isolation, easier debugging in logs
- Slightly higher process overhead

### `backend: "tmux"`

- Runs each subcall inside a detached tmux session
- Uses fresh `pi` process per subcall
- Useful when you specifically want tmux-level observability/control

## Artifacts

Each run writes artifacts to:

```text
/tmp/pi-rlm-runs/<runId>/
  events.jsonl
  tree.json
  output.md
```

## Guardrails

- `maxDepth`: recursion depth cap
- `maxNodes`: total node budget
- `maxBranching`: child count cap per decomposition
- cycle detection by normalized task lineage
- cancellable runs (`op=cancel`)

## Development

```bash
npm install
npm run typecheck
```
