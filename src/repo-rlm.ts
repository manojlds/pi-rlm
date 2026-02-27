import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { RepoRLMStore, type RepoRLMMode, type RepoRLMScheduler } from "./repo-rlm-core";

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
      const config = {
        max_depth: params.max_depth ?? 4,
        max_llm_calls: params.max_llm_calls ?? 300,
        max_tokens: params.max_tokens ?? 500_000,
        max_wall_clock_ms: params.max_wall_clock_ms ?? 30 * 60 * 1000,
        scheduler: (params.scheduler ?? "bfs") as RepoRLMScheduler,
      };

      const domain = mode === "review" ? "quality" : mode === "wiki" ? "architecture" : null;

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
              "Use repo_rlm_step or repo_rlm_run to execute recursion.",
          },
        ],
        details: run,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_step",
    label: "Repo RLM Step",
    description: "Execute bounded recursive scheduler steps for a run.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID" }),
      max_nodes: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 1 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const step = store.executeStep(params.run_id, params.max_nodes ?? 1);
      return {
        content: [
          {
            type: "text",
            text:
              `Stepped run ${step.run.run_id}\n` +
              `Status: ${step.run.status}\n` +
              `Processed nodes: ${step.processed_nodes}\n` +
              `Aggregated parents: ${step.aggregated_nodes}\n` +
              (step.notes.length ? `Notes: ${step.notes.slice(0, 6).join(" | ")}` : "Notes: (none)"),
          },
        ],
        details: step,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_run",
    label: "Repo RLM Run",
    description: "Run recursive scheduler until completion or node budget is exhausted.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID" }),
      max_nodes: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, default: 200 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const out = store.runUntil(params.run_id, params.max_nodes ?? 200);
      return {
        content: [
          {
            type: "text",
            text:
              `Run ${out.run.run_id}\n` +
              `Status: ${out.run.status}\n` +
              `Processed nodes: ${out.processed_nodes}\n` +
              `Aggregated parents: ${out.aggregated_nodes}\n` +
              `Progress: ${out.run.progress.nodes_completed}/${out.run.progress.nodes_total} completed`,
          },
        ],
        details: out,
      };
    },
  });

  pi.registerTool({
    name: "repo_rlm_synthesize",
    label: "Repo RLM Synthesize",
    description:
      "Synthesize higher-level artifacts from recursive node results (wiki index, ranked review findings, codequality, SARIF).",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID" }),
      target: Type.Optional(StringEnum(["auto", "wiki", "review", "all"] as const, { default: "auto" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new RepoRLMStore(ctx.cwd);
      const out = store.synthesizeRun(params.run_id, (params.target ?? "auto") as "auto" | "wiki" | "review" | "all");
      const artifactPreview = out.artifacts.slice(0, 12).map((a) => `${a.kind}:${a.path}`).join(" | ");
      return {
        content: [
          {
            type: "text",
            text:
              `Synthesized run ${out.run.run_id} (${params.target ?? "auto"})\n` +
              `Artifacts: ${out.artifacts.length}\n` +
              `Preview: ${artifactPreview || "(none)"}`,
          },
        ],
        details: out,
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
      const depthHistogramText = Object.entries(status.depthHistogram)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([d, c]) => `d${d}:${c}`)
        .join(", ");

      const previewText = status.activeBranchPreview
        .map((n) => `${n.node_id}@d${n.depth}:${n.status}/${n.decision}`)
        .join(" | ");

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
              `Depth histogram: ${depthHistogramText || "(none)"}\n` +
              `Queue events: ${status.queueEvents.length}\n` +
              `Node results: ${status.resultCount}\n` +
              `Active branch preview: ${previewText || "(none)"}`,
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
