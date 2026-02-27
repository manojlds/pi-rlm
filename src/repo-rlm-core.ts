import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

export type RepoRLMMode = "generic" | "wiki" | "review";
export type RepoRLMScheduler = "bfs" | "dfs" | "hybrid";

type RepoRLMNodeScopeType = "repo" | "dir" | "module" | "file_group" | "file_slice";
type RepoRLMNodeStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type RepoRLMNodeDecision = "undecided" | "leaf" | "split";

interface RepoRLMRunConfig {
  max_depth: number;
  max_llm_calls: number;
  max_tokens: number;
  max_wall_clock_ms: number;
  scheduler: RepoRLMScheduler;
}

interface RepoRLMRun {
  run_id: string;
  objective: string;
  mode: RepoRLMMode;
  status: "running" | "completed" | "failed" | "cancelled";
  root_node_id: string;
  config: RepoRLMRunConfig;
  progress: {
    nodes_total: number;
    nodes_completed: number;
    nodes_failed: number;
    active_nodes: number;
    max_depth_seen: number;
  };
  output_index: Array<{ kind: string; path: string }>;
  checkpoint: {
    last_event_offset: number;
    updated_at: string;
  };
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface RepoRLMNode {
  run_id: string;
  node_id: string;
  parent_id: string | null;
  depth: number;
  scope_type: RepoRLMNodeScopeType;
  scope_ref: {
    paths: string[];
  };
  objective: string;
  domain: "security" | "quality" | "performance" | "docs" | "architecture" | null;
  status: RepoRLMNodeStatus;
  decision: RepoRLMNodeDecision;
  decision_reason?: string;
  child_ids: string[];
  confidence: number | null;
  budgets: {
    max_depth: number;
    remaining_llm_calls: number;
    remaining_tokens: number;
    deadline_epoch_ms: number;
  };
  metrics?: {
    file_count?: number;
    total_bytes?: number;
    duration_ms?: number;
    findings_count?: number;
  };
  errors?: Array<{ code: string; message: string; retryable?: boolean }>;
  created_at: string;
  updated_at: string;
}

interface RepoRLMResult {
  run_id: string;
  node_id: string;
  status: "completed" | "partial" | "failed";
  summary: string;
  findings: unknown[];
  artifacts: Array<{ kind: string; path: string }>;
  aggregation_notes?: string;
  created_at: string;
}

interface QueueEvent {
  run_id: string;
  event: string;
  node_id: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

interface ScopeMetrics {
  fileCount: number;
  totalBytes: number;
  sampledFiles: string[];
}

interface DecisionOutcome {
  decision: Extract<RepoRLMNodeDecision, "leaf" | "split">;
  reason: string;
  metrics: ScopeMetrics;
}

type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

interface FindingEvidence {
  path: string;
  line_start: number;
  line_end: number;
  quote?: string;
}

interface ReviewFinding {
  id: string;
  domain: string;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  description: string;
  suggested_fix?: string;
  evidence: FindingEvidence[];
}

interface FindingCluster {
  cluster_id: string;
  title: string;
  domain: string;
  severity: FindingSeverity;
  confidence: number;
  finding_ids: string[];
  affected_paths: string[];
  count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function appendJsonl(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value) + "\n", { flag: "a", encoding: "utf-8" });
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function isTerminalNodeStatus(status: RepoRLMNodeStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function severityRank(severity: FindingSeverity): number {
  switch (severity) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

function mapSeverityToCodeClimate(severity: FindingSeverity): "blocker" | "critical" | "major" | "minor" | "info" {
  switch (severity) {
    case "critical":
      return "blocker";
    case "high":
      return "critical";
    case "medium":
      return "major";
    case "low":
      return "minor";
    default:
      return "info";
  }
}

function safeRelPath(cwd: string, p: string): string {
  const rel = relative(cwd, p);
  return rel || p;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstPathSegment(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\/+/, "");
  const seg = norm.split("/")[0] || norm;
  return seg || "(root)";
}

function objectiveFocusTags(objective: string): string[] {
  const o = objective.toLowerCase();
  const tags: string[] = [];
  if (/security|auth|injection|xss|crypto|secret/.test(o)) tags.push("security");
  if (/performance|latency|throughput|cpu|memory|scale/.test(o)) tags.push("performance");
  if (/quality|correctness|bug|reliability|type/.test(o)) tags.push("quality");
  if (/docs|documentation|readme|guide|wiki/.test(o)) tags.push("docs");
  if (/architecture|design|module|structure/.test(o)) tags.push("architecture");
  return Array.from(new Set(tags));
}

export class RepoRLMStore {
  private baseDir: string;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.baseDir = join(cwd, ".pi", "rlm", "runs");
    mkdirSync(this.baseDir, { recursive: true });
  }

  private runDir(runId: string): string {
    return join(this.baseDir, runId);
  }

  private runJsonPath(runId: string): string {
    return join(this.runDir(runId), "run.json");
  }

  private nodesPath(runId: string): string {
    return join(this.runDir(runId), "nodes.jsonl");
  }

  private resultsPath(runId: string): string {
    return join(this.runDir(runId), "results.jsonl");
  }

  private queuePath(runId: string): string {
    return join(this.runDir(runId), "queue.jsonl");
  }

  private ensureRunDirs(runId: string): void {
    mkdirSync(this.runDir(runId), { recursive: true });
    mkdirSync(join(this.runDir(runId), "artifacts"), { recursive: true });
    mkdirSync(join(this.runDir(runId), "logs"), { recursive: true });
  }

  private toAbs(pathLike: string): string {
    if (!pathLike) return this.cwd;
    return resolve(pathLike.startsWith("/") ? pathLike : join(this.cwd, pathLike));
  }

  private appendNode(runId: string, node: RepoRLMNode): void {
    appendJsonl(this.nodesPath(runId), node);
  }

  private appendResult(runId: string, result: RepoRLMResult): void {
    appendJsonl(this.resultsPath(runId), result);
  }

  private appendQueue(runId: string, event: QueueEvent): void {
    appendJsonl(this.queuePath(runId), event);
  }

  startRun(input: {
    objective: string;
    mode: RepoRLMMode;
    config: RepoRLMRunConfig;
    domain: RepoRLMNode["domain"];
    rootScopePaths: string[];
  }): RepoRLMRun {
    const createdAt = nowIso();
    const runId = makeRunId();
    const rootNodeId = `${runId}:root`;

    this.ensureRunDirs(runId);

    const run: RepoRLMRun = {
      run_id: runId,
      objective: input.objective,
      mode: input.mode,
      status: "running",
      root_node_id: rootNodeId,
      config: input.config,
      progress: {
        nodes_total: 1,
        nodes_completed: 0,
        nodes_failed: 0,
        active_nodes: 0,
        max_depth_seen: 0,
      },
      output_index: [],
      checkpoint: {
        last_event_offset: 0,
        updated_at: createdAt,
      },
      created_at: createdAt,
      updated_at: createdAt,
    };

    const rootNode: RepoRLMNode = {
      run_id: runId,
      node_id: rootNodeId,
      parent_id: null,
      depth: 0,
      scope_type: "repo",
      scope_ref: {
        paths: input.rootScopePaths,
      },
      objective: input.objective,
      domain: input.domain,
      status: "queued",
      decision: "undecided",
      child_ids: [],
      confidence: null,
      budgets: {
        max_depth: input.config.max_depth,
        remaining_llm_calls: input.config.max_llm_calls,
        remaining_tokens: input.config.max_tokens,
        deadline_epoch_ms: Date.now() + input.config.max_wall_clock_ms,
      },
      created_at: createdAt,
      updated_at: createdAt,
    };

    writeJson(this.runJsonPath(runId), run);
    this.appendNode(runId, rootNode);
    this.appendQueue(runId, {
      run_id: runId,
      event: "node_enqueued",
      node_id: rootNodeId,
      timestamp: createdAt,
      details: { reason: "run_start" },
    });

    return run;
  }

  getRun(runId: string): RepoRLMRun {
    const path = this.runJsonPath(runId);
    if (!existsSync(path)) throw new Error(`Run not found: ${runId}`);
    return readJson<RepoRLMRun>(path);
  }

  private setRun(run: RepoRLMRun): void {
    writeJson(this.runJsonPath(run.run_id), run);
  }

  private getLatestNodeMap(runId: string): Map<string, RepoRLMNode> {
    const events = readJsonl<RepoRLMNode>(this.nodesPath(runId));
    const latest = new Map<string, RepoRLMNode>();
    for (const ev of events) latest.set(ev.node_id, ev);
    return latest;
  }

  getLatestNodes(runId: string): RepoRLMNode[] {
    return Array.from(this.getLatestNodeMap(runId).values());
  }

  private getLatestResultMap(runId: string): Map<string, RepoRLMResult> {
    const events = readJsonl<RepoRLMResult>(this.resultsPath(runId));
    const latest = new Map<string, RepoRLMResult>();
    for (const ev of events) latest.set(ev.node_id, ev);
    return latest;
  }

  private selectNextQueuedNode(nodes: RepoRLMNode[], scheduler: RepoRLMScheduler): RepoRLMNode | undefined {
    const queued = nodes.filter((n) => n.status === "queued");
    if (queued.length === 0) return undefined;

    if (scheduler === "dfs") {
      return queued.sort((a, b) => b.depth - a.depth || a.created_at.localeCompare(b.created_at))[0];
    }

    // bfs and hybrid currently behave the same; hybrid can evolve later.
    return queued.sort((a, b) => a.depth - b.depth || a.created_at.localeCompare(b.created_at))[0];
  }

  private updateNode(runId: string, nodeId: string, update: (current: RepoRLMNode) => RepoRLMNode): RepoRLMNode {
    const map = this.getLatestNodeMap(runId);
    const current = map.get(nodeId);
    if (!current) throw new Error(`Node not found: ${nodeId}`);
    const next = update(current);
    next.updated_at = nowIso();
    this.appendNode(runId, next);
    return next;
  }

  private collectScopeFiles(paths: string[], maxFiles: number): ScopeMetrics {
    const sampledFiles: string[] = [];
    let totalBytes = 0;
    const stack = paths.map((p) => this.toAbs(p));
    const visited = new Set<string>();

    while (stack.length > 0 && sampledFiles.length < maxFiles) {
      const p = stack.pop()!;
      if (visited.has(p)) continue;
      visited.add(p);

      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }

      if (st.isFile()) {
        sampledFiles.push(p);
        totalBytes += st.size;
        continue;
      }

      if (!st.isDirectory()) continue;

      let entries: string[] = [];
      try {
        entries = readdirSync(p);
      } catch {
        continue;
      }

      for (const name of entries) {
        if (sampledFiles.length >= maxFiles) break;
        stack.push(join(p, name));
      }
    }

    return {
      fileCount: sampledFiles.length,
      totalBytes,
      sampledFiles,
    };
  }

  private decideNode(run: RepoRLMRun, node: RepoRLMNode): DecisionOutcome {
    const metrics = this.collectScopeFiles(node.scope_ref.paths, 400);

    if (Date.now() > node.budgets.deadline_epoch_ms) {
      return { decision: "leaf", reason: "deadline_exceeded", metrics };
    }
    if (node.depth >= run.config.max_depth) {
      return { decision: "leaf", reason: "max_depth_reached", metrics };
    }
    if (node.budgets.remaining_llm_calls <= 0) {
      return { decision: "leaf", reason: "llm_budget_exhausted", metrics };
    }
    if (node.budgets.remaining_tokens <= 0) {
      return { decision: "leaf", reason: "token_budget_exhausted", metrics };
    }

    const splitThresholdFiles = run.mode === "review" ? 12 : 16;
    const splitThresholdBytes = run.mode === "review" ? 2_000_000 : 3_000_000;

    if (metrics.fileCount > splitThresholdFiles || metrics.totalBytes > splitThresholdBytes) {
      return { decision: "split", reason: "scope_too_large", metrics };
    }

    return { decision: "leaf", reason: "scope_small_enough", metrics };
  }

  private splitNode(run: RepoRLMRun, node: RepoRLMNode): RepoRLMNode[] {
    const dirs: string[] = [];
    const files: string[] = [];

    for (const raw of node.scope_ref.paths) {
      const p = this.toAbs(raw);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isFile()) {
        files.push(p);
        continue;
      }
      if (!st.isDirectory()) continue;

      let entries: string[] = [];
      try {
        entries = readdirSync(p);
      } catch {
        continue;
      }

      for (const name of entries) {
        const child = join(p, name);
        try {
          const childSt = statSync(child);
          if (childSt.isDirectory()) dirs.push(child);
          else if (childSt.isFile()) files.push(child);
        } catch {
          // ignore inaccessible child
        }
      }
    }

    const children: RepoRLMNode[] = [];
    const now = nowIso();

    const llmBudgetAfterSplit = Math.max(0, node.budgets.remaining_llm_calls - 1);
    const tokenBudgetAfterSplit = Math.max(0, node.budgets.remaining_tokens - 4000);

    const childScopes: Array<{ scope_type: RepoRLMNodeScopeType; paths: string[]; label: string }> = [];

    if (dirs.length > 0) {
      for (const d of dirs) {
        childScopes.push({
          scope_type: "dir",
          paths: [d],
          label: basename(d),
        });
      }
    } else {
      const grouped = chunk(files, 8);
      grouped.forEach((group, i) => {
        childScopes.push({
          scope_type: "file_group",
          paths: group,
          label: `group-${i + 1}`,
        });
      });
    }

    const perChildCalls = childScopes.length > 0 ? Math.floor(llmBudgetAfterSplit / childScopes.length) : 0;
    const perChildTokens = childScopes.length > 0 ? Math.floor(tokenBudgetAfterSplit / childScopes.length) : 0;

    childScopes.forEach((scope, i) => {
      const id = `${node.node_id}:${i + 1}:${scope.label.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      children.push({
        run_id: run.run_id,
        node_id: id,
        parent_id: node.node_id,
        depth: node.depth + 1,
        scope_type: scope.scope_type,
        scope_ref: {
          paths: scope.paths,
        },
        objective: node.objective,
        domain: node.domain,
        status: "queued",
        decision: "undecided",
        child_ids: [],
        confidence: null,
        budgets: {
          max_depth: node.budgets.max_depth,
          remaining_llm_calls: Math.max(0, perChildCalls),
          remaining_tokens: Math.max(0, perChildTokens),
          deadline_epoch_ms: node.budgets.deadline_epoch_ms,
        },
        created_at: now,
        updated_at: now,
      });
    });

    return children;
  }

  private scanReviewFindings(run: RepoRLMRun, node: RepoRLMNode, files: string[]): RepoRLMResult["findings"] {
    if (run.mode !== "review") return [];

    const findings: any[] = [];
    const maxFilesToInspect = Math.min(40, files.length);

    for (let i = 0; i < maxFilesToInspect; i++) {
      const file = files[i];
      const relPath = relative(this.cwd, file) || file;

      let content = "";
      try {
        const st = statSync(file);
        if (st.size > 256_000) continue;
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }

      const checks: Array<{ pattern: string; severity: "high" | "medium" | "low"; title: string; domain: string }> = [
        { pattern: "eval(", severity: "high", title: "Potential dynamic code execution", domain: "security" },
        { pattern: "TODO", severity: "low", title: "Unresolved TODO found", domain: "quality" },
        { pattern: "any", severity: "medium", title: "Type safety risk (`any`)", domain: "quality" },
      ];

      for (const check of checks) {
        const idx = content.indexOf(check.pattern);
        if (idx === -1) continue;
        const ln = lineNumberAt(content, idx);

        findings.push({
          id: `${node.node_id}:${findings.length + 1}`,
          domain: check.domain,
          severity: check.severity,
          confidence: check.severity === "high" ? 0.8 : 0.6,
          title: check.title,
          description: `Pattern \`${check.pattern}\` detected in ${relPath}`,
          suggested_fix:
            check.pattern === "any"
              ? "Replace `any` with stricter types."
              : check.pattern === "TODO"
                ? "Track TODO in issue and resolve or remove."
                : "Avoid eval-like constructs or strictly validate inputs.",
          evidence: [
            {
              path: relPath,
              line_start: ln,
              line_end: ln,
              quote: check.pattern,
            },
          ],
        });
      }

      if (findings.length >= 25) break;
    }

    return findings;
  }

  private executeLeafNode(run: RepoRLMRun, node: RepoRLMNode): RepoRLMResult {
    const started = Date.now();
    const metrics = this.collectScopeFiles(node.scope_ref.paths, 200);

    const extCounts = new Map<string, number>();
    for (const f of metrics.sampledFiles) {
      const ext = extname(f) || "(no-ext)";
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }

    const topExt = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}:${count}`)
      .join(", ");

    const findings = this.scanReviewFindings(run, node, metrics.sampledFiles);

    const relPathsPreview = metrics.sampledFiles
      .slice(0, 10)
      .map((p) => relative(this.cwd, p))
      .filter(Boolean)
      .join(", ");

    const summary = [
      `Leaf analysis for node ${node.node_id}`,
      `scope=${node.scope_type}`,
      `files=${metrics.fileCount}`,
      `bytes=${metrics.totalBytes}`,
      topExt ? `top_extensions=${topExt}` : "top_extensions=(none)",
      relPathsPreview ? `sample_files=${relPathsPreview}` : "sample_files=(none)",
      run.mode === "review" ? `findings=${findings.length}` : "",
      `duration_ms=${Date.now() - started}`,
    ]
      .filter(Boolean)
      .join(" | ");

    const artifacts: Array<{ kind: string; path: string }> = [];

    if (run.mode === "wiki") {
      const wikiDir = join(this.runDir(run.run_id), "artifacts", "wiki", "nodes");
      mkdirSync(wikiDir, { recursive: true });
      const safe = node.node_id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const relArtifactPath = join("artifacts", "wiki", "nodes", `${safe}.md`);
      const artifactPath = join(this.runDir(run.run_id), relArtifactPath);
      const body = [
        `# Node ${node.node_id}`,
        "",
        `- Scope: ${node.scope_type}`,
        `- Objective: ${node.objective}`,
        `- File count: ${metrics.fileCount}`,
        `- Total bytes (sampled): ${metrics.totalBytes}`,
        topExt ? `- Top extensions: ${topExt}` : "- Top extensions: none",
        "",
        "## Sample files",
        "",
        ...metrics.sampledFiles.slice(0, 25).map((p) => `- ${relative(this.cwd, p) || p}`),
      ].join("\n");
      writeFileSync(artifactPath, body + "\n", "utf-8");
      artifacts.push({ kind: "wiki_node", path: relArtifactPath });
    }

    return {
      run_id: run.run_id,
      node_id: node.node_id,
      status: "completed",
      summary,
      findings,
      artifacts,
      created_at: nowIso(),
    };
  }

  private aggregateReadySplitParents(runId: string): number {
    const nodes = this.getLatestNodes(runId);
    const resultMap = this.getLatestResultMap(runId);
    let aggregated = 0;

    for (const parent of nodes) {
      if (parent.decision !== "split" || parent.status !== "running") continue;
      if (resultMap.has(parent.node_id)) continue;
      if (!parent.child_ids || parent.child_ids.length === 0) continue;

      const childNodes = parent.child_ids
        .map((id) => nodes.find((n) => n.node_id === id))
        .filter((n): n is RepoRLMNode => Boolean(n));

      if (childNodes.length !== parent.child_ids.length) continue;
      if (!childNodes.every((n) => isTerminalNodeStatus(n.status))) continue;

      const childResults = childNodes
        .map((n) => resultMap.get(n.node_id))
        .filter((r): r is RepoRLMResult => Boolean(r));

      const failedChildren = childNodes.filter((n) => n.status === "failed" || n.status === "cancelled").length;

      const summaryLines: string[] = [
        `Aggregated ${childNodes.length} child nodes for ${parent.node_id}.`,
        ...childResults.slice(0, 8).map((r) => `- ${r.node_id}: ${r.summary}`),
      ];

      const findings = childResults.flatMap((r: any) => (Array.isArray(r.findings) ? r.findings : []));
      const artifacts = childResults.flatMap((r) => r.artifacts ?? []);

      const result: RepoRLMResult = {
        run_id: runId,
        node_id: parent.node_id,
        status: failedChildren > 0 ? "partial" : "completed",
        summary: summaryLines.join("\n"),
        findings,
        artifacts,
        aggregation_notes: failedChildren > 0 ? `${failedChildren} child nodes failed or were cancelled.` : undefined,
        created_at: nowIso(),
      };
      this.appendResult(runId, result);

      this.updateNode(runId, parent.node_id, (current) => ({
        ...current,
        status: failedChildren === childNodes.length ? "failed" : "completed",
        confidence: failedChildren > 0 ? 0.6 : 0.8,
        metrics: {
          ...(current.metrics ?? {}),
          findings_count: Array.isArray(findings) ? findings.length : 0,
        },
      }));

      this.appendQueue(runId, {
        run_id: runId,
        event: "node_aggregated",
        node_id: parent.node_id,
        timestamp: nowIso(),
        details: {
          child_count: childNodes.length,
          failed_children: failedChildren,
        },
      });

      aggregated++;
    }

    return aggregated;
  }

  private refreshRunProgress(run: RepoRLMRun): RepoRLMRun {
    const nodes = this.getLatestNodes(run.run_id);
    const queueEvents = readJsonl<QueueEvent>(this.queuePath(run.run_id));

    run.progress = {
      nodes_total: nodes.length,
      nodes_completed: nodes.filter((n) => n.status === "completed").length,
      nodes_failed: nodes.filter((n) => n.status === "failed").length,
      active_nodes: nodes.filter((n) => n.status === "running").length,
      max_depth_seen: nodes.reduce((m, n) => Math.max(m, n.depth), 0),
    };

    run.checkpoint.last_event_offset = queueEvents.length;
    run.checkpoint.updated_at = nowIso();
    run.updated_at = run.checkpoint.updated_at;

    return run;
  }

  private refreshRunTerminalState(run: RepoRLMRun): RepoRLMRun {
    const nodes = this.getLatestNodes(run.run_id);
    const root = nodes.find((n) => n.node_id === run.root_node_id);

    if (!root) {
      run.status = "failed";
      run.updated_at = nowIso();
      run.completed_at = run.updated_at;
      return run;
    }

    if (root.status === "completed") {
      run.status = "completed";
      run.updated_at = nowIso();
      run.completed_at = run.updated_at;
      return run;
    }

    if (root.status === "failed") {
      run.status = "failed";
      run.updated_at = nowIso();
      run.completed_at = run.updated_at;
      return run;
    }

    if (root.status === "cancelled") {
      run.status = "cancelled";
      run.updated_at = nowIso();
      run.completed_at = run.updated_at;
      return run;
    }

    const queuedOrRunning = nodes.filter((n) => n.status === "queued" || n.status === "running").length;
    if (queuedOrRunning === 0) {
      run.status = "failed";
      run.updated_at = nowIso();
      run.completed_at = run.updated_at;
    }

    return run;
  }

  executeStep(runId: string, maxNodes: number): {
    run: RepoRLMRun;
    processed_nodes: number;
    aggregated_nodes: number;
    notes: string[];
  } {
    let run = this.getRun(runId);
    if (run.status !== "running") {
      throw new Error(`Run ${runId} is not running (status=${run.status})`);
    }

    const notes: string[] = [];
    let processed = 0;
    let aggregatedTotal = 0;

    for (let i = 0; i < Math.max(1, maxNodes); i++) {
      aggregatedTotal += this.aggregateReadySplitParents(runId);

      const allNodes = this.getLatestNodes(runId);
      const next = this.selectNextQueuedNode(allNodes, run.config.scheduler);
      if (!next) {
        notes.push("No queued nodes available.");
        break;
      }

      this.appendQueue(runId, {
        run_id: runId,
        event: "node_dequeued",
        node_id: next.node_id,
        timestamp: nowIso(),
      });

      const startedAt = Date.now();
      const runningNode = this.updateNode(runId, next.node_id, (current) => ({
        ...current,
        status: "running",
      }));

      this.appendQueue(runId, {
        run_id: runId,
        event: "node_started",
        node_id: runningNode.node_id,
        timestamp: nowIso(),
      });

      try {
        const decision = this.decideNode(run, runningNode);

        if (decision.decision === "split") {
          const children = this.splitNode(run, runningNode);

          if (children.length === 0) {
            notes.push(`Node ${runningNode.node_id} split fallback to leaf (no children).`);
            const leafResult = this.executeLeafNode(run, runningNode);
            this.appendResult(runId, leafResult);
            this.updateNode(runId, runningNode.node_id, (current) => ({
              ...current,
              decision: "leaf",
              decision_reason: "split_no_children_fallback_leaf",
              status: "completed",
              confidence: 0.75,
              metrics: {
                ...(current.metrics ?? {}),
                duration_ms: Date.now() - startedAt,
                findings_count: (leafResult.findings ?? []).length,
              },
            }));
            this.appendQueue(runId, {
              run_id: runId,
              event: "node_completed",
              node_id: runningNode.node_id,
              timestamp: nowIso(),
            });
          } else {
            const childIds = children.map((c) => c.node_id);
            this.updateNode(runId, runningNode.node_id, (current) => ({
              ...current,
              decision: "split",
              decision_reason: decision.reason,
              child_ids: childIds,
              metrics: {
                ...(current.metrics ?? {}),
                file_count: decision.metrics.fileCount,
                total_bytes: decision.metrics.totalBytes,
                duration_ms: Date.now() - startedAt,
              },
            }));

            this.appendQueue(runId, {
              run_id: runId,
              event: "node_split",
              node_id: runningNode.node_id,
              timestamp: nowIso(),
              details: {
                reason: decision.reason,
                child_count: children.length,
              },
            });

            for (const child of children) {
              this.appendNode(runId, child);
              this.appendQueue(runId, {
                run_id: runId,
                event: "node_enqueued",
                node_id: child.node_id,
                timestamp: nowIso(),
                details: {
                  parent_id: runningNode.node_id,
                },
              });
            }

            notes.push(`Node ${runningNode.node_id} split into ${children.length} children.`);
          }
        } else {
          const leafResult = this.executeLeafNode(run, runningNode);
          this.appendResult(runId, leafResult);
          this.updateNode(runId, runningNode.node_id, (current) => ({
            ...current,
            decision: "leaf",
            decision_reason: decision.reason,
            status: "completed",
            confidence: 0.8,
            metrics: {
              ...(current.metrics ?? {}),
              file_count: decision.metrics.fileCount,
              total_bytes: decision.metrics.totalBytes,
              duration_ms: Date.now() - startedAt,
              findings_count: (leafResult.findings ?? []).length,
            },
          }));
          this.appendQueue(runId, {
            run_id: runId,
            event: "node_completed",
            node_id: runningNode.node_id,
            timestamp: nowIso(),
            details: { reason: decision.reason },
          });
          notes.push(`Node ${runningNode.node_id} completed as leaf.`);
        }
      } catch (error: any) {
        this.updateNode(runId, runningNode.node_id, (current) => ({
          ...current,
          status: "failed",
          errors: [
            {
              code: "node_execution_error",
              message: String(error?.message ?? error),
              retryable: false,
            },
          ],
          metrics: {
            ...(current.metrics ?? {}),
            duration_ms: Date.now() - startedAt,
          },
        }));
        this.appendQueue(runId, {
          run_id: runId,
          event: "node_failed",
          node_id: runningNode.node_id,
          timestamp: nowIso(),
          details: { message: String(error?.message ?? error) },
        });
        notes.push(`Node ${runningNode.node_id} failed: ${String(error?.message ?? error)}`);
      }

      processed++;
      run = this.getRun(runId);
      if (run.status !== "running") break;
    }

    aggregatedTotal += this.aggregateReadySplitParents(runId);

    run = this.getRun(runId);
    run = this.refreshRunProgress(run);
    run = this.refreshRunTerminalState(run);

    // keep output index synced with latest artifacts from results
    const resultMap = this.getLatestResultMap(runId);
    const artifactIndex: Array<{ kind: string; path: string }> = [];
    Array.from(resultMap.values()).forEach((r) => {
      (r.artifacts ?? []).forEach((a) => {
        artifactIndex.push({ kind: a.kind, path: a.path });
      });
    });
    run.output_index = artifactIndex;

    this.setRun(run);

    return {
      run,
      processed_nodes: processed,
      aggregated_nodes: aggregatedTotal,
      notes,
    };
  }

  runUntil(runId: string, maxNodes: number): {
    run: RepoRLMRun;
    processed_nodes: number;
    aggregated_nodes: number;
    notes: string[];
  } {
    let processed = 0;
    let aggregated = 0;
    const notes: string[] = [];

    for (let i = 0; i < Math.max(1, maxNodes); i++) {
      const step = this.executeStep(runId, 1);
      processed += step.processed_nodes;
      aggregated += step.aggregated_nodes;
      notes.push(...step.notes);
      if (step.run.status !== "running") {
        return {
          run: step.run,
          processed_nodes: processed,
          aggregated_nodes: aggregated,
          notes,
        };
      }
      if (step.processed_nodes === 0 && step.aggregated_nodes === 0) {
        return {
          run: step.run,
          processed_nodes: processed,
          aggregated_nodes: aggregated,
          notes,
        };
      }
    }

    const run = this.getRun(runId);
    return {
      run,
      processed_nodes: processed,
      aggregated_nodes: aggregated,
      notes,
    };
  }

  getStatus(runId: string): {
    run: RepoRLMRun;
    nodes: RepoRLMNode[];
    queueEvents: QueueEvent[];
    resultCount: number;
    depthHistogram: Record<string, number>;
    activeBranchPreview: Array<{ node_id: string; depth: number; status: RepoRLMNodeStatus; decision: RepoRLMNodeDecision }>;
  } {
    const run = this.getRun(runId);
    const nodes = this.getLatestNodes(runId);
    const queueEvents = readJsonl<QueueEvent>(this.queuePath(runId));
    const results = readJsonl<RepoRLMResult>(this.resultsPath(runId));

    const nodesCompleted = nodes.filter((n) => n.status === "completed").length;
    const nodesFailed = nodes.filter((n) => n.status === "failed").length;
    const activeNodes = nodes.filter((n) => n.status === "running").length;
    const maxDepthSeen = nodes.reduce((m, n) => Math.max(m, n.depth), 0);

    const depthHistogram: Record<string, number> = {};
    for (const node of nodes) {
      const key = String(node.depth);
      depthHistogram[key] = (depthHistogram[key] ?? 0) + 1;
    }

    const activeBranchPreview = nodes
      .filter((n) => n.status === "running" || n.status === "queued")
      .sort((a, b) => b.depth - a.depth || a.created_at.localeCompare(b.created_at))
      .slice(0, 8)
      .map((n) => ({ node_id: n.node_id, depth: n.depth, status: n.status, decision: n.decision }));

    run.progress = {
      nodes_total: nodes.length,
      nodes_completed: nodesCompleted,
      nodes_failed: nodesFailed,
      active_nodes: activeNodes,
      max_depth_seen: maxDepthSeen,
    };
    run.updated_at = nowIso();
    run.checkpoint.updated_at = run.updated_at;
    run.checkpoint.last_event_offset = queueEvents.length;
    this.setRun(run);

    return {
      run,
      nodes,
      queueEvents,
      resultCount: results.length,
      depthHistogram,
      activeBranchPreview,
    };
  }

  cancelRun(runId: string): RepoRLMRun {
    const run = this.getRun(runId);
    if (run.status === "completed" || run.status === "failed") {
      throw new Error(`Cannot cancel run in terminal state: ${run.status}`);
    }
    run.status = "cancelled";
    run.updated_at = nowIso();
    run.completed_at = run.updated_at;
    run.checkpoint.updated_at = run.updated_at;
    this.setRun(run);

    const nodes = this.getLatestNodes(runId).filter((n) => n.status === "queued" || n.status === "running");
    for (const n of nodes) {
      this.updateNode(runId, n.node_id, (current) => ({ ...current, status: "cancelled" }));
    }

    this.appendQueue(runId, {
      run_id: runId,
      event: "run_cancelled",
      node_id: run.root_node_id,
      timestamp: run.updated_at,
    });

    return run;
  }

  resumeRun(runId: string): RepoRLMRun {
    const run = this.getRun(runId);
    if (run.status === "running") return run;
    if (run.status === "completed") {
      throw new Error(`Run already completed: ${runId}`);
    }
    run.status = "running";
    run.updated_at = nowIso();
    run.completed_at = undefined;
    run.checkpoint.updated_at = run.updated_at;
    this.setRun(run);

    // Re-queue cancelled nodes that do not yet have results.
    const resultMap = this.getLatestResultMap(runId);
    const nodes = this.getLatestNodes(runId);
    for (const node of nodes) {
      if (node.status === "cancelled" && !resultMap.has(node.node_id)) {
        this.updateNode(runId, node.node_id, (current) => ({
          ...current,
          status: "queued",
        }));
        this.appendQueue(runId, {
          run_id: runId,
          event: "node_requeued",
          node_id: node.node_id,
          timestamp: nowIso(),
          details: { reason: "resume" },
        });
      }
    }

    this.appendQueue(runId, {
      run_id: runId,
      event: "run_resumed",
      node_id: run.root_node_id,
      timestamp: run.updated_at,
    });

    return run;
  }

  private getAllLatestResults(runId: string): RepoRLMResult[] {
    return Array.from(this.getLatestResultMap(runId).values());
  }

  private extractReviewFindings(runId: string): ReviewFinding[] {
    const results = this.getAllLatestResults(runId);
    const out: ReviewFinding[] = [];

    for (const r of results) {
      const findings = Array.isArray(r.findings) ? r.findings : [];
      for (const raw of findings) {
        const f = raw as any;
        const sev = ["critical", "high", "medium", "low", "info"].includes(String(f?.severity))
          ? (f.severity as FindingSeverity)
          : "info";
        const evidenceRaw = Array.isArray(f?.evidence) ? f.evidence : [];
        const evidence: FindingEvidence[] = evidenceRaw
          .map((e: any) => ({
            path: String(e?.path ?? ""),
            line_start: Number(e?.line_start ?? 1),
            line_end: Number(e?.line_end ?? Number(e?.line_start ?? 1)),
            quote: typeof e?.quote === "string" ? e.quote : undefined,
          }))
          .filter((e) => e.path.length > 0);
        if (evidence.length === 0) continue;

        out.push({
          id: String(f?.id ?? `${r.node_id}:${out.length + 1}`),
          domain: String(f?.domain ?? "quality"),
          severity: sev,
          confidence: typeof f?.confidence === "number" ? f.confidence : 0.5,
          title: String(f?.title ?? "Untitled finding"),
          description: String(f?.description ?? ""),
          suggested_fix: typeof f?.suggested_fix === "string" ? f.suggested_fix : undefined,
          evidence,
        });
      }
    }

    return out;
  }

  private dedupeAndRankFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const byKey = new Map<string, ReviewFinding>();

    for (const f of findings) {
      const e = f.evidence[0]!;
      const key = `${f.domain}|${f.title}|${e.path}|${e.line_start}|${e.line_end}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, f);
        continue;
      }

      const betterSeverity = severityRank(f.severity) > severityRank(existing.severity);
      const betterConfidence = f.confidence > existing.confidence;
      if (betterSeverity || (!betterSeverity && betterConfidence)) {
        byKey.set(key, f);
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const ds = severityRank(b.severity) - severityRank(a.severity);
      if (ds !== 0) return ds;
      return b.confidence - a.confidence;
    });
  }

  private clusterFindings(findings: ReviewFinding[]): FindingCluster[] {
    const byCluster = new Map<string, FindingCluster>();

    for (const f of findings) {
      const firstEvidence = f.evidence[0];
      const moduleHint = firstPathSegment(firstEvidence.path);
      const titleKey = normalizeTitle(f.title).split(" ").slice(0, 8).join(" ");
      const clusterKey = `${f.domain}|${moduleHint}|${titleKey}`;

      const existing = byCluster.get(clusterKey);
      if (!existing) {
        byCluster.set(clusterKey, {
          cluster_id: `cluster_${createHash("sha1").update(clusterKey).digest("hex").slice(0, 12)}`,
          title: f.title,
          domain: f.domain,
          severity: f.severity,
          confidence: f.confidence,
          finding_ids: [f.id],
          affected_paths: Array.from(new Set(f.evidence.map((e) => e.path))),
          count: 1,
        });
        continue;
      }

      existing.finding_ids.push(f.id);
      existing.count += 1;
      if (severityRank(f.severity) > severityRank(existing.severity)) existing.severity = f.severity;
      existing.confidence = Math.max(existing.confidence, f.confidence);
      const merged = new Set([...existing.affected_paths, ...f.evidence.map((e) => e.path)]);
      existing.affected_paths = Array.from(merged).sort();
    }

    return Array.from(byCluster.values()).sort((a, b) => {
      const ds = severityRank(b.severity) - severityRank(a.severity);
      if (ds !== 0) return ds;
      if (b.count !== a.count) return b.count - a.count;
      return b.confidence - a.confidence;
    });
  }

  private synthesizeWikiArtifacts(runId: string): Array<{ kind: string; path: string }> {
    const run = this.getRun(runId);
    const runDir = this.runDir(runId);
    const outDir = join(runDir, "artifacts", "wiki");
    mkdirSync(outDir, { recursive: true });

    const results = this.getAllLatestResults(runId);
    const nodeDocs = results
      .flatMap((r) => r.artifacts ?? [])
      .filter((a) => a.kind === "wiki_node")
      .map((a) => a.path);

    const uniqueNodeDocs = Array.from(new Set(nodeDocs)).sort();
    const objectiveTags = objectiveFocusTags(run.objective);

    const summarySnippets = results
      .map((r) => `- ${r.node_id}: ${r.summary}`)
      .slice(0, 30);

    const moduleCounts = new Map<string, number>();
    for (const p of uniqueNodeDocs) {
      const seg = firstPathSegment(p);
      moduleCounts.set(seg, (moduleCounts.get(seg) ?? 0) + 1);
    }

    const moduleIndexPath = join(outDir, "module-index.md");
    const moduleLines = [
      "# Module Index",
      "",
      ...(moduleCounts.size > 0
        ? Array.from(moduleCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => `- ${name}: ${count} node documents`)
        : ["- (none)"]),
    ];
    writeFileSync(moduleIndexPath, moduleLines.join("\n") + "\n", "utf-8");

    const architecturePath = join(outDir, "architecture-summary.md");
    const architectureLines = [
      "# Architecture Summary",
      "",
      `Run: ${runId}`,
      `Objective: ${run.objective}`,
      `Focus tags: ${objectiveTags.length ? objectiveTags.join(", ") : "(none)"}`,
      "",
      "## Recursive Coverage",
      "",
      `- Node documents: ${uniqueNodeDocs.length}`,
      `- Result nodes summarized: ${results.length}`,
      "",
      "## Summary Snippets",
      "",
      ...(summarySnippets.length ? summarySnippets : ["- (none)"]),
    ];
    writeFileSync(architecturePath, architectureLines.join("\n") + "\n", "utf-8");

    const indexPath = join(outDir, "index.md");
    const lines = [
      "# Repository Wiki",
      "",
      `Generated from run ${runId}.`,
      "",
      "## Overview",
      "",
      `- Objective: ${run.objective}`,
      `- Focus tags: ${objectiveTags.length ? objectiveTags.join(", ") : "(none)"}`,
      `- Architecture summary: [architecture-summary.md](architecture-summary.md)`,
      `- Module index: [module-index.md](module-index.md)`,
      "",
      "## Node Documents",
      "",
      ...(uniqueNodeDocs.length > 0
        ? uniqueNodeDocs.map((p) => {
            const rel = safeRelPath(outDir, join(runDir, p));
            return `- [${basename(p)}](${rel.replace(/\\/g, "/")})`;
          })
        : ["- (none)"]),
    ];
    writeFileSync(indexPath, lines.join("\n") + "\n", "utf-8");

    return [
      { kind: "wiki_index", path: join("artifacts", "wiki", "index.md") },
      { kind: "wiki_module_index", path: join("artifacts", "wiki", "module-index.md") },
      { kind: "wiki_architecture_summary", path: join("artifacts", "wiki", "architecture-summary.md") },
      ...uniqueNodeDocs.map((p) => ({ kind: "wiki_node", path: p })),
    ];
  }

  private synthesizeReviewArtifacts(runId: string): Array<{ kind: string; path: string }> {
    const run = this.getRun(runId);
    const runDir = this.runDir(runId);
    const outDir = join(runDir, "artifacts", "review");
    mkdirSync(outDir, { recursive: true });

    const rawFindings = this.extractReviewFindings(runId);
    const ranked = this.dedupeAndRankFindings(rawFindings);
    const clusters = this.clusterFindings(ranked);
    const objectiveTags = objectiveFocusTags(run.objective);

    const severityCounts: Record<FindingSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    ranked.forEach((f) => {
      severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
    });

    const riskScore = ranked.reduce((acc, f) => acc + severityRank(f.severity) * Math.max(0.2, Math.min(1, f.confidence)), 0);

    const rankedPath = join(outDir, "findings-ranked.json");
    writeJson(rankedPath, {
      run_id: runId,
      objective: run.objective,
      objective_tags: objectiveTags,
      raw_count: rawFindings.length,
      deduped_count: ranked.length,
      cluster_count: clusters.length,
      risk_score: Number(riskScore.toFixed(2)),
      severity_counts: severityCounts,
      findings: ranked,
    });

    const clustersPath = join(outDir, "findings-clusters.json");
    writeJson(clustersPath, {
      run_id: runId,
      clusters,
    });

    const summaryPath = join(outDir, "summary.json");
    writeJson(summaryPath, {
      run_id: runId,
      objective: run.objective,
      objective_tags: objectiveTags,
      raw_findings: rawFindings.length,
      deduped_findings: ranked.length,
      clusters: clusters.length,
      risk_score: Number(riskScore.toFixed(2)),
      severity_counts: severityCounts,
      top_hotspots: clusters.slice(0, 10).map((c) => ({
        cluster_id: c.cluster_id,
        title: c.title,
        domain: c.domain,
        severity: c.severity,
        count: c.count,
        affected_paths: c.affected_paths,
      })),
    });

    const reportPath = join(outDir, "report.md");
    const reportLines = [
      "# Review Report",
      "",
      `Run: ${runId}`,
      `Objective: ${run.objective}`,
      `Objective tags: ${objectiveTags.length ? objectiveTags.join(", ") : "(none)"}`,
      `Raw findings: ${rawFindings.length}`,
      `Deduped findings: ${ranked.length}`,
      `Clusters: ${clusters.length}`,
      `Risk score: ${riskScore.toFixed(2)}`,
      "",
      "## Severity Breakdown",
      "",
      `- Critical: ${severityCounts.critical}`,
      `- High: ${severityCounts.high}`,
      `- Medium: ${severityCounts.medium}`,
      `- Low: ${severityCounts.low}`,
      `- Info: ${severityCounts.info}`,
      "",
      "## Cluster Hotspots",
      "",
      ...(clusters.slice(0, 20).map((c, i) => {
        const paths = c.affected_paths.slice(0, 5).join(", ");
        return [
          `${i + 1}. **[${c.severity.toUpperCase()}]** ${c.title}`,
          `   - Domain: ${c.domain}`,
          `   - Findings: ${c.count}`,
          `   - Confidence: ${c.confidence.toFixed(2)}`,
          `   - Paths: ${paths || "(none)"}`,
        ].join("\n");
      }) ?? ["(none)"]),
      "",
      "## Top Findings",
      "",
      ...(ranked.slice(0, 50).map((f, i) => {
        const e = f.evidence[0];
        return [
          `${i + 1}. **[${f.severity.toUpperCase()}]** ${f.title}`,
          `   - Domain: ${f.domain}`,
          `   - Confidence: ${f.confidence.toFixed(2)}`,
          `   - Location: ${e.path}:${e.line_start}-${e.line_end}`,
          `   - Description: ${f.description}`,
          f.suggested_fix ? `   - Suggested fix: ${f.suggested_fix}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }) ?? ["(none)"]),
    ];
    writeFileSync(reportPath, reportLines.join("\n") + "\n", "utf-8");

    const codeQualityPath = join(outDir, "codequality.json");
    const codeQuality = ranked.map((f) => {
      const e = f.evidence[0];
      const fp = createHash("sha256").update(`${f.domain}|${f.title}|${e.path}|${e.line_start}|${e.line_end}`).digest("hex");
      return {
        description: f.description || f.title,
        check_name: `pi-rlm-${f.domain}`,
        fingerprint: fp,
        severity: mapSeverityToCodeClimate(f.severity),
        location: {
          path: e.path,
          lines: { begin: e.line_start },
        },
      };
    });
    writeJson(codeQualityPath, codeQuality);

    const sarifPath = join(outDir, "sarif.json");
    const rules = Array.from(
      new Map(
        ranked.map((f) => {
          const id = `${f.domain}:${normalizeTitle(f.title).replace(/\s+/g, "-")}`;
          return [id, { id, name: f.title, shortDescription: { text: f.title }, help: { text: f.description || f.title } }];
        }),
      ).values(),
    );
    const sarif = {
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "pi-rlm",
              rules,
            },
          },
          results: ranked.map((f) => {
            const e = f.evidence[0];
            const ruleId = `${f.domain}:${normalizeTitle(f.title).replace(/\s+/g, "-")}`;
            const level = severityRank(f.severity) >= 4 ? "error" : severityRank(f.severity) >= 3 ? "warning" : "note";
            return {
              ruleId,
              level,
              message: { text: f.description || f.title },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: e.path },
                    region: { startLine: e.line_start, endLine: e.line_end },
                  },
                },
              ],
            };
          }),
        },
      ],
    };
    writeJson(sarifPath, sarif);

    return [
      { kind: "review_ranked_findings", path: join("artifacts", "review", "findings-ranked.json") },
      { kind: "review_clusters", path: join("artifacts", "review", "findings-clusters.json") },
      { kind: "review_summary", path: join("artifacts", "review", "summary.json") },
      { kind: "review_report", path: join("artifacts", "review", "report.md") },
      { kind: "review_codequality", path: join("artifacts", "review", "codequality.json") },
      { kind: "review_sarif", path: join("artifacts", "review", "sarif.json") },
    ];
  }

  synthesizeRun(runId: string, target: "auto" | "wiki" | "review" | "all" = "auto"): {
    run: RepoRLMRun;
    artifacts: Array<{ kind: string; path: string }>;
  } {
    const run = this.getRun(runId);
    const artifactMap = new Map<string, { kind: string; path: string }>();

    const shouldWiki = target === "all" || target === "wiki" || (target === "auto" && run.mode === "wiki");
    const shouldReview = target === "all" || target === "review" || (target === "auto" && run.mode === "review");

    if (shouldWiki) {
      for (const a of this.synthesizeWikiArtifacts(runId)) {
        artifactMap.set(`${a.kind}|${a.path}`, a);
      }
    }

    if (shouldReview) {
      for (const a of this.synthesizeReviewArtifacts(runId)) {
        artifactMap.set(`${a.kind}|${a.path}`, a);
      }
    }

    for (const existing of run.output_index ?? []) {
      artifactMap.set(`${existing.kind}|${existing.path}`, existing);
    }

    run.output_index = Array.from(artifactMap.values()).sort((a, b) => a.path.localeCompare(b.path));
    run.updated_at = nowIso();
    this.setRun(run);

    return {
      run,
      artifacts: run.output_index,
    };
  }

  getRunRoot(runId: string): string {
    const run = this.getRun(runId);
    return this.runDir(run.run_id);
  }

  registerArtifacts(runId: string, artifacts: Array<{ kind: string; path: string }>): RepoRLMRun {
    const run = this.getRun(runId);
    const artifactMap = new Map<string, { kind: string; path: string }>();

    for (const existing of run.output_index ?? []) {
      artifactMap.set(`${existing.kind}|${existing.path}`, existing);
    }
    for (const a of artifacts) {
      artifactMap.set(`${a.kind}|${a.path}`, a);
    }

    run.output_index = Array.from(artifactMap.values()).sort((a, b) => a.path.localeCompare(b.path));
    run.updated_at = nowIso();
    this.setRun(run);
    return run;
  }

  exportRun(runId: string, format: "markdown" | "json"): { path: string } {
    const status = this.getStatus(runId);
    const artifactsDir = join(this.runDir(runId), "artifacts");

    if (format === "json") {
      const exportPath = join(artifactsDir, "export.json");
      writeJson(exportPath, {
        run: status.run,
        nodes: status.nodes,
        queue_events: status.queueEvents,
        result_count: status.resultCount,
        depth_histogram: status.depthHistogram,
        active_branch_preview: status.activeBranchPreview,
      });
      return { path: exportPath };
    }

    const mdPath = join(artifactsDir, "export.md");
    const depthText = Object.entries(status.depthHistogram)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([d, c]) => `d${d}:${c}`)
      .join(", ");

    const lines = [
      `# RLM Export ${status.run.run_id}`,
      "",
      `- Objective: ${status.run.objective}`,
      `- Mode: ${status.run.mode}`,
      `- Status: ${status.run.status}`,
      `- Nodes: ${status.run.progress.nodes_completed}/${status.run.progress.nodes_total} completed`,
      `- Failed nodes: ${status.run.progress.nodes_failed}`,
      `- Max depth seen: ${status.run.progress.max_depth_seen}`,
      `- Depth histogram: ${depthText || "(none)"}`,
      `- Queue events: ${status.queueEvents.length}`,
      `- Node results: ${status.resultCount}`,
      "",
      "## Active Branch Preview",
      "",
      ...status.activeBranchPreview.map(
        (n) => `- ${n.node_id} (depth=${n.depth}, status=${n.status}, decision=${n.decision})`,
      ),
      "",
      "## Artifacts",
      "",
      ...(status.run.output_index.length > 0
        ? status.run.output_index.map((a) => `- ${a.kind}: ${a.path}`)
        : ["- (none)"]),
      "",
      "## Notes",
      "",
      "Phase-3 scaffold adds synthesis outputs for wiki/review modes.",
      "Use repo_rlm_synthesize after scheduler completion for best results.",
    ];
    writeFileSync(mdPath, lines.join("\n") + "\n", "utf-8");
    return { path: mdPath };
  }
}

