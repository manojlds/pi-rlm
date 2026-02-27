#!/usr/bin/env python3
"""
Deterministic tests for repo-rlm core scheduler/state store.

These tests compile src/repo-rlm-core.ts to a temporary CommonJS file,
then run Node assertions against the compiled module.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GREEN = "\033[0;32m"
RED = "\033[0;31m"
NC = "\033[0m"

PASS = 0
FAIL = 0


def log_pass(msg: str):
    global PASS
    PASS += 1
    print(f"{GREEN}✓ PASS{NC}: {msg}")


def log_fail(msg: str, detail: str = ""):
    global FAIL
    FAIL += 1
    print(f"{RED}✗ FAIL{NC}: {msg} — {detail}")


def run(cmd, cwd=None, env=None):
    return subprocess.run(cmd, cwd=cwd, env=env, text=True, capture_output=True)


def main():
    print("╔══════════════════════════════════════════════╗")
    print("║   Repo RLM Core Tests                        ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    repo_root = Path(__file__).resolve().parents[1]

    tmp = Path(tempfile.mkdtemp(prefix="repo-rlm-core-test-"))
    try:
        out_dir = tmp / "dist"
        out_dir.mkdir(parents=True, exist_ok=True)

        # Compile core (no external pi deps) for runtime tests
        compile_cmd = [
            "npx",
            "tsc",
            "--target",
            "ES2022",
            "--module",
            "commonjs",
            "--outDir",
            str(out_dir),
            str(repo_root / "src" / "repo-rlm-core.ts"),
        ]
        c = run(compile_cmd, cwd=str(repo_root))
        if c.returncode != 0:
            log_fail("Compile repo-rlm-core.ts", c.stderr.strip() or c.stdout.strip())
            print_summary_and_exit()

        core_js = out_dir / "repo-rlm-core.js"
        if core_js.exists():
            log_pass("Compile repo-rlm-core.ts")
        else:
            log_fail("Compile repo-rlm-core.ts", "compiled file missing")
            print_summary_and_exit()

        workspace = tmp / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)

        # Test script executed in Node with assertions
        test_js = rf"""
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {{ RepoRLMStore }} = require({json.dumps(str(core_js))});

function ensureDir(p) {{ fs.mkdirSync(p, {{ recursive: true }}); }}
function writeFile(p, content) {{ ensureDir(path.dirname(p)); fs.writeFileSync(p, content); }}

function readJsonl(filePath) {{
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}}

function setupLeafRepo(base) {{
  ensureDir(base);
  writeFile(path.join(base, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFile(path.join(base, 'src', 'b.ts'), 'export const b = 2;\n');
  writeFile(path.join(base, 'README.md'), '# leaf repo\n');
}}

function setupSplitRepo(base) {{
  ensureDir(base);
  for (let d = 0; d < 3; d++) {{
    for (let i = 0; i < 8; i++) {{
      writeFile(path.join(base, `pkg${{d}}`, `f${{i}}.ts`), `export const x${{d}}_${{i}} = ${{i}};\n`);
    }}
  }}
}}

function setupReviewRepo(base) {{
  ensureDir(base);
  writeFile(path.join(base, 'src', 'risk.ts'), 'const x: any = eval("2+2");\n// TODO: remove eval\n');
  writeFile(path.join(base, 'src', 'safe.ts'), 'export const ok = true;\n');
}}

function runLeafCompletion(base) {{
  setupLeafRepo(base);
  const store = new RepoRLMStore(base);
  const run = store.startRun({{
    objective: 'leaf-test',
    mode: 'generic',
    config: {{ max_depth: 4, max_llm_calls: 100, max_tokens: 100000, max_wall_clock_ms: 300000, scheduler: 'bfs' }},
    domain: null,
    rootScopePaths: [base],
  }});

  const out = store.runUntil(run.run_id, 30);
  assert.equal(out.run.status, 'completed');

  const status = store.getStatus(run.run_id);
  const root = status.nodes.find(n => n.node_id === run.root_node_id);
  assert(root, 'root node missing');
  assert.equal(root.decision, 'leaf');
  assert(status.resultCount >= 1, 'expected at least one result');
}}

function runSplitAggregation(base) {{
  setupSplitRepo(base);
  const store = new RepoRLMStore(base);
  const run = store.startRun({{
    objective: 'split-test',
    mode: 'generic',
    config: {{ max_depth: 5, max_llm_calls: 400, max_tokens: 200000, max_wall_clock_ms: 300000, scheduler: 'bfs' }},
    domain: null,
    rootScopePaths: [base],
  }});

  const step1 = store.executeStep(run.run_id, 1);
  assert.equal(step1.processed_nodes, 1);

  const status1 = store.getStatus(run.run_id);
  const root1 = status1.nodes.find(n => n.node_id === run.root_node_id);
  assert(root1, 'root node missing after step');
  assert.equal(root1.decision, 'split');
  assert(root1.child_ids.length > 0, 'expected split children');

  const out = store.runUntil(run.run_id, 1000);
  assert.equal(out.run.status, 'completed');

  const resultsPath = path.join(base, '.pi', 'rlm', 'runs', run.run_id, 'results.jsonl');
  const results = readJsonl(resultsPath);
  const rootResult = results.find(r => r.node_id === run.root_node_id);
  assert(rootResult, 'missing aggregated root result');
}}

function runCancelResume(base) {{
  setupSplitRepo(base);
  const store = new RepoRLMStore(base);
  const run = store.startRun({{
    objective: 'resume-test',
    mode: 'generic',
    config: {{ max_depth: 5, max_llm_calls: 400, max_tokens: 200000, max_wall_clock_ms: 300000, scheduler: 'dfs' }},
    domain: null,
    rootScopePaths: [base],
  }});

  store.executeStep(run.run_id, 1);
  const cancelled = store.cancelRun(run.run_id);
  assert.equal(cancelled.status, 'cancelled');

  const resumed = store.resumeRun(run.run_id);
  assert.equal(resumed.status, 'running');

  const out = store.runUntil(run.run_id, 1000);
  assert.equal(out.run.status, 'completed');
}}

function runReviewEvidence(base) {{
  setupReviewRepo(base);
  const store = new RepoRLMStore(base);
  const run = store.startRun({{
    objective: 'review-test',
    mode: 'review',
    config: {{ max_depth: 4, max_llm_calls: 200, max_tokens: 100000, max_wall_clock_ms: 300000, scheduler: 'bfs' }},
    domain: 'quality',
    rootScopePaths: [base],
  }});

  const out = store.runUntil(run.run_id, 100);
  assert.equal(out.run.status, 'completed');

  const resultsPath = path.join(base, '.pi', 'rlm', 'runs', run.run_id, 'results.jsonl');
  const results = readJsonl(resultsPath);
  const nodeResultsWithFindings = results.filter(r => Array.isArray(r.findings) && r.findings.length > 0);
  assert(nodeResultsWithFindings.length > 0, 'expected review findings');

  const finding = nodeResultsWithFindings.flatMap(r => r.findings)[0];
  assert(Array.isArray(finding.evidence) && finding.evidence.length > 0, 'finding evidence missing');
  assert(typeof finding.evidence[0].path === 'string', 'evidence path missing');
  assert(Number.isInteger(finding.evidence[0].line_start), 'evidence line_start missing');

  const synth = store.synthesizeRun(run.run_id, 'review');
  assert(synth.artifacts.some(a => a.kind === 'review_report'), 'review report artifact missing');

  const rankedPath = path.join(base, '.pi', 'rlm', 'runs', run.run_id, 'artifacts', 'review', 'findings-ranked.json');
  const ranked = JSON.parse(fs.readFileSync(rankedPath, 'utf-8'));
  assert(ranked.raw_count >= ranked.deduped_count, 'dedupe count invariant broken');

  const codeQualityPath = path.join(base, '.pi', 'rlm', 'runs', run.run_id, 'artifacts', 'review', 'codequality.json');
  const sarifPath = path.join(base, '.pi', 'rlm', 'runs', run.run_id, 'artifacts', 'review', 'sarif.json');
  assert(fs.existsSync(codeQualityPath), 'codequality export missing');
  assert(fs.existsSync(sarifPath), 'sarif export missing');
}}

function runExportChecks(base) {{
  setupLeafRepo(base);
  const store = new RepoRLMStore(base);
  const run = store.startRun({{
    objective: 'export-test',
    mode: 'wiki',
    config: {{ max_depth: 4, max_llm_calls: 100, max_tokens: 100000, max_wall_clock_ms: 300000, scheduler: 'bfs' }},
    domain: 'architecture',
    rootScopePaths: [base],
  }});

  store.runUntil(run.run_id, 100);
  const synth = store.synthesizeRun(run.run_id, 'wiki');
  assert(synth.artifacts.some(a => a.kind === 'wiki_index'), 'wiki index artifact missing');

  const wikiIndex = path.join(base, '.pi', 'rlm', 'runs', run.run_id, 'artifacts', 'wiki', 'index.md');
  assert(fs.existsSync(wikiIndex), 'wiki index file missing');

  const jsonExport = store.exportRun(run.run_id, 'json');
  const mdExport = store.exportRun(run.run_id, 'markdown');
  assert(fs.existsSync(jsonExport.path), 'json export missing');
  assert(fs.existsSync(mdExport.path), 'markdown export missing');

  const data = JSON.parse(fs.readFileSync(jsonExport.path, 'utf-8'));
  assert(data.depth_histogram, 'depth_histogram missing in export');
}}

const ws = {json.dumps(str(workspace))};

runLeafCompletion(path.join(ws, 'leaf'));
runSplitAggregation(path.join(ws, 'split'));
runCancelResume(path.join(ws, 'resume'));
runReviewEvidence(path.join(ws, 'review'));
runExportChecks(path.join(ws, 'export'));

console.log('OK');
"""

        n = run(["node", "-e", test_js], cwd=str(repo_root))
        if n.returncode != 0:
            log_fail("Run repo-rlm core assertions", (n.stderr or n.stdout).strip())
        else:
            log_pass("Leaf/split/scheduler/aggregation/resume/export assertions")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print_summary_and_exit()


def print_summary_and_exit():
    print()
    print("═══════════════════════════════════════════════")
    print(f"Results: {GREEN}{PASS} passed{NC}, {RED}{FAIL} failed{NC}")
    print("═══════════════════════════════════════════════")
    sys.exit(FAIL)


if __name__ == "__main__":
    main()
