# Phase 3 Implementation Plan (RLM-First)

Status: **Partially Completed (Enhanced Scaffold)**  
Updated on: 2026-02-27

This phase focuses on objective-driven synthesis from recursive outputs.

---

## Completion Snapshot

- ✅ P3-01 Synthesis API (`repo_rlm_synthesize`)
- ✅ P3-02 Wiki synthesis scaffold (`artifacts/wiki/index.md`)
- ✅ P3-03 Review dedup + ranking scaffold (`findings-ranked.json`, `report.md`)
- ✅ P3-04 Export scaffold for CI (`codequality.json`, `sarif.json`)
- ✅ P3-05 Synthesis test coverage (deterministic core tests)
- 🟡 P3-06 Rich objective semantics (objective tags + architecture summary scaffolding)
- 🟡 P3-07 Advanced ranking / cross-node semantic merge (deterministic clustering scaffold)

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
- generated module index at `artifacts/wiki/module-index.md`
- generated architecture summary at `artifacts/wiki/architecture-summary.md`
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

Additional outputs:
- `artifacts/review/summary.json`
- `artifacts/review/findings-clusters.json`

---

## P3-05: Tests

**Status:** ✅ Done

Updated `tests/test-repo-rlm-core.py` coverage to assert:
- wiki synthesis artifact creation (`index`, `module-index`, `architecture-summary` path coverage via synthesis output)
- review synthesis dedupe invariant (`raw_count >= deduped_count`)
- review cluster and summary outputs
- codequality + sarif file generation

---

## P3-06: Rich Objective Semantics

**Status:** 🟡 Partial

Implemented now:
- objective tag extraction from run objective text
- objective tags propagated into review ranked/summary outputs
- architecture summary scaffolding includes objective + focus tags

Remaining:
- objective-specific prompt/LLM synthesis passes for higher semantic quality
- deeper architecture narratives tied to code graph semantics

---

## P3-07: Advanced Ranking & Merge

**Status:** 🟡 Partial

Implemented now:
- deterministic finding clustering by domain/module/title signature
- cluster hotspot summaries in report
- risk score + severity distribution

Remaining:
- semantic similarity clustering (beyond lexical signatures)
- cross-node evidence fusion and confidence calibration
- contradiction detection across findings

---

## Notes

Phase 3 now delivers an enhanced synthesis/export scaffold suitable for iterative use and CI artifact publication.  
Next improvements should focus on semantic depth (LLM-assisted synthesis) and ranking fidelity.
