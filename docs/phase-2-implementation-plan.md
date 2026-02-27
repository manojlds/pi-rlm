# Phase 2 Implementation Plan (RLM-First)

Status: **Partially Completed**  
Updated on: 2026-02-27

This phase wires the recursive engine on top of Phase 1 lifecycle scaffolding.

---

## Completion Snapshot

- ✅ P2-01 Recursive scheduler core
- ✅ P2-02 Leaf/split policy engine
- ✅ P2-03 Child node generation
- ✅ P2-04 Leaf worker adapter (heuristic)
- ✅ P2-05 Minimal parent aggregation
- ✅ P2-06 Status enhancements
- ⏳ P2-07 Tests (pending)

---

## P2-01: Recursive Scheduler Core

**Status:** ✅ Done

Implemented in `src/repo-rlm.ts`:
- bounded scheduler execution via `executeStep()` and `runUntil()`
- queue selection for `bfs` and `dfs` modes
- node lifecycle transitions and queue events

Tool surface added:
- `repo_rlm_step`
- `repo_rlm_run`

---

## P2-02: Leaf/Split Policy Engine

**Status:** ✅ Done

Decision logic includes explicit reasons:
- `deadline_exceeded`
- `max_depth_reached`
- `llm_budget_exhausted`
- `token_budget_exhausted`
- `scope_too_large`
- `scope_small_enough`

Decision reason is stored on node updates (`decision_reason`).

---

## P2-03: Child Node Generation

**Status:** ✅ Done

Current decomposition strategy:
- split to directory children when subdirectories exist
- fallback to chunked `file_group` children (size=8)
- child nodes include parent linkage, depth increment, scope refs, and distributed budgets

---

## P2-04: Worker Execution Adapter

**Status:** ✅ Done (heuristic adapter)

Leaf execution currently uses bounded heuristic analysis:
- scope metrics and extension distribution
- review-mode pattern findings (with evidence pointers)
- wiki-mode node markdown artifact emission

Results persist to `results.jsonl` as `RepoRLMResult`.

---

## P2-05: Parent Aggregation (Minimal)

**Status:** ✅ Done

Implemented behavior:
- split parent remains `running` until all children terminal
- parent aggregation emits result summary referencing child node outputs
- parent result uses `partial` status when child failures exist
- parent node transitions to `completed` or `failed`

---

## P2-06: Status/UI Enhancements

**Status:** ✅ Done

`repo_rlm_status` now includes:
- depth histogram
- active branch preview
- bounded textual summary for quick operator visibility

`repo_rlm_export` includes these derived fields in json/markdown outputs.

---

## P2-07: Tests

**Status:** ⏳ Pending

Planned tests:
- split/leaf boundary policy tests
- scheduler progression tests
- resume consistency tests
- parent aggregation partial-failure tests

---

## Remaining Work Before Phase 3

1. Add deterministic fixture tests for scheduler/policy/aggregation.
2. Replace heuristic leaf adapter with objective-driven worker calls where needed.
3. Add optional lightweight progress streaming updates from tool execution.

---

## Out of Scope for Phase 2

- full wiki synthesis docs
- full multi-domain review ranking/dedup
- SARIF/code-quality exporters

These move to Phase 3.
