import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { RLMEngine, type RLMConfig, type RLMTrajectoryStep, type RLMCallTree, type RLMSubCall, formatCallTreeVisualization, formatLiveStatus } from "./rlm-engine";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "rlm",
    label: "RLM",
    description: `Recursive Language Model — process large contexts that exceed effective LLM limits.
Instead of feeding a huge context directly into the prompt (which causes "context rot"),
RLM gives you an isolated Python REPL session where you explore the context programmatically.

How it works:
1. The context is loaded into a Python variable in a REPL environment
2. You only see metadata (type, length, preview) — not the full context
3. You write Python code to peek, search, filter, chunk the context
4. You call llm_query(prompt) for simple sub-LLM calls, or rlm_query(prompt) for recursive child RLMs
5. When done, call FINAL(answer) or FINAL_VAR(variable) to return the final answer

Features:
- llm_query(prompt, model?) — simple one-shot sub-LLM calls (~500K chars)
- llm_query_batched(prompts) — concurrent sub-LLM calls
- rlm_query(prompt, model?) — spawn recursive child RLM with own REPL
- rlm_query_batched(prompts) — concurrent child RLMs
- SHOW_VARS() — see all REPL variables
- FINAL(answer) / FINAL_VAR(var) / SUBMIT(answer) — provide final answer

Live visualization shows:
- Active sub-calls as they run (with elapsed time)
- Completed sub-calls with results
- Iteration progress by depth

Use this when:
- Context is very large (100K+ characters) and direct prompting degrades quality
- You need to search/filter/aggregate over structured data
- Direct LLM calls would suffer from "context rot"

The context parameter accepts a string (text) or a file path to read from.`,
    parameters: Type.Object({
      query: Type.String({ description: "The question or task to answer about the context" }),
      context: Type.String({ description: "The large context to analyze — either raw text or a file path (prefix with 'file:' to read from disk, e.g. 'file:/path/to/data.txt')" }),
      max_iterations: Type.Optional(Type.Number({ description: "Maximum REPL iterations (default: 15)", minimum: 1, maximum: 50 })),
      max_llm_calls: Type.Optional(Type.Number({ description: "Maximum sub-LLM calls (default: 50)", minimum: 1, maximum: 100 })),
      max_depth: Type.Optional(Type.Number({ description: "Maximum recursion depth for rlm_query (default: 1)", minimum: 1, maximum: 5 })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const dbg = (msg: string) => {
        try { writeFileSync("/tmp/rlm-debug.log", msg + "\n", { flag: "a" }); } catch {}
      };

      dbg(`\n=== rlm execute() at ${new Date().toISOString()} ===`);
      dbg(`query="${params.query?.slice(0,80)}", context_len=${params.context?.length}`);

      const { query, max_iterations, max_llm_calls, max_depth } = params;
      let { context } = params;

      // Handle file: prefix
      if (context.startsWith("file:")) {
        const filePath = context.slice(5).trim();
        try {
          context = readFileSync(filePath, "utf-8");
          dbg(`Loaded file: ${filePath}, ${context.length} chars`);
        } catch (e: any) {
          dbg(`File read error: ${e.message}`);
          return {
            content: [{ type: "text", text: `Error reading file: ${e.message}` }],
            isError: true,
          };
        }
      }

      const config: RLMConfig = {
        maxIterations: max_iterations ?? 15,
        maxLLMCalls: max_llm_calls ?? 50,
        maxOutputChars: 20_000,
        maxDepth: max_depth ?? 1,
        maxErrors: 5,
      };

      const engine = new RLMEngine(config, pi, ctx);

      // Set up visualization callbacks for LIVE updates
      let lastStatus = "";
      
      engine.onSubCallStart = (call: RLMSubCall) => {
        const icon = call.type === "rlm_query" ? "🔁" : "⚡";
        process.stderr.write(`  ${icon} ${call.type} started: "${call.prompt.slice(0, 60)}…"\n`);
        const status = `${icon} ${call.type.toUpperCase()} started: "${call.prompt.slice(0, 40)}..."`;
        if (status !== lastStatus) {
          lastStatus = status;
          const callTree = engine.getCallTree();
          // Include full tree visualization in each update
          const viz = formatCallTreeVisualization(callTree);
          onUpdate?.({
            content: [{ 
              type: "text", 
              text: `🔄 ${call.type} running: "${call.prompt.slice(0, 50)}..."\n\n${viz}` 
            }],
            details: { 
              trajectory: engine.getTrajectory(), 
              callTree,
              status: "running",
              sessionId: engine.getSessionId?.(),
            },
          });
        }
        dbg(`[VIS] ${call.type} started: ${call.prompt.slice(0, 50)}...`);
      };
      
      engine.onSubCallComplete = (call: RLMSubCall) => {
        const icon = call.type === "rlm_query" ? "🔁" : "⚡";
        const check = call.status === "completed" ? "✅" : "❌";
        const resultPreview = call.result?.slice(0, 80) || call.error?.slice(0, 80) || "";
        process.stderr.write(`  ${check} ${icon} ${call.type} done (${call.duration}ms): ${resultPreview}\n`);
        const status = `${check} ${icon} ${call.type} completed (${call.duration}ms): "${call.prompt.slice(0, 40)}..."`;
        if (status !== lastStatus) {
          lastStatus = status;
          const callTree = engine.getCallTree();
          const viz = formatCallTreeVisualization(callTree);
          onUpdate?.({
            content: [{ 
              type: "text", 
              text: `${check} ${call.type} done (${call.duration}ms)\n\n${viz}` 
            }],
            details: { 
              trajectory: engine.getTrajectory(), 
              callTree,
              status: "running",
            },
          });
        }
        dbg(`[VIS] ${call.type} completed: ${call.duration}ms`);
      };
      
      engine.onIterationStart = (depth, iteration) => {
        const status = `📍 Iteration ${iteration} (depth ${depth})`;
        process.stderr.write(`\n${status}\n`);
        if (status !== lastStatus) {
          lastStatus = status;
          const callTree = engine.getCallTree();
          const viz = formatCallTreeVisualization(callTree);
          onUpdate?.({
            content: [{ 
              type: "text", 
              text: `${status}...\n\n${viz}` 
            }],
            details: { 
              trajectory: engine.getTrajectory(), 
              callTree,
              status: "running",
            },
          });
        }
        dbg(`[VIS] Iteration ${iteration} started at depth ${depth}`);
      };
      
      engine.onIterationComplete = (depth, iteration, duration) => {
        const callTree = engine.getCallTree();
        const liveStatus = formatLiveStatus(callTree);
        const viz = formatCallTreeVisualization(callTree);

        // Write trajectory step to stderr for visibility in -p mode
        const trajectory = engine.getTrajectory();
        const step = trajectory[trajectory.length - 1];
        if (step) {
          const depthTag = step.depth > 0 ? ` [depth ${step.depth}]` : "";
          let stderrOut = `✅ Iteration ${step.iteration}${depthTag} (${duration}ms)\n`;
          if (step.reasoning) stderrOut += `  Reasoning: ${step.reasoning.slice(0, 200)}\n`;
          stderrOut += `  Code:\n${step.code.split("\n").map(l => "    " + l).join("\n")}\n`;
          if (step.output) {
            const out = step.output.length > 500 ? step.output.slice(0, 500) + "…" : step.output;
            stderrOut += `  Output: ${out}\n`;
          }
          process.stderr.write(stderrOut);
        }

        if (liveStatus !== lastStatus) {
          lastStatus = liveStatus;
          onUpdate?.({
            content: [{ 
              type: "text", 
              text: `✅ Iter ${iteration} done (${duration}ms)\n${liveStatus}\n\n${viz}` 
            }],
            details: { 
              trajectory: engine.getTrajectory(), 
              callTree,
              status: "running",
            },
          });
        }
        dbg(`[VIS] Iteration ${iteration} completed in ${duration}ms`);
      };

      // Stream progress - also capture live tree periodically
      let lastStep = 0;
      const progressInterval = setInterval(() => {
        const trajectory = engine.getTrajectory();
        const callTree = engine.getCallTree();
        const liveStatus = formatLiveStatus(callTree);
        const viz = formatCallTreeVisualization(callTree);
        
        if (trajectory.length > lastStep || liveStatus !== lastStatus) {
          lastStep = trajectory.length;
          lastStatus = liveStatus;
          onUpdate?.({
            content: [{ 
              type: "text", 
              text: `⚡ RLM Running...\n${liveStatus}\n\n${viz}` 
            }],
            details: { trajectory, callTree, iteration: lastStep, status: "running" },
          });
        }
      }, 500);  // Updates every 500ms

      try {
        dbg("calling engine.run()...");
        const result = await engine.run(query, context, signal);
        dbg(`engine.run() returned: "${result?.slice(0, 200)}"`);
        clearInterval(progressInterval);

        const trajectory = engine.getTrajectory();
        const callTree = engine.getCallTree();
        
        // Generate final visualization
        const visualization = formatCallTreeVisualization(callTree);

        process.stderr.write(`\n═══ RLM Complete (${trajectory.length} iterations, ${callTree.totalLLMCalls} llm_query, ${callTree.totalRLMCalls} rlm_query, depth ${callTree.maxDepth}) ═══\n`);
        
        return {
          content: [{ type: "text", text: result }],
          details: {
            trajectory,
            callTree,
            totalIterations: trajectory.length,
            totalLLMCalls: callTree.totalLLMCalls,
            totalRLMCalls: callTree.totalRLMCalls,
            maxDepth: callTree.maxDepth,
            visualization,
            answer: result,
            status: "completed",
          },
        };
      } catch (e: any) {
        dbg(`engine.run() error: ${e.message}\n${e.stack}`);
        clearInterval(progressInterval);
        
        const callTree = engine.getCallTree();
        const visualization = formatCallTreeVisualization(callTree);
        
        return {
          content: [{ type: "text", text: `RLM error: ${e.message}` }],
          details: { 
            trajectory: engine.getTrajectory(),
            callTree,
            visualization,
            status: "error",
          },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("rlm "));
      const queryPreview = args.query?.length > 80 ? args.query.slice(0, 80) + "…" : args.query;
      text += theme.fg("accent", `"${queryPreview}"`);
      if (args.context?.startsWith("file:")) {
        text += " " + theme.fg("muted", args.context);
      } else if (args.context) {
        text += " " + theme.fg("dim", `(${formatSize(args.context.length)} context)`);
      }
      if (args.max_depth && args.max_depth > 1) {
        text += " " + theme.fg("accent", `[depth=${args.max_depth}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (!details) {
        const text = result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "No result";
        return new Text(text, 0, 0);
      }

      const callTree = details.callTree as RLMCallTree | undefined;

      let text = "";
      if (result.isError) {
        text = theme.fg("error", result.content?.[0]?.type === "text" ? (result.content[0] as any).text : "Error");
      } else if (details.status === "running") {
        // Live status display
        text = theme.fg("accent", "⚡ ") + theme.bold("RLM Running");
        if (callTree) {
          text += "\n" + theme.fg("dim", formatLiveStatus(callTree));
        }
      } else {
        text = theme.fg("success", "✓ ") + theme.bold("RLM Complete");
        text += theme.fg("dim", ` (${details.totalIterations} iterations)`);
        if (details.totalLLMCalls > 0) {
          text += theme.fg("dim", `, ${details.totalLLMCalls} llm_query`);
        }
        if (details.totalRLMCalls > 0) {
          text += theme.fg("dim", `, ${details.totalRLMCalls} rlm_query`);
        }
        if (details.maxDepth > 0) {
          text += theme.fg("dim", `, depth ${details.maxDepth}`);
        }
      }

      // Add visualization in expanded mode
      if (expanded && details.visualization) {
        text += "\n\n" + theme.fg("accent", details.visualization);
      }

      // Show active calls even when not expanded (if running)
      if (!expanded && callTree?.activeCalls?.length) {
        text += "\n" + theme.fg("muted", "Active: ");
        for (const call of callTree.activeCalls) {
          const icon = call.type === "rlm_query" ? "🔁" : "⚡";
          text += theme.fg("accent", `${icon} ${call.type} `);
        }
      }

      if (expanded && details.trajectory) {
        for (const step of details.trajectory as RLMTrajectoryStep[]) {
          const depthIndicator = step.depth > 0 ? `[d${step.depth}]` : "";
          text += "\n\n" + theme.fg("accent", `── Step ${step.iteration}${depthIndicator} ──`);
          text += "\n" + theme.fg("muted", "Reasoning: ") + step.reasoning.slice(0, 200);
          text += "\n" + theme.fg("muted", "Code:");
          text += "\n" + theme.fg("dim", step.code);
          if (step.output) {
            const out = step.output.length > 300 ? step.output.slice(0, 300) + "…" : step.output;
            text += "\n" + theme.fg("muted", "Output: ") + out;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

