# RLM-First Spec v1 (pi-rlm)

Status: Draft v1  
Owner: pi-rlm  
Date: 2026-02-27

---

## 1) Intent

This project is **RLM-first**.

The primary runtime primitive is recursive reasoning over bounded context nodes:

`RLM.solve(node, objective) -> node_result`

All major features (repo wiki, deep review, architecture analysis) must be implemented as wrappers around this primitive.

---

## 2) Definitions

- **Node**: A bounded context unit (repo, directory, module, file group, file slice).
- **Objective**: The task requested for that node (e.g., summarize module, security review).
- **Leaf**: A node solved directly without further decomposition.
- **Split**: A node decomposed into child nodes and solved recursively.
- **Run**: One end-to-end recursive execution with persistent state.
- **Evidence**: File/line-backed support for claims.

---

## 3) Hard Requirements

1. RLM recursion must be explicit in code and persisted artifacts.
2. Every non-trivial run produces a recursion tree.
3. Every finding/claim in final outputs includes evidence pointers.
4. Work must be resumable after interruption.
5. Wiki/review modes are orchestration presets over the same recursive core.

---

## 4) Core Recursive Contract

### 4.1 Function

`RLM.solve(node, objective, budget, constraints) -> node_result`

### 4.2 Solve Loop (per node)

1. **Probe** node metadata + small targeted reads.
2. **Decide** `leaf` or `split`.
3. If `leaf`: perform bounded analysis and emit result.
4. If `split`: create children, recurse, aggregate.
5. Emit node result with status/evidence/metrics.

### 4.3 Stop Conditions (Leaf Decision)

A node MUST become leaf when any is true:
- estimated complexity <= leaf threshold
- max depth reached
- remaining budget below split reserve
- split confidence < minimum threshold

A node MAY become leaf early when confidence is high and evidence coverage is sufficient.

---

## 5) Data Model

Schemas live in:
- `docs/schemas/rlm-node.schema.json`
- `docs/schemas/rlm-result.schema.json`
- `docs/schemas/rlm-run.schema.json`

### 5.1 Node

Key fields:
- identity: `run_id`, `node_id`, `parent_id`, `depth`
- scope: `scope_type`, `scope_ref`
- objective: `objective`, `domain`
- control: `decision`, `status`, `budgets`
- topology: `child_ids`
- quality: `confidence`, `evidence`
- diagnostics: `errors`, `metrics`

### 5.2 Node Result

Key fields:
- `summary`
- `findings[]` (for review-like objectives)
- `artifacts[]` (for wiki/docs outputs)
- `evidence[]`
- `aggregation_notes`

### 5.3 Run

Key fields:
- run metadata (`run_id`, timestamps, objective, config)
- root node id
- progress counters
- checkpoints
- final outputs index

---

## 6) Runtime APIs (Tool Surface)

Planned top-level tools:

1. `repo_rlm_start`
   - starts run
   - creates root node
2. `repo_rlm_status`
   - returns counters + active nodes + depth stats
3. `repo_rlm_resume`
   - resumes unfinished run
4. `repo_rlm_cancel`
   - marks active nodes cancelled
5. `repo_rlm_export`
   - emits final wiki/review bundles

Planned presets:
- `repo_rlm_wiki`
- `repo_rlm_review`

These are convenience wrappers over `repo_rlm_start` with predefined objectives/config.

---

## 7) Persistence Layout

Per run:

`.pi/rlm/runs/<run-id>/`

- `run.json` — run metadata/checkpoint pointer
- `nodes.jsonl` — append-only node state transitions
- `results.jsonl` — append-only node results
- `queue.jsonl` — scheduler events
- `artifacts/` — generated markdown/json outputs
- `logs/` — diagnostics

### 7.1 Event-Sourced State

Runtime state is reconstructed from append-only logs (`nodes.jsonl`, `results.jsonl`, `queue.jsonl`) to support resume/debug.

---

## 8) Scheduling

- BFS by default for broad coverage.
- Optional DFS for deep hotspot analysis.
- Batched recursion allowed with per-batch concurrency caps.
- Shared budget accounting across all descendants.

Budget dimensions:
- token budget
- LLM call budget
- recursion depth
- wall-clock timeout

---

## 9) Aggregation Rules

Parent aggregation must:
1. merge child outputs deterministically
2. deduplicate semantically equivalent findings
3. preserve evidence lineage (`node_id` + file/line pointers)
4. compute confidence rollup

No parent-level claim without either:
- direct parent evidence, or
- child evidence references

---

## 10) First-Class Workflows

## 10.1 Repo Wiki

Objective family:
- architecture map
- module summaries
- dependency surfaces
- invariants and operational risks

Output target:
- `artifacts/wiki/index.md`
- `artifacts/wiki/modules/*.md`

## 10.2 Deep Repo Review

Objective family:
- security
- correctness/quality
- performance
- maintainability/docs

Output target:
- `artifacts/review/report.md`
- `artifacts/review/findings.json`

---

## 11) Evidence Contract

Minimum evidence pointer shape:
- `path`
- `line_start`
- `line_end`
- optional `snippet_hash`
- optional `quote`

Severity-bearing findings without evidence are invalid.

---

## 12) UI/Telemetry (pi TUI)

Expose in status/widget:
- run id
- solved/total nodes
- active node count
- max depth reached
- budgets consumed
- top errors

Expanded view should show latest branch of recursion tree and current node objective.

---

## 13) Failure Handling

- Node failure does not fail run by default.
- Retry policy per node with capped attempts.
- Failed nodes marked terminal with error cause.
- Parent may continue with partial child coverage and lower confidence.

Run is failed only when root cannot produce minimal valid result.

---

## 14) Testing Strategy

### 14.1 Unit
- split vs leaf decision logic
- budget accounting
- aggregation and dedup
- schema validation

### 14.2 Integration
- recursive run over synthetic repo
- interruption + resume consistency
- evidence presence in all findings

### 14.3 Golden
- deterministic wiki/review output for fixed fixtures

---

## 15) Implementation Phases

### Phase 1 (Core)
- node/run schemas
- event-sourced persistence
- recursive scheduler + leaf/split policy
- basic status API

### Phase 2 (Wiki)
- wiki objective handlers
- markdown artifact emitter

### Phase 3 (Review)
- domain objective handlers
- findings merge/rank/export

### Phase 4 (UX + Hardening)
- richer TUI
- resume/cancel/export polish
- full test matrix

---

## 16) Non-Goals (v1)

- perfect global call graph reconstruction
- language-server parity for every language
- autonomous code modification/execution loops

v1 prioritizes robust recursive analysis with evidence-backed outputs.
