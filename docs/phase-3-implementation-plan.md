# Phase 3 Implementation Plan (RLM-First)

Status: **Partially Completed (Scaffold)**  
Updated on: 2026-02-27

This phase focuses on objective-driven synthesis from recursive outputs.

---

## Completion Snapshot

- ✅ P3-01 Synthesis API (`repo_rlm_synthesize`)
- ✅ P3-02 Wiki synthesis scaffold (`artifacts/wiki/index.md`)
- ✅ P3-03 Review dedup + ranking scaffold (`findings-ranked.json`, `report.md`)
- ✅ P3-04 Export scaffold for CI (`codequality.json`, `sarif.json`)
- ✅ P3-05 Synthesis test coverage (deterministic core tests)
- ⏳ P3-06 Rich objective semantics (pending)
- ⏳ P3-07 Advanced ranking / cross-node semantic merge (pending)

---

## P3-01: Synthesis API

**Status:** ✅ Done

Implemented:
- `RepoRLMStore.synthesizeRun(runId, target)` in `src/repo-rlm-core.ts`
- `repo_rlm_synthesize` tool in `src/repo-rlm.ts`

Targets:
- `auto`
- `wiki`
- `review`
- `all`

---

## P3-02: Wiki Synthesis Scaffold

**Status:** ✅ Done

Implemented:
- wiki node artifact collection
- generated index at `artifacts/wiki/index.md`
- run output index merge/update

---

## P3-03: Review Dedup + Ranking Scaffold

**Status:** ✅ Done

Implemented:
- extraction of review findings from node results
- deterministic dedupe key using `(domain,title,path,line)`
- severity/confidence ranking
- output `artifacts/review/findings-ranked.json`
- markdown summary `artifacts/review/report.md`

---

## P3-04: CI Export Scaffold

**Status:** ✅ Done

Implemented review exports:
- GitLab Code Quality-like report: `artifacts/review/codequality.json`
- SARIF: `artifacts/review/sarif.json`

---

## P3-05: Tests

**Status:** ✅ Done

Updated `tests/test-repo-rlm-core.py` coverage to assert:
- wiki synthesis artifact creation
- review synthesis dedupe invariant (`raw_count >= deduped_count`)
- codequality + sarif file generation

---

## Remaining Phase 3 Work

### P3-06: Rich Objective Semantics

Pending:
- objective-specific synthesis prompts/handlers
- stronger architecture narratives for wiki mode
- domain-specific review pass contracts

### P3-07: Advanced Ranking & Merge

Pending:
- semantic clustering across related findings
- cross-node evidence merging
- confidence calibration from multi-signal scoring

---

## Notes

Phase 3 currently delivers a practical synthesis/export scaffold suitable for iteration and CI integration.  
Next upgrades should improve semantic quality, not just file-format coverage.
