import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runRlmEngine } from "./src/engine";
import { rlmToolParamsSchema, type RlmToolParams } from "./src/schema";
import { RunStore } from "./src/runs";
import type { RunRecord, StartRunInput } from "./src/types";
import { truncateText } from "./src/utils";

const defaultWaitTimeoutMs = 120000;
const defaultNodeTimeoutMs = 180000;

export default function extension(pi: ExtensionAPI): void {
  const runs = new RunStore();

  pi.registerTool({
    name: "rlm",
    label: "RLM",
    description:
      "Recursive Language Model orchestration with depth-limited decomposition. Supports start/status/wait/cancel and sdk/cli/tmux backends.",
    parameters: rlmToolParamsSchema,
    async execute(_toolCallId, params: RlmToolParams, signal, onUpdate, ctx) {
      const op = params.op ?? "start";

      if (op === "start") {
        if (!params.task || !params.task.trim()) {
          throw new Error("'task' is required for op=start");
        }

        const input = resolveStartInput(params, ctx.cwd);
        const progress = (line: string): void => {
          onUpdate?.({
            content: [{ type: "text", text: line }],
            details: {}
          });
        };

        const record = runs.start(
          input,
          (runId, runSignal) => runRlmEngine({ ...input, runId }, ctx, runSignal, progress),
          signal
        );

        if (input.async) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `RLM run started in background.`,
                  `run_id: ${record.id}`,
                  `backend: ${input.backend}`,
                  `mode: ${input.mode}`,
                  `depth<=${input.maxDepth} nodes<=${input.maxNodes}`
                ].join("\n")
              }
            ],
            details: toRunDetails(record)
          };
        }

        const result = await record.promise;
        const summary = truncateText(result.final, 60000);

        const lines = [
          `RLM run completed.`,
          `run_id: ${result.runId}`,
          `backend: ${result.backend}`,
          `stats: nodes=${result.stats.nodesVisited}, maxDepthSeen=${result.stats.maxDepthSeen}, durationMs=${result.stats.durationMs}`,
          `artifacts: ${result.artifacts.dir}`,
          "",
          summary.text
        ];

        if (summary.truncated) {
          lines.push("", `Full output saved to: ${result.artifacts.outputPath}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            ...toRunDetails(record),
            result
          }
        };
      }

      if (op === "status") {
        if (params.id) {
          const record = runs.get(params.id);
          if (!record) {
            throw new Error(`Unknown run id: ${params.id}`);
          }

          return {
            content: [{ type: "text", text: describeRecord(record) }],
            details: toRunDetails(record)
          };
        }

        const list = runs.list();
        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No RLM runs found." }],
            details: { runs: [] }
          };
        }

        const lines = ["Recent RLM runs:", ...list.slice(0, 20).map(formatRunLine)];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { runs: list.map(toRunDetails) }
        };
      }

      if (!params.id) {
        throw new Error(`'id' is required for op=${op}`);
      }

      if (op === "wait") {
        const waitTimeoutMs = params.waitTimeoutMs ?? defaultWaitTimeoutMs;
        const { record, done } = await runs.wait(params.id, waitTimeoutMs);

        if (!done) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `Run ${record.id} is still running.`,
                  `status: ${record.status}`,
                  `wait timeout reached after ${waitTimeoutMs}ms`
                ].join("\n")
              }
            ],
            details: {
              ...toRunDetails(record),
              done: false,
              wait_status: "timeout"
            }
          };
        }

        if (record.status === "completed" && record.result) {
          const summary = truncateText(record.result.final, 60000);
          const text = [
            `Run ${record.id} completed.`,
            `artifacts: ${record.result.artifacts.dir}`,
            "",
            summary.text,
            summary.truncated ? `\nFull output: ${record.result.artifacts.outputPath}` : ""
          ]
            .filter(Boolean)
            .join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              ...toRunDetails(record),
              done: true,
              wait_status: "completed"
            }
          };
        }

        return {
          content: [{ type: "text", text: describeRecord(record) }],
          details: {
            ...toRunDetails(record),
            done: true,
            wait_status: record.status
          }
        };
      }

      if (op === "cancel") {
        const record = runs.cancel(params.id);
        return {
          content: [
            {
              type: "text",
              text: `Cancellation requested for run ${record.id}. Current status: ${record.status}`
            }
          ],
          details: {
            ...toRunDetails(record),
            cancel_applied: record.status === "running"
          }
        };
      }

      throw new Error(`Unsupported op: ${op}`);
    }
  });
}

function resolveStartInput(params: RlmToolParams, cwd: string): StartRunInput {
  return {
    task: params.task ?? "",
    backend: params.backend ?? "sdk",
    mode: params.mode ?? "auto",
    async: params.async ?? false,
    model: params.model,
    cwd: params.cwd ?? cwd,
    toolsProfile: params.toolsProfile ?? "coding",
    maxDepth: params.maxDepth ?? 2,
    maxNodes: params.maxNodes ?? 24,
    maxBranching: params.maxBranching ?? 3,
    concurrency: params.concurrency ?? 2,
    timeoutMs: params.timeoutMs ?? defaultNodeTimeoutMs
  };
}

function formatRunLine(record: RunRecord): string {
  const elapsed = (record.finishedAt ?? Date.now()) - record.startedAt;
  return `- ${record.id} | ${record.status} | ${record.input.backend} | ${elapsed}ms | task=${shorten(
    record.input.task,
    48
  )}`;
}

function describeRecord(record: RunRecord): string {
  const lines = [
    `run_id: ${record.id}`,
    `status: ${record.status}`,
    `backend: ${record.input.backend}`,
    `mode: ${record.input.mode}`,
    `task: ${record.input.task}`,
    `started_at: ${new Date(record.startedAt).toISOString()}`
  ];

  if (record.finishedAt) {
    lines.push(`finished_at: ${new Date(record.finishedAt).toISOString()}`);
    lines.push(`duration_ms: ${record.finishedAt - record.startedAt}`);
  }

  if (record.error) {
    lines.push(`error: ${record.error}`);
  }

  if (record.result) {
    lines.push(`artifacts: ${record.result.artifacts.dir}`);
  }

  return lines.join("\n");
}

function toRunDetails(record: RunRecord): Record<string, unknown> {
  return {
    contract_version: "rlm.v1",
    run_id: record.id,
    status: record.status,
    input: record.input,
    created_at: record.createdAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    error: record.error
  };
}

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}
