import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export type RepoRLMMode = "generic" | "wiki" | "review";
export type RepoRLMScheduler = "bfs" | "dfs" | "hybrid";

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
  scope_type: "repo" | "dir" | "module" | "file_group" | "file_slice";
  scope_ref: {
    paths: string[];
  };
  objective: string;
  domain: "security" | "quality" | "performance" | "docs" | "architecture" | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  decision: "undecided" | "leaf" | "split";
  child_ids: string[];
  confidence: number | null;
  budgets: {
    max_depth: number;
    remaining_llm_calls: number;
    remaining_tokens: number;
    deadline_epoch_ms: number;
  };
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

class RepoRLMStore {
  private baseDir: string;

  constructor(cwd: string) {
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

    const queueEvent: QueueEvent = {
      run_id: runId,
      event: "node_enqueued",
      node_id: rootNodeId,
      timestamp: createdAt,
      details: { reason: "phase-1-bootstrap" },
    };

    writeJson(this.runJsonPath(runId), run);
    appendJsonl(this.nodesPath(runId), rootNode);
    appendJsonl(this.queuePath(runId), queueEvent);

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

  getLatestNodes(runId: string): RepoRLMNode[] {
    const events = readJsonl<RepoRLMNode>(this.nodesPath(runId));
    const latest = new Map<string, RepoRLMNode>();
    for (const ev of events) latest.set(ev.node_id, ev);
    return Array.from(latest.values());
  }

  getStatus(runId: string): {
    run: RepoRLMRun;
    nodes: RepoRLMNode[];
    queueEvents: QueueEvent[];
    resultCount: number;
  } {
    const run = this.getRun(runId);
    const nodes = this.getLatestNodes(runId);
    const queueEvents = readJsonl<QueueEvent>(this.queuePath(runId));
    const results = readJsonl<RepoRLMResult>(this.resultsPath(runId));

    const nodesCompleted = nodes.filter((n) => n.status === "completed").length;
    const nodesFailed = nodes.filter((n) => n.status === "failed").length;
    const activeNodes = nodes.filter((n) => n.status === "running").length;
    const maxDepthSeen = nodes.reduce((m, n) => Math.max(m, n.depth), 0);

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

    appendJsonl(this.queuePath(runId), {
      run_id: runId,
      event: "run_cancelled",
      node_id: run.root_node_id,
      timestamp: run.updated_at,
    } satisfies QueueEvent);

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
    run.checkpoint.updated_at = run.updated_at;
    this.setRun(run);

    appendJsonl(this.queuePath(runId), {
      run_id: runId,
      event: "run_resumed",
      node_id: run.root_node_id,
      timestamp: run.updated_at,
    } satisfies QueueEvent);

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
      });
      return { path: exportPath };
    }

    const mdPath = join(artifactsDir, "export.md");
    const lines = [
      `# RLM Export ${status.run.run_id}`,
      "",
      `- Objective: ${status.run.objective}`,
      `- Mode: ${status.run.mode}`,
      `- Status: ${status.run.status}`,
      `- Nodes: ${status.run.progress.nodes_completed}/${status.run.progress.nodes_total} completed`,
      `- Failed nodes: ${status.run.progress.nodes_failed}`,
      `- Max depth seen: ${status.run.progress.max_depth_seen}`,
      `- Queue events: ${status.queueEvents.length}`,
      `- Node results: ${status.resultCount}`,
      "",
      "## Notes",
      "",
      "Phase-1 scaffold export. Recursive scheduler and aggregation are not wired yet.",
      "Use this artifact to inspect run topology and bootstrap state.",
    ];
    writeFileSync(mdPath, lines.join("\n") + "\n", "utf-8");
    return { path: mdPath };
  }
}

export function registerRepoRLMTools(pi: ExtensionAPI): void {
  const ModeSchema = StringEnum(["generic", "wiki", "review"] as const, {
    description: "RLM objective preset mode",
    default: "generic",
  });

  const SchedulerSchema = StringEnum(["bfs", "dfs", "hybrid"] as const, {
    description: "Traversal strategy for recursive expansion",
    default: "bfs",
  });

  pi.registerTool({
    name: "repo_rlm_start",
    label: "Repo RLM Start",
    description:
      "Start an RLM-first recursive run and persist bootstrap state under .pi/rlm/runs/<run-id>/.",
    parameters: Type.Object({
      objective: Type.String({ description: "Top-level objective for this recursive run" }),
      mode: Type.Optional(ModeSchema),
      max_depth: Type.Optional(Type.Number({ minimum: 0, maximum: 12 })),
      max_llm_calls: Type.Optional(Type.Number({ minimum: 1, maximum: 10000 })),
      max_tokens: Type.Optional(Type.Number({ minimum: 1024, maximum: 10_000_000 })),
      max_wall_clock_ms: Type.Optional(Type.Number({ minimum: 1_000, maximum: 86_400_000 })),
      scheduler: Type.Optional(SchedulerSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = (params.mode ?? "generic") as RepoRLMMode;
      const config: RepoRLMRunConfig = {
        max_depth: params.max_depth ?? 4,
        max_llm_calls: params.max_llm_calls ?? 300,
        max_tokens: params.max_tokens ?? 500_000,
        max_wall_clock_ms: params.max_wall_clock_ms ?? 30 * 60 * 1000,
        scheduler: (params.scheduler ?? "bfs") as RepoRLMScheduler,
      };

      const domain: RepoRLMNode["domain"] =
        mode === "review" ? "quality" : mode === "wiki" ? "architecture" : null;

      const store = new RepoRLMStore(ctx.cwd);
      const run = store.startRun({
        objective: params.objective,
        mode,
        config,
        domain,
        rootScopePaths: [ctx.cwd],
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Started run ${run.run_id} (${run.mode})\n` +
              `Objective: ${run.objective}\n` +
              `Root node: ${run.root_node_id}\n` +
              `Persisted at: .pi/rlm/runs/${run.run_id}/\n` +
              `\nPhase-1 scaffold: run bootstrapped; recursive scheduler wiring pending.`,
          },
        ],
        details: run,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_status",
    label: "Repo RLM Status",
    description: "Get current status/progress of an RLM run.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID returned by repo_rlm_start" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const status = store.getStatus(params.run_id);
      return {
        content: [
          {
            type: "text",
            text:
              `Run ${status.run.run_id}\n` +
              `Status: ${status.run.status}\n` +
              `Mode: ${status.run.mode}\n` +
              `Objective: ${status.run.objective}\n` +
              `Nodes: ${status.run.progress.nodes_completed}/${status.run.progress.nodes_total} completed, ` +
              `${status.run.progress.nodes_failed} failed, ${status.run.progress.active_nodes} active\n` +
              `Max depth: ${status.run.progress.max_depth_seen}\n` +
              `Queue events: ${status.queueEvents.length}\n` +
              `Node results: ${status.resultCount}`,
          },
        ],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_cancel",
    label: "Repo RLM Cancel",
    description: "Cancel a running RLM run.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID to cancel" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const run = store.cancelRun(params.run_id);
      return {
        content: [{ type: "text", text: `Cancelled run ${run.run_id}` }],
        details: run,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_resume",
    label: "Repo RLM Resume",
    description: "Resume a paused/cancelled/failed run.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID to resume" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const run = store.resumeRun(params.run_id);
      return {
        content: [{ type: "text", text: `Run ${run.run_id} is now ${run.status}` }],
        details: run,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_export",
    label: "Repo RLM Export",
    description: "Export run status/topology artifacts to markdown or json.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID to export" }),
      format: Type.Optional(StringEnum(["markdown", "json"] as const, { default: "markdown" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const format = (params.format ?? "markdown") as "markdown" | "json";
      const exported = store.exportRun(params.run_id, format);
      return {
        content: [
          {
            type: "text",
            text: `Exported run ${params.run_id} to ${exported.path}`,
          },
        ],
        details: exported,
      };
    },
  });
}
