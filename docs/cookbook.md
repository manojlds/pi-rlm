# Cookbook

Practical runbooks for common use cases.

---

## 1) Full repo code review (deterministic + semantic)

1. Start run
```text
Use repo_rlm_start with objective "deep code quality and reliability review" and mode "review".
```

2. Execute recursion
```text
Use repo_rlm_run for run_id "<id>" with max_nodes 800.
```

3. Synthesize deterministic review artifacts
```text
Use repo_rlm_synthesize for run_id "<id>" with target "review".
```

4. Add semantic narrative
```text
Use repo_rlm_synthesize for run_id "<id>" with target "review" and semantic true.
```

5. Export summary
```text
Use repo_rlm_export for run_id "<id>" with format "markdown".
```

---

## 2) Repo wiki generation

1. Start
```text
Use repo_rlm_start with objective "generate a DeepWiki-style architecture wiki for this repository" and mode "wiki".
# optional: exclude_paths ["vendor", "third_party", "generated/**"]
```

2. Run
```text
Use repo_rlm_run for run_id "<id>" with max_nodes 600.
```

3. Synthesize wiki artifacts
```text
Use repo_rlm_synthesize for run_id "<id>" with target "wiki".
```

4. Optional semantic architecture brief
```text
Use repo_rlm_synthesize for run_id "<id>" with target "wiki" and semantic true.
```

---

## 3) Interactive recursion debugging

1. Start with lower budgets
```text
Use repo_rlm_start with objective "review auth and permission model" mode "review" max_depth 3 max_llm_calls 80.
```

2. Step through manually
```text
Use repo_rlm_step for run_id "<id>" with max_nodes 5.
Use repo_rlm_status for run_id "<id>".
```

3. Continue until stable
```text
Use repo_rlm_run for run_id "<id>" with max_nodes 200.
```

---

## 4) Large single-file/long text investigation with `rlm`

```text
Use rlm with query "find all parsing failure patterns and summarize root causes" and context "file:/absolute/path/to/log.txt".
```

Tips:
- raise `max_iterations` for difficult data archaeology
- raise `max_depth` when recursive decomposition helps

---

## 5) Resume interrupted runs

```text
Use repo_rlm_status for run_id "<id>".
Use repo_rlm_resume for run_id "<id>".
Use repo_rlm_run for run_id "<id>" with max_nodes 500.
```

---

## 6) Produce CI-friendly outputs only

```text
Use repo_rlm_synthesize for run_id "<id>" with target "review".
```

Collect:
- `artifacts/review/codequality.json`
- `artifacts/review/sarif.json`
