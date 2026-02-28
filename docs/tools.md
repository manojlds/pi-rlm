# Tool Reference

This extension exposes two groups of tools:

1. `rlm` for long-context, REPL-driven analysis
2. `repo_rlm_*` for repo-scale recursive runs and synthesis

---

## `rlm`

Use for large raw context (text/blob/file) where direct prompting degrades.

### Parameters

- `query` (string, required): task/question
- `context` (string, required): raw text or `file:/abs/path`
- `max_iterations` (number, optional, default `15`)
- `max_llm_calls` (number, optional, default `50`)
- `max_depth` (number, optional, default `1`)

### Behavior

- launches isolated Python REPL
- exposes `llm_query()` / `rlm_query()` helpers
- iterative code execution until `FINAL(...)`/`SUBMIT(...)`

---

## `repo_rlm_start`

Start a persistent recursive repo run.

### Parameters

- `objective` (string, required)
- `mode` (`generic | wiki | review`, default `generic`)
- `max_depth` (default `4`)
- `max_llm_calls` (default `300`)
- `max_tokens` (default `500000`)
- `max_wall_clock_ms` (default `1800000`)
- `scheduler` (`bfs | dfs | hybrid`, default `bfs`)
- `exclude_paths` (string[], optional): extra path prefixes/globs to exclude

Default excluded segments always include: `.git`, `node_modules`, `.pi`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache`.

### Returns

- `run_id`, `root_node_id`, run metadata
- persisted under `.pi/rlm/runs/<run-id>/`

---

## `repo_rlm_step`

Run bounded scheduler steps.

- `run_id` (required)
- `max_nodes` (optional, default `1`)

Good for interactive debugging of recursion behavior.

---

## `repo_rlm_run`

Run scheduler until completion or budget limit.

- `run_id` (required)
- `max_nodes` (optional, default `200`)

Use this for normal execution.

---

## `repo_rlm_synthesize`

Build higher-level artifacts from node outputs.

### Parameters

- `run_id` (required)
- `target` (`auto | wiki | review | all`, default `auto`)
- `semantic` (boolean, optional, default `false`)
- `semantic_model` (string, optional)

### Deterministic outputs

- Wiki:
  - `artifacts/wiki/index.md`
  - `artifacts/wiki/Home.md`
  - `artifacts/wiki/Architecture.md`
  - `artifacts/wiki/module-index.md`
  - `artifacts/wiki/CLI-and-Workflows.md`
  - `artifacts/wiki/Setup-and-Dev.md`
  - `artifacts/wiki/Testing.md`
  - `artifacts/wiki/Contributing.md`
  - `artifacts/wiki/architecture-summary.md`
- Review:
  - `artifacts/review/findings-ranked.json`
  - `artifacts/review/findings-clusters.json`
  - `artifacts/review/summary.json`
  - `artifacts/review/report.md`
  - `artifacts/review/codequality.json`
  - `artifacts/review/sarif.json`

### Optional semantic outputs (`semantic: true`)

- `artifacts/review/report.semantic.md`
- `artifacts/wiki/architecture.semantic.md`

---

## `repo_rlm_status`

Inspect progress/topology.

- `run_id` (required)

Includes node counts, depth histogram, queue activity, active branch preview.

---

## `repo_rlm_cancel`

Cancel run execution.

- `run_id` (required)

---

## `repo_rlm_resume`

Resume cancelled/paused/failed run.

- `run_id` (required)

---

## `repo_rlm_export`

Export run summary/topology.

- `run_id` (required)
- `format` (`markdown | json`, default `markdown`)

Creates export file paths under run artifacts.
