import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeWithBackend } from "./backends";
import { plannerPrompt, solverPrompt, synthesisPrompt } from "./prompts";
import { PlannerDecision, RlmNode, RlmRunResult, RunArtifacts, StartRunInput } from "./types";
import { extractFirstJsonObject, normalizeTask, shortTask, toErrorMessage } from "./utils";

interface EngineInput extends StartRunInput {
  runId: string;
}

interface EngineState {
  nodeCounter: number;
  nodesVisited: number;
  maxDepthSeen: number;
}

type ProgressFn = (line: string) => void;

export async function runRlmEngine(
  input: EngineInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  progress?: ProgressFn
): Promise<RlmRunResult> {
  const startedAt = Date.now();
  const artifacts = await createArtifacts(input.runId);
  const log = createEventLogger(artifacts.eventsPath);
  const state: EngineState = {
    nodeCounter: 0,
    nodesVisited: 0,
    maxDepthSeen: 0
  };
  const activeSignal = signal ?? new AbortController().signal;

  progress?.(`RLM run ${input.runId} started (${input.backend}, mode=${input.mode})`);
  log("run_start", {
    runId: input.runId,
    backend: input.backend,
    mode: input.mode,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    maxBranching: input.maxBranching,
    concurrency: input.concurrency
  });

  try {
    const root = await runNode({ task: input.task, depth: 0, lineage: [], parentId: undefined });

    const finalOutput = root.result ?? "(no final output)";

    await fs.writeFile(artifacts.treePath, JSON.stringify(root, null, 2), "utf8");
    await fs.writeFile(artifacts.outputPath, finalOutput, "utf8");

    const durationMs = Date.now() - startedAt;
    const result: RlmRunResult = {
      runId: input.runId,
      backend: input.backend,
      final: finalOutput,
      root,
      artifacts,
      stats: {
        nodesVisited: state.nodesVisited,
        maxDepthSeen: state.maxDepthSeen,
        durationMs
      }
    };

    log("run_end", {
      runId: input.runId,
      durationMs,
      nodesVisited: state.nodesVisited,
      maxDepthSeen: state.maxDepthSeen,
      finalChars: finalOutput.length
    });

    if (root.status === "failed") {
      throw new Error(root.error ?? "RLM root node failed");
    }

    progress?.(`RLM run ${input.runId} completed in ${durationMs}ms`);
    return result;
  } finally {
    await log.flush();
  }

  async function runNode(params: {
    task: string;
    depth: number;
    lineage: string[];
    parentId: string | undefined;
  }): Promise<RlmNode> {
    if (state.nodesVisited >= input.maxNodes) {
      const startedAt = Date.now();
      const skippedNode: RlmNode = {
        id: `n${++state.nodeCounter}`,
        depth: params.depth,
        task: params.task,
        status: "cancelled",
        startedAt,
        finishedAt: startedAt,
        error: "maxNodes reached",
        result: "Node skipped: maxNodes reached",
        children: []
      };

      progress?.(
        `[${skippedNode.id}] skipped (maxNodes reached) ${shortTask(params.task, 72)}`
      );
      log("node_skipped", {
        nodeId: skippedNode.id,
        parentId: params.parentId ?? null,
        depth: skippedNode.depth,
        task: skippedNode.task,
        reason: "maxNodes reached",
        nodesVisited: state.nodesVisited
      });
      return skippedNode;
    }

    const nodeId = `n${++state.nodeCounter}`;
    state.nodesVisited += 1;
    state.maxDepthSeen = Math.max(state.maxDepthSeen, params.depth);

    const node: RlmNode = {
      id: nodeId,
      depth: params.depth,
      task: params.task,
      status: "running",
      startedAt: Date.now(),
      children: []
    };

    progress?.(`[${node.id}] depth=${params.depth} ${shortTask(params.task, 72)}`);
    log("node_start", {
      nodeId: node.id,
      parentId: params.parentId ?? null,
      depth: params.depth,
      task: params.task,
      nodesVisited: state.nodesVisited
    });

    if (activeSignal.aborted) {
      node.status = "cancelled";
      node.error = "Run cancelled";
      node.finishedAt = Date.now();
      log("node_cancelled", {
        nodeId: node.id,
        parentId: params.parentId ?? null,
        depth: node.depth
      });
      throw new Error("RLM run cancelled");
    }

    const normalized = normalizeTask(params.task);
    const remainingNodeBudget = Math.max(0, input.maxNodes - state.nodesVisited);

    try {
      const forcedReason = getForcedSolveReason({
        depth: params.depth,
        normalizedTask: normalized,
        lineage: params.lineage,
        remainingNodeBudget
      });

      if (forcedReason || input.mode === "solve") {
        const reason = forcedReason ?? "mode=solve";
        node.decision = { action: "solve", reason };
        node.result = await solveNode(node, reason);
        node.status = "completed";
        node.finishedAt = Date.now();
        log("node_end", {
          nodeId: node.id,
          parentId: params.parentId ?? null,
          action: "solve",
          reason,
          chars: node.result.length,
          durationMs: node.finishedAt - node.startedAt
        });
        return node;
      }

      const decision = await planNode({
        task: params.task,
        nodeId: node.id,
        depth: params.depth,
        maxDepth: input.maxDepth,
        maxBranching: input.maxBranching,
        remainingNodeBudget
      });

      node.decision = {
        action: decision.action,
        reason: decision.reason
      };

      if (decision.action === "solve") {
        node.result = await solveNode(node, decision.reason);
        node.status = "completed";
        node.finishedAt = Date.now();
        log("node_end", {
          nodeId: node.id,
          parentId: params.parentId ?? null,
          action: "solve",
          reason: decision.reason,
          chars: node.result.length,
          durationMs: node.finishedAt - node.startedAt
        });
        return node;
      }

      const requestedSubtasks = sanitizeSubtasks(decision.subtasks ?? [], params.task).slice(
        0,
        input.maxBranching
      );
      const remainingChildBudget = Math.max(0, input.maxNodes - state.nodesVisited);
      const subtasks = requestedSubtasks.slice(0, remainingChildBudget);

      if (subtasks.length < 2) {
        const fallbackReason =
          requestedSubtasks.length < 2
            ? "planner returned insufficient valid subtasks"
            : "insufficient remaining node budget for decomposition";

        if (input.mode === "decompose") {
          throw new Error(`mode=decompose requires valid decomposition: ${fallbackReason}`);
        }

        node.decision = {
          action: "solve",
          reason: fallbackReason
        };
        node.result = await solveNode(node, node.decision.reason);
        node.status = "completed";
        node.finishedAt = Date.now();
        log("node_end", {
          nodeId: node.id,
          parentId: params.parentId ?? null,
          action: "solve",
          reason: node.decision.reason,
          chars: node.result.length,
          durationMs: node.finishedAt - node.startedAt
        });
        return node;
      }

      progress?.(`[${node.id}] decomposing into ${subtasks.length} subtasks`);
      log("node_decompose", {
        nodeId: node.id,
        parentId: params.parentId ?? null,
        subtasks,
        reason: decision.reason
      });

      node.children = await mapConcurrent(subtasks, input.concurrency, async (subtask) => {
        return runNode({
          task: subtask,
          depth: params.depth + 1,
          lineage: [...params.lineage, normalized],
          parentId: node.id
        });
      });

      node.result = await synthesizeNode(node);
      node.status = "completed";
      node.finishedAt = Date.now();
      log("node_end", {
        nodeId: node.id,
        parentId: params.parentId ?? null,
        action: "decompose",
        chars: node.result.length,
        children: node.children.length,
        durationMs: node.finishedAt - node.startedAt
      });
      return node;
    } catch (error) {
      const message = toErrorMessage(error);
      if (activeSignal.aborted || message.toLowerCase().includes("cancel")) {
        node.status = "cancelled";
        node.error = message;
        node.finishedAt = Date.now();
        log("node_cancelled", {
          nodeId: node.id,
          parentId: params.parentId ?? null,
          error: message,
          durationMs: node.finishedAt - node.startedAt
        });
        throw error;
      }

      node.status = "failed";
      node.error = message;
      node.finishedAt = Date.now();
      log("node_error", {
        nodeId: node.id,
        parentId: params.parentId ?? null,
        error: message,
        durationMs: node.finishedAt - node.startedAt
      });

      node.result = `Node failed: ${message}`;
      return node;
    }
  }

  async function planNode(args: {
    task: string;
    nodeId: string;
    depth: number;
    maxDepth: number;
    maxBranching: number;
    remainingNodeBudget: number;
  }): Promise<PlannerDecision> {
    if (input.mode === "decompose") {
      const forced = await callModel("planner", plannerPrompt(args), args.nodeId, args.depth);
      const parsedForced = parsePlannerDecision(forced);
      if (parsedForced.action === "decompose") {
        return parsedForced;
      }

      throw new Error(
        `mode=decompose requires planner action=decompose; got ${parsedForced.action} (${parsedForced.reason})`
      );
    }

    const raw = await callModel("planner", plannerPrompt(args), args.nodeId, args.depth);
    return parsePlannerDecision(raw);
  }

  async function solveNode(node: RlmNode, forceReason: string): Promise<string> {
    const prompt = solverPrompt({
      task: node.task,
      depth: node.depth,
      maxDepth: input.maxDepth,
      forceReason
    });
    return callModel("solver", prompt, node.id, node.depth);
  }

  async function synthesizeNode(node: RlmNode): Promise<string> {
    const prompt = synthesisPrompt({
      task: node.task,
      depth: node.depth,
      children: node.children
    });
    return callModel("synthesizer", prompt, node.id, node.depth);
  }

  async function callModel(
    stage: string,
    promptText: string,
    nodeId?: string,
    depth?: number
  ): Promise<string> {
    if (activeSignal.aborted) {
      throw new Error("RLM run cancelled");
    }

    log("backend_call", {
      nodeId,
      stage,
      backend: input.backend,
      model: input.model,
      promptChars: promptText.length
    });

    const output = await completeWithBackend(
      {
        backend: input.backend,
        prompt: promptText,
        cwd: input.cwd,
        model: input.model,
        toolsProfile: input.toolsProfile,
        timeoutMs: input.timeoutMs,
        signal: activeSignal,
        runId: input.runId,
        nodeId,
        depth,
        stage,
        tmuxUseCurrentSession: input.tmuxUseCurrentSession
      },
      ctx
    );

    log("backend_result", {
      nodeId,
      stage,
      outputChars: output.length
    });

    return output;
  }

  function getForcedSolveReason(args: {
    depth: number;
    normalizedTask: string;
    lineage: string[];
    remainingNodeBudget: number;
  }): string | undefined {
    if (args.depth >= input.maxDepth) {
      return "maxDepth reached";
    }

    if (state.nodesVisited >= input.maxNodes) {
      return "maxNodes reached";
    }

    if (args.remainingNodeBudget < 2) {
      return "insufficient node budget for decomposition";
    }

    if (args.lineage.includes(args.normalizedTask)) {
      return "cycle detected in task lineage";
    }

    return undefined;
  }

}

function parsePlannerDecision(raw: string): PlannerDecision {
  const jsonCandidate = extractFirstJsonObject(raw);
  if (!jsonCandidate) {
    return {
      action: "solve",
      reason: "planner JSON parse failed"
    };
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      action?: unknown;
      reason?: unknown;
      subtasks?: unknown;
    };

    const action = parsed.action === "decompose" ? "decompose" : "solve";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "planner did not provide reason";
    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks.filter((item): item is string => typeof item === "string")
      : undefined;

    return { action, reason, subtasks };
  } catch {
    return {
      action: "solve",
      reason: "planner JSON was invalid"
    };
  }
}

function sanitizeSubtasks(subtasks: string[], parentTask: string): string[] {
  const parentNormalized = normalizeTask(parentTask);
  const deduped = new Set<string>();
  const cleaned: string[] = [];

  for (const subtask of subtasks) {
    const value = subtask.trim();
    if (!value) continue;

    const normalized = normalizeTask(value);
    if (!normalized || normalized === parentNormalized) continue;
    if (deduped.has(normalized)) continue;

    deduped.add(normalized);
    cleaned.push(value);
  }

  return cleaned;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, concurrency);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const current = nextIndex;
        nextIndex += 1;
        results[current] = await worker(items[current], current);
      }
    })
  );

  return results;
}

async function createArtifacts(runId: string): Promise<RunArtifacts> {
  const dir = join(tmpdir(), "pi-rlm-runs", runId);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    eventsPath: join(dir, "events.jsonl"),
    treePath: join(dir, "tree.json"),
    outputPath: join(dir, "output.md")
  };
}

function createEventLogger(path: string): {
  (type: string, payload: Record<string, unknown>): void;
  flush: () => Promise<void>;
} {
  let tail = Promise.resolve();

  const write = (type: string, payload: Record<string, unknown>): void => {
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...payload
    })}\n`;

    tail = tail
      .then(() => fs.appendFile(path, line, "utf8"))
      .catch(() => undefined);
  };

  write.flush = async (): Promise<void> => {
    await tail;
  };

  return write;
}
