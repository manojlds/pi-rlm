import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete, StringEnum, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { RepoRLMStore, type RepoRLMMode, type RepoRLMScheduler } from "./repo-rlm-core";

async function resolveModel(ctx: ExtensionContext, modelId?: string): Promise<any> {
  if (!modelId) return ctx.model;

  const registryAny = ctx.modelRegistry as any;
  let resolved =
    registryAny?.getModelById?.(modelId) ??
    registryAny?.getModel?.(modelId) ??
    registryAny?.models?.find?.((m: any) => m?.id === modelId);

  if (resolved && typeof resolved.then === "function") {
    resolved = await resolved;
  }

  return resolved ?? ctx.model;
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function readIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[truncated]";
}

async function runSemanticSynthesis(
  params: {
    runId: string;
    target: "auto" | "wiki" | "review" | "all";
    semanticModel?: string;
  },
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<Array<{ kind: string; path: string }>> {
  const store = new RepoRLMStore(ctx.cwd);
  const run = store.getRun(params.runId);
  const runRoot = store.getRunRoot(params.runId);

  const shouldWiki = params.target === "all" || params.target === "wiki" || (params.target === "auto" && run.mode === "wiki");
  const shouldReview =
    params.target === "all" || params.target === "review" || (params.target === "auto" && run.mode === "review");

  const model = await resolveModel(ctx, params.semanticModel);
  if (!model) throw new Error("No model configured for semantic synthesis");
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) throw new Error(`No API key for semantic synthesis model: ${model.id}`);

  const artifacts: Array<{ kind: string; path: string }> = [];

  if (shouldReview) {
    const reviewDir = join(runRoot, "artifacts", "review");
    mkdirSync(reviewDir, { recursive: true });

    const summaryJson = truncate(readIfExists(join(reviewDir, "summary.json")), 30_000);
    const clustersJson = truncate(readIfExists(join(reviewDir, "findings-clusters.json")), 35_000);
    const reportMd = truncate(readIfExists(join(reviewDir, "report.md")), 20_000);

    const reviewPrompt = [
      "You are a senior staff engineer creating an executive code review narrative.",
      "Using the deterministic review artifacts below, produce:",
      "1) an executive summary",
      "2) top systemic risks",
      "3) prioritized remediation plan (P0/P1/P2)",
      "4) rollout and validation checklist",
      "Keep claims grounded in provided artifacts. Do not fabricate file paths.",
      "",
      "<summary_json>",
      summaryJson || "{}",
      "</summary_json>",
      "",
      "<clusters_json>",
      clustersJson || "{}",
      "</clusters_json>",
      "",
      "<report_md>",
      reportMd || "",
      "</report_md>",
    ].join("\n");

    const reviewMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: reviewPrompt }],
        timestamp: Date.now(),
      },
    ];

    const reviewResp = await complete(model, { messages: reviewMessages }, { apiKey, signal });
    const reviewText = extractText(reviewResp as any);
    const reviewSemanticPath = join(reviewDir, "report.semantic.md");
    writeFileSync(reviewSemanticPath, (reviewText || "(empty semantic review output)") + "\n", "utf-8");
    artifacts.push({ kind: "review_report_semantic", path: join("artifacts", "review", "report.semantic.md") });
  }

  if (shouldWiki) {
    const wikiDir = join(runRoot, "artifacts", "wiki");
    mkdirSync(wikiDir, { recursive: true });

    const architectureSummary = truncate(readIfExists(join(wikiDir, "architecture-summary.md")), 25_000);
    const moduleIndex = truncate(readIfExists(join(wikiDir, "module-index.md")), 20_000);
    const wikiIndex = truncate(readIfExists(join(wikiDir, "index.md")), 20_000);

    const wikiPrompt = [
      "You are a principal architect creating a semantic architecture briefing.",
      "Generate a concise architecture narrative with:",
      "- system boundaries",
      "- module responsibilities",
      "- key coupling risks",
      "- modernization opportunities",
      "Base only on provided artifact content.",
      "",
      "<architecture_summary>",
      architectureSummary || "",
      "</architecture_summary>",
      "",
      "<module_index>",
      moduleIndex || "",
      "</module_index>",
      "",
      "<wiki_index>",
      wikiIndex || "",
      "</wiki_index>",
    ].join("\n");

    const wikiMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: wikiPrompt }],
        timestamp: Date.now(),
      },
    ];

    const wikiResp = await complete(model, { messages: wikiMessages }, { apiKey, signal });
    const wikiText = extractText(wikiResp as any);
    const wikiSemanticPath = join(wikiDir, "architecture.semantic.md");
    writeFileSync(wikiSemanticPath, (wikiText || "(empty semantic wiki output)") + "\n", "utf-8");
    artifacts.push({ kind: "wiki_architecture_semantic", path: join("artifacts", "wiki", "architecture.semantic.md") });
  }

  if (artifacts.length > 0) {
    store.registerArtifacts(params.runId, artifacts);
  }

  return artifacts;
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
      "Synthesize higher-level artifacts from recursive node results (wiki index, ranked review findings, codequality, SARIF). Optionally run semantic LLM-assisted synthesis.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run ID" }),
      target: Type.Optional(StringEnum(["auto", "wiki", "review", "all"] as const, { default: "auto" })),
      semantic: Type.Optional(Type.Boolean({ description: "Run optional semantic (LLM-assisted) synthesis", default: false })),
      semantic_model: Type.Optional(
        Type.String({ description: "Optional model id for semantic synthesis (defaults to current model)" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = (params.target ?? "auto") as "auto" | "wiki" | "review" | "all";
      const store = new RepoRLMStore(ctx.cwd);
      const out = store.synthesizeRun(params.run_id, target);

      const semanticArtifacts =
        params.semantic === true
          ? await runSemanticSynthesis(
              {
                runId: params.run_id,
                target,
                semanticModel: params.semantic_model,
              },
              ctx,
              signal,
            )
          : [];

      const refreshed = store.getRun(params.run_id);
      const allArtifacts = refreshed.output_index ?? out.artifacts;
      const artifactPreview = allArtifacts.slice(0, 12).map((a) => `${a.kind}:${a.path}`).join(" | ");

      return {
        content: [
          {
            type: "text",
            text:
              `Synthesized run ${refreshed.run_id} (${target})\n` +
              `Artifacts: ${allArtifacts.length}\n` +
              `Semantic artifacts: ${semanticArtifacts.length}\n` +
              `Preview: ${artifactPreview || "(none)"}`,
          },
        ],
        details: {
          run: refreshed,
          artifacts: allArtifacts,
          semanticArtifacts,
        },
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
