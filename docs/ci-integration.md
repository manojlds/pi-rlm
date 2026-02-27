# CI Integration

This extension can emit machine-readable review artifacts for CI:

- `artifacts/review/codequality.json`
- `artifacts/review/sarif.json`

Run synthesis first:

```text
Use repo_rlm_synthesize for run_id "<id>" with target "review".
```

---

## GitHub Code Scanning (SARIF)

After generation, upload `sarif.json` with `github/codeql-action/upload-sarif`.

Example workflow fragment:

```yaml
name: Upload RLM SARIF
on: [workflow_dispatch]
jobs:
  upload-sarif:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: .pi/rlm/runs/<run-id>/artifacts/review/sarif.json
```

---

## GitLab Code Quality

Use `codequality.json` as code quality report artifact.

Example fragment:

```yaml
code_quality:
  stage: test
  script:
    - echo "RLM synthesis should already have produced codequality.json"
  artifacts:
    reports:
      codequality: .pi/rlm/runs/<run-id>/artifacts/review/codequality.json
```

---

## Practical workflow

1. Execute run (`repo_rlm_run`)
2. Synthesize review (`repo_rlm_synthesize target=review`)
3. Publish SARIF + codequality artifacts
4. Optionally archive human-readable reports:
   - `report.md`
   - `report.semantic.md` (if semantic mode enabled)
