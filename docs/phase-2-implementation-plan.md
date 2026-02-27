# Phase 2 Implementation Plan (RLM-First)

Status: Ready for execution

This phase wires the actual recursive engine on top of Phase 1 lifecycle scaffolding.

---

## P2-01: Recursive Scheduler Core

**Goal**
Implement node execution loop with explicit `leaf|split` decisions.

**Deliverables**
- scheduler loop (`bfs` default; `dfs` optional)
- node state transitions in `nodes.jsonl`
- queue events for enqueue/dequeue/start/finish

**Acceptance Criteria**
- root node moves from `queued -> running -> completed|failed`
- split nodes create child nodes and enqueue them
- run remains consistent after process restart/resume

---

## P2-02: Leaf/Split Policy Engine

**Goal**
Formalize deterministic split heuristics.

**Inputs**
- depth
- scope size (file count, bytes, line counts)
- remaining budget
- objective mode

**Acceptance Criteria**
- policy returns explicit reason code for each decision
- max depth and budget constraints enforced
- policy decision logged in node metadata

---

## P2-03: Child Node Generation

**Goal**
Create consistent decomposition by scope type.

**Strategy (v1)**
- `repo -> dir/module groups`
- `dir/module -> file_group`
- optional `file_group -> file_slice`

**Acceptance Criteria**
- child nodes are non-overlapping or explicitly marked overlapping
- each child has `parent_id`, incremented `depth`, scoped `scope_ref`
- parent stores `child_ids`

---

## P2-04: Worker Execution Adapter

**Goal**
Connect scheduler to the existing RLM worker execution path.

**Deliverables**
- bounded execution for leaf nodes
- node-level result persistence to `results.jsonl`

**Acceptance Criteria**
- each completed leaf has a persisted `RepoRLMResult`
- failed leaf captures structured error object
- budget accounting updates after each worker run

---

## P2-05: Parent Aggregation (Minimal)

**Goal**
Aggregate child summaries upward to produce parent summaries.

**Acceptance Criteria**
- parent completion waits for all children terminal states
- parent summary references child node ids
- parent status becomes `partial` when child failures exist

---

## P2-06: Status/UI Enhancements

**Goal**
Make recursion visible during runs.

**Deliverables**
- `repo_rlm_status` adds depth histogram + active branch preview
- optional lightweight progress updates from tool execution

**Acceptance Criteria**
- operator can see recursion growth and active work at a glance
- status output remains bounded and readable

---

## P2-07: Tests

**Goal**
Establish confidence in recursive behavior.

**Required tests**
- split/leaf policy boundaries
- scheduler progression
- resume from interrupted run
- parent aggregation under partial failures

**Acceptance Criteria**
- deterministic fixture-based tests for recursion tree shape
- no data loss across restart/resume

---

## Out of Scope for Phase 2

- full wiki synthesis docs
- full multi-domain review ranking/dedup
- SARIF/code-quality exporters

These move to Phase 3.
