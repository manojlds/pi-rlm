# Phase 1 Implementation Plan (RLM-First)

Status: Ready for execution

This plan turns `docs/rlm-first-spec-v1.md` into concrete engineering tickets.

---

## P1-01: Run Store + Event Log Bootstrap

**Goal**
Create persistent run scaffolding under `.pi/rlm/runs/<run-id>/`.

**Deliverables**
- run metadata file (`run.json`)
- append-only logs (`nodes.jsonl`, `results.jsonl`, `queue.jsonl`)
- artifacts/logs directories

**Acceptance Criteria**
- new run creates all expected files/directories
- root node is appended to `nodes.jsonl`
- queue bootstrap event appended to `queue.jsonl`
- schema-aligned fields present in run + root node

---

## P1-02: Tool Surface for Run Lifecycle

**Goal**
Expose core lifecycle operations as pi tools.

**Tools**
- `repo_rlm_start`
- `repo_rlm_status`
- `repo_rlm_resume`
- `repo_rlm_cancel`
- `repo_rlm_export`

**Acceptance Criteria**
- each tool validates inputs and returns stable details payloads
- invalid `run_id` returns clear error
- cancel/resume enforce state transitions
- export writes artifact path and returns it

---

## P1-03: Derived Status + Checkpoint Update

**Goal**
Compute run progress from latest node snapshots and queue offsets.

**Deliverables**
- status derivation from node log
- `run.progress` refresh on status requests
- checkpoint (`last_event_offset`, `updated_at`) update

**Acceptance Criteria**
- status counters are deterministic from persisted logs
- repeated status calls are idempotent

---

## P1-04: Initial Export Contract

**Goal**
Provide operational exports before full recursive scheduler lands.

**Formats**
- markdown summary
- json state dump

**Acceptance Criteria**
- markdown export includes objective/mode/status/node counters
- json export includes run + nodes + queue events + result count
- outputs written under `artifacts/`

---

## P1-05: Schema Guardrail Validation (Lightweight)

**Goal**
Keep data contracts stable during implementation.

**Deliverables**
- schema docs in `docs/schemas`
- implementation fields aligned to schema names

**Acceptance Criteria**
- all persisted run/node/result objects use schema-compatible keys
- no undocumented top-level persistence files in run dir

---

## P1-06: Documentation + Operator UX

**Goal**
Make Phase 1 discoverable and operable.

**Deliverables**
- README links to spec/schemas
- execution notes for Phase 1 scaffold behavior

**Acceptance Criteria**
- user can start -> status -> export -> cancel/resume a run from tools alone
- docs clearly state recursive scheduler is pending in Phase 2

---

## Out of Scope for Phase 1

- recursive scheduler implementation (leaf/split expansion)
- batched child execution
- objective handlers (wiki/review synthesis)
- dedup/confidence aggregation

These start in Phase 2.
