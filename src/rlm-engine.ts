/**
 * RLM Engine — Enhanced Recursive Language Model implementation for pi.
 *
 * Implements the full RLM pattern from the paper:
 * 1. Context is stored as a variable in a Python REPL
 * 2. Root LLM only sees metadata, writes code to explore
 * 3. Root LLM can call llm_query() for simple sub-LLM calls
 * 4. Root LLM can call rlm_query() for recursive child RLM with own REPL
 * 5. Root LLM calls FINAL() or SUBMIT() when it has the answer
 *
 * Based on: https://arxiv.org/abs/2512.24601
 * Original implementation: https://github.com/alexzhang13/rlm
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface RLMConfig {
  maxIterations: number;
  maxLLMCalls: number;
  maxOutputChars: number;
  maxDepth: number;  // Maximum recursion depth for rlm_query
  maxErrors: number;  // Maximum consecutive errors before stopping
}

export interface RLMTrajectoryStep {
  iteration: number;
  depth: number;
  reasoning: string;
  code: string;
  output: string;
  subCalls?: RLMSubCall[];
}

export interface RLMSubCall {
  id: string;
  type: "llm_query" | "rlm_query";
  prompt: string;
  model?: string;
  result?: string;
  error?: string;
  duration?: number;
  status: "pending" | "running" | "completed" | "error";
  startTime?: number;
  children?: RLMSubCall[];
}

export interface RLMCallTree {
  rootQuery: string;
  iterations: RLMTrajectoryStep[];
  totalLLMCalls: number;
  totalRLMCalls: number;
  maxDepth: number;
  // Live hierarchy tracking
  activeCalls: RLMSubCall[];  // Currently running sub-calls
  completedCalls: RLMSubCall[];  // All completed sub-calls with hierarchy
}

// Event callbacks for visualization - now includes full call info
export type SubCallStartCallback = (call: RLMSubCall) => void;
export type SubCallCompleteCallback = (call: RLMSubCall) => void;
export type IterationStartCallback = (depth: number, iteration: number) => void;
export type IterationCompleteCallback = (depth: number, iteration: number, duration: number) => void;

interface REPLResult {
  stdout: string;
  stderr: string;
  finalAnswer?: string;
  finalVar?: string;
  submitted?: string;
  error?: string;
  showVars?: Record<string, unknown>;
}

interface SharedRLMState {
  llmCalls: number;
  rlmCalls: number;
}

const RLM_SYSTEM_PROMPT = `You are an RLM (Recursive Language Model). You have a Python REPL environment with a \`context\` variable loaded. Your job is to answer the user's query about this context.

## Available Functions:
- \`context\` — the full input text, loaded as a string variable
- \`llm_query(prompt, model=None)\` — call a sub-LLM for analysis (~500K char limit per call)
- \`llm_query_batched(prompts, model=None)\` — concurrent sub-LLM calls, returns List[str]
- \`rlm_query(prompt, model=None)\` — spawn a recursive child RLM with its own REPL
- \`rlm_query_batched(prompts, model=None)\` — concurrent child RLMs
- \`strip_fences(text)\` — remove markdown code fences from llm_query output (use before json.loads)
- \`SHOW_VARS()\` — list all variables in your REPL namespace
- \`FINAL(answer)\` — provide your final answer (as a string)
- \`FINAL_VAR(variable_name)\` — return a REPL variable as the final answer. The variable MUST exist from a previous \\\`\\\`\\\`repl block.
- \`SUBMIT(answer)\` — alias for FINAL

## Execution Format:
Write Python code inside \\\`\\\`\\\`repl blocks. You can use print() to inspect data.

\\\`\\\`\\\`repl
# Your Python code here
chunk = context[:5000]
result = llm_query(f"Summarize: {chunk}")
print(result)
\\\`\\\`\\\`

## When to use Python vs llm_query():
- **Use Python alone** for computation, parsing, grep, filtering, math, decoding
- **Use llm_query()** when you need SEMANTIC understanding: summarizing text, identifying themes, classifying content, extracting meaning, comparing ideas
- **Use llm_query_batched()** to analyze multiple text chunks in parallel

## Strategy for Large Contexts:
1. First, check the context size: \`print(len(context))\`
2. If the task requires semantic understanding (summarization, theme extraction, classification):
   a. Split context into meaningful chunks (by section, document, or fixed size)
   b. Use \`llm_query_batched()\` to analyze each chunk
   c. Aggregate results and call \`FINAL(answer)\`
3. If the task is computational (math, parsing, pattern matching): use Python directly

## Important:
- Do NOT pass the entire context to a single llm_query() call — it may exceed limits
- Chunk the context and analyze pieces in parallel for best results
- You can run multiple iterations — explore, then refine, then answer
- Call FINAL(answer) when you have your answer`;

const ITERATION_PROMPT_TEMPLATE = `## Iteration {iteration}/{maxIterations} (depth {depth})

Query: {query}

Context metadata:
- Type: string
- Length: {contextLength} characters ({contextLines} lines)
- Preview (first 500 chars): {contextPreview}

{firstIterationNote}
{history}

Write your Python code in a \`\`\`repl block. Call FINAL(answer) when done.`;

/**
 * Persistent Python REPL that maintains state across code executions.
 * Communicates via JSON over stdin/stdout using sentinel markers.
 */
class PersistentREPL {
  private proc: ChildProcess;
  private ready: Promise<void>;
  private serverPort: number;
  private tempDir: string;

  constructor(contextPath: string, serverPort: number, tempDir: string) {
    this.serverPort = serverPort;
    this.tempDir = tempDir;
    const driverScript = this.buildDriverScript(contextPath, serverPort);
    const driverPath = join(tempDir, "repl_driver.py");
    writeFileSync(driverPath, driverScript, "utf-8");

    this.proc = spawn("python3", [driverPath], {
      cwd: tempDir,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for the "READY" signal
    this.ready = new Promise<void>((resolve, reject) => {
      const onData = (data: Buffer) => {
        if (data.toString().includes("__REPL_READY__")) {
          this.proc.stdout?.off("data", onData);
          resolve();
        }
      };
      this.proc.stdout?.on("data", onData);
      this.proc.on("error", reject);
      setTimeout(() => reject(new Error("Python REPL failed to start within 30s")), 30_000);
    });
  }

  async execute(code: string): Promise<REPLResult> {
    await this.ready;

    return new Promise<REPLResult>((resolve, reject) => {
      const message = JSON.stringify({ code }) + "\n__REPL_EXEC__\n";
      let output = "";
      let resolved = false;

      const cleanup = () => {
        if (!resolved) resolved = true;
        this.proc.stdout?.off("data", onData);
        this.proc.stdout?.off("close", onClose);
        clearTimeout(timer);
      };

      const doResolve = (result: REPLResult) => {
        if (resolved) return;
        cleanup();
        resolve(result);
      };

      const onData = (data: Buffer) => {
        output += data.toString();
        const endIdx = output.indexOf("__REPL_RESULT_END__");
        if (endIdx !== -1) {
          const resultText = output.slice(0, endIdx);
          const startIdx = resultText.lastIndexOf("__REPL_RESULT_START__");
          if (startIdx !== -1) {
            const jsonStr = resultText.slice(startIdx + "__REPL_RESULT_START__".length).trim();
            try {
              const result = JSON.parse(jsonStr);
              const userStdout = resultText.slice(0, startIdx).trim();
              doResolve({
                stdout: userStdout,
                stderr: result.stderr || "",
                finalAnswer: result.final_answer,
                finalVar: result.final_var,
                submitted: result.submitted,
                error: result.error,
                showVars: result.show_vars,
              });
            } catch {
              doResolve({ stdout: resultText, stderr: "", error: "Failed to parse REPL result" });
            }
          } else {
            doResolve({ stdout: resultText, stderr: "" });
          }
        }
      };

      const onClose = () => {
        doResolve({ stdout: output, stderr: "REPL process exited", error: "process_exit" });
      };

      const timer = setTimeout(() => {
        doResolve({ stdout: output, stderr: "Execution timed out (120s)", error: "timeout" });
      }, 120_000);

      this.proc.stdout?.on("data", onData);
      this.proc.stdout?.on("close", onClose);
      this.proc.stdin?.write(message);
    });
  }

  getServerPort(): number {
    return this.serverPort;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  shutdown() {
    try {
      this.proc.stdin?.end();
      this.proc.kill();
    } catch {}
  }

  private buildDriverScript(contextPath: string, serverPort: number): string {
    return `
import sys
import io
import json
import traceback
import urllib.request
import concurrent.futures
import threading

# Load context
with open(${JSON.stringify(contextPath)}, 'r') as f:
    context = f.read()

# Sub-LLM query function (simple one-shot)
def llm_query(prompt, model=None):
    """Query the sub-LLM for simple one-shot tasks."""
    if not isinstance(prompt, str):
        prompt = str(prompt)
    data = json.dumps({"prompt": prompt, "model": model}).encode('utf-8')
    req = urllib.request.Request(
        'http://127.0.0.1:${serverPort}/llm_query',
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            if 'error' in result:
                return f"[LLM Error] {result['error']}"
            return result.get('result', '')
    except Exception as e:
        return f"[LLM Error] {e}"

# Batched llm_query
def llm_query_batched(prompts, model=None):
    """Run multiple llm_query calls concurrently."""
    if not isinstance(prompts, list):
        prompts = [prompts]
    results = []
    def single_query(p):
        return llm_query(p, model)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(prompts), 10)) as executor:
        results = list(executor.map(single_query, prompts))
    return results

# Recursive RLM query (spawns child RLM)
def rlm_query(prompt, model=None):
    """Spawn a recursive child RLM with its own REPL for multi-step reasoning."""
    if not isinstance(prompt, str):
        prompt = str(prompt)
    data = json.dumps({"prompt": prompt, "model": model, "recursive": True}).encode('utf-8')
    req = urllib.request.Request(
        'http://127.0.0.1:${serverPort}/rlm_query',
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            if 'error' in result:
                return f"[RLM Error] {result['error']}"
            return result.get('result', '')
    except Exception as e:
        return f"[RLM Error] {e}"

# Batched rlm_query
def rlm_query_batched(prompts, model=None):
    """Run multiple rlm_query calls concurrently."""
    if not isinstance(prompts, list):
        prompts = [prompts]
    results = []
    def single_query(p):
        return rlm_query(p, model)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(prompts), 5)) as executor:
        results = list(executor.map(single_query, prompts))
    return results

# Utility: strip markdown fences from LLM output (common need when parsing JSON)
def strip_fences(text):
    """Remove markdown code fences from LLM output. Useful when parsing JSON from llm_query results."""
    import re as _re
    t = text.strip()
    fence = chr(96) * 3  # three backticks
    pattern = fence + '(?:\\\\w+)?\\\\s*\\\\n([\\\\s\\\\S]*?)\\\\n?\\\\s*' + fence + '\\\\s*$'
    m = _re.match(pattern, t, _re.S)
    if m:
        return m.group(1).strip()
    return t

# Show all variables
def SHOW_VARS():
    """Return all user-created variables in the REPL."""
    user_vars = {k: v for k, v in _namespace.items() 
                 if not k.startswith('_') and k not in ['context', 'llm_query', 'llm_query_batched', 'rlm_query', 'rlm_query_batched', 'SHOW_VARS', 'FINAL', 'FINAL_VAR', 'SUBMIT', 'strip_fences', 'print', '__builtins__']}
    return user_vars

# FINAL answer markers
_final_answer = None
_final_var = None

def FINAL(answer):
    """Provide the final answer directly."""
    global _final_answer, _final_var
    _final_answer = str(answer)
    _final_var = None

def FINAL_VAR(var_name):
    """Return a variable as the final answer."""
    global _final_answer, _final_var
    _final_var = str(var_name)
    _final_answer = None

# Backwards compatibility alias
def SUBMIT(answer):
    """Alias for FINAL (kept for backwards compatibility)."""
    FINAL(answer)

# Persistent namespace for user code
_namespace = {
    'context': context,
    'llm_query': llm_query,
    'llm_query_batched': llm_query_batched,
    'rlm_query': rlm_query,
    'rlm_query_batched': rlm_query_batched,
    'SHOW_VARS': SHOW_VARS,
    'FINAL': FINAL,
    'FINAL_VAR': FINAL_VAR,
    'SUBMIT': SUBMIT,
    'strip_fences': strip_fences,
    '__builtins__': __builtins__,
}

# Signal readiness
print("__REPL_READY__", flush=True)

# Main REPL loop
buffer = ""
while True:
    try:
        line = sys.stdin.readline()
        if not line:
            break
        buffer += line
        if "__REPL_EXEC__" not in buffer:
            continue

        msg_text = buffer.split("__REPL_EXEC__")[0].strip()
        buffer = ""

        msg = json.loads(msg_text)
        code = msg.get("code", "")

        _final_answer = None
        _final_var = None
        # Re-bind functions in case user overwrote them
        _namespace['llm_query'] = llm_query
        _namespace['llm_query_batched'] = llm_query_batched
        _namespace['rlm_query'] = rlm_query
        _namespace['rlm_query_batched'] = rlm_query_batched
        _namespace['SHOW_VARS'] = SHOW_VARS
        _namespace['FINAL'] = FINAL
        _namespace['FINAL_VAR'] = FINAL_VAR
        _namespace['SUBMIT'] = SUBMIT
        _namespace['strip_fences'] = strip_fences

        old_stdout = sys.stdout
        old_stderr = sys.stderr
        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()
        sys.stdout = captured_stdout
        sys.stderr = captured_stderr

        error = None
        try:
            exec(code, _namespace)
        except Exception as e:
            error = traceback.format_exc()

        # Restore scaffold after exec (official RLM pattern)
        _namespace['context'] = context
        _namespace['llm_query'] = llm_query
        _namespace['llm_query_batched'] = llm_query_batched
        _namespace['rlm_query'] = rlm_query
        _namespace['rlm_query_batched'] = rlm_query_batched
        _namespace['SHOW_VARS'] = SHOW_VARS
        _namespace['FINAL'] = FINAL
        _namespace['FINAL_VAR'] = FINAL_VAR
        _namespace['SUBMIT'] = SUBMIT
        _namespace['strip_fences'] = strip_fences

        sys.stdout = old_stdout
        sys.stderr = old_stderr

        stdout_text = captured_stdout.getvalue()
        stderr_text = captured_stderr.getvalue()
        if error:
            stderr_text += error

        # Get final answer from variable if FINAL_VAR was used
        final_var_value = None
        if _final_var and _final_var in _namespace:
            final_var_value = str(_namespace[_final_var])

        result = {
            "stdout": stdout_text,
            "stderr": stderr_text,
            "final_answer": _final_answer,
            "final_var": final_var_value,
            "submitted": _final_answer,  # backwards compat
            "error": error,
            "show_vars": SHOW_VARS() if 'SHOW_VARS' in code else None,
        }

        print(stdout_text, end="", flush=True)
        print("__REPL_RESULT_START__", flush=True)
        print(json.dumps(result), flush=True)
        print("__REPL_RESULT_END__", flush=True)

    except Exception as e:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        print("__REPL_RESULT_START__", flush=True)
        print(json.dumps({"stdout": "", "stderr": str(e), "final_answer": None, "submitted": None, "error": str(e)}), flush=True)
        print("__REPL_RESULT_END__", flush=True)
`;
  }
}

export class RLMEngine {
  private config: RLMConfig;
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;
  private trajectory: RLMTrajectoryStep[] = [];
  private tempDir: string;
  private consecutiveErrors = 0;
  private currentDepth: number = 0;
  private callTree: RLMCallTree;
  private sessionId: string;
  private sharedState: SharedRLMState;
  private forcedModelId?: string;
  
  // Visualization callbacks
  public onSubCallStart?: SubCallStartCallback;
  public onSubCallComplete?: SubCallCompleteCallback;
  public onIterationStart?: IterationStartCallback;
  public onIterationComplete?: IterationCompleteCallback;

  constructor(
    config: RLMConfig,
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    depth: number = 0,
    parentTree?: RLMCallTree,
    sharedState?: SharedRLMState,
    forcedModelId?: string,
  ) {
    this.config = config;
    this.pi = pi;
    this.ctx = ctx;
    this.currentDepth = depth;
    this.tempDir = mkdtempSync(join(tmpdir(), "pi-rlm-"));
    this.sessionId = Date.now().toString(36);
    
    // Initialize call tree for visualization
    if (parentTree) {
      this.callTree = parentTree;
    } else {
      this.callTree = {
        rootQuery: "",
        iterations: [],
        totalLLMCalls: 0,
        totalRLMCalls: 0,
        maxDepth: 0,
        activeCalls: [],
        completedCalls: [],
      };
    }

    this.sharedState = sharedState ?? { llmCalls: 0, rlmCalls: 0 };
    this.forcedModelId = forcedModelId;
  }

  getTrajectory(): RLMTrajectoryStep[] {
    return [...this.trajectory];
  }

  getCallTree(): RLMCallTree {
    return this.callTree;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private recordStep(step: RLMTrajectoryStep) {
    this.trajectory.push(step);
    this.callTree.iterations.push(step);
    this.callTree.maxDepth = Math.max(this.callTree.maxDepth, step.depth);
  }

  async run(query: string, context: string, signal?: AbortSignal): Promise<string> {
    let server: Server | null = null;
    let repl: PersistentREPL | null = null;

    if (this.currentDepth === 0 || !this.callTree.rootQuery) {
      this.callTree.rootQuery = query;
    }

    const debugLog = (msg: string) => {
      try { writeFileSync(`/tmp/rlm-${this.sessionId}.log`, msg + "\n", { flag: "a" }); } catch {}
    };

    debugLog(`\n=== RLM run() started (depth=${this.currentDepth}, session=${this.sessionId}) ===`);
    debugLog(`query="${query.slice(0, 80)}", context length=${context.length}`);
    debugLog(`config: maxIterations=${this.config.maxIterations}, maxLLMCalls=${this.config.maxLLMCalls}, maxDepth=${this.config.maxDepth}`);

    try {
      const contextPath = join(this.tempDir, "context.txt");
      writeFileSync(contextPath, context, "utf-8");

      // Start HTTP server for sub-LLM/rlm calls from the REPL
      const serverPort = await new Promise<number>((resolve, reject) => {
        server = createServer(async (req, res) => {
          if (req.method === "POST" && req.url === "/llm_query") {
            let body = "";
            req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            req.on("end", async () => {
              let payload: any;
              try {
                payload = JSON.parse(body || "{}");
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
                return;
              }

              const prompt = String(payload.prompt ?? "");
              const model = typeof payload.model === "string" ? payload.model : undefined;
              const startTime = Date.now();
              
              // Track this call for live visualization
              const callId = `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const call: RLMSubCall = {
                id: callId,
                type: "llm_query",
                prompt: prompt.slice(0, 200),
                model,
                status: "running",
                startTime,
                duration: 0,
              };
              this.callTree.activeCalls.push(call);
              
              // Fire visualization callback
              this.onSubCallStart?.(call);

              try {
                const answer = await this.callSubLLM(prompt, model, signal);
                const duration = Date.now() - startTime;
                
                // Update call status
                call.status = "completed";
                call.duration = duration;
                call.result = answer.slice(0, 200);
                this.callTree.activeCalls = this.callTree.activeCalls.filter(c => c.id !== callId);
                this.callTree.completedCalls.push(call);
                
                // Fire visualization callback
                this.onSubCallComplete?.(call);
                
                debugLog(`[llm_query] depth=${this.currentDepth + 1}, model=${model}, duration=${duration}ms`);
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ result: answer }));
              } catch (e: any) {
                // Update call status on error (find by ID, not pop)
                call.status = "error";
                call.error = e.message;
                call.duration = Date.now() - (call.startTime || 0);
                this.callTree.activeCalls = this.callTree.activeCalls.filter(c => c.id !== callId);
                this.callTree.completedCalls.push(call);
                this.onSubCallComplete?.(call);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
              }
            });
          } else if (req.method === "POST" && req.url === "/rlm_query") {
            let body = "";
            req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            req.on("end", async () => {
              let payload: any;
              try {
                payload = JSON.parse(body || "{}");
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
                return;
              }

              const prompt = String(payload.prompt ?? "");
              const model = typeof payload.model === "string" ? payload.model : undefined;
              const startTime = Date.now();
              
              // Track this call for live visualization
              const callId = `rlm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const call: RLMSubCall = {
                id: callId,
                type: "rlm_query",
                prompt: prompt.slice(0, 200),
                model,
                status: "running",
                startTime,
                duration: 0,
              };
              this.callTree.activeCalls.push(call);
              this.sharedState.rlmCalls++;
              this.callTree.totalRLMCalls = this.sharedState.rlmCalls;
              
              // Fire visualization callback
              this.onSubCallStart?.(call);

              try {
                // Spawn a child RLM with its own REPL
                const answer = await this.spawnChildRLM(prompt, context, model, signal);
                const duration = Date.now() - startTime;
                
                // Update call status
                call.status = "completed";
                call.duration = duration;
                call.result = answer.slice(0, 200);
                this.callTree.activeCalls = this.callTree.activeCalls.filter(c => c.id !== callId);
                this.callTree.completedCalls.push(call);
                
                // Fire visualization callback
                this.onSubCallComplete?.(call);
                
                debugLog(`[rlm_query] depth=${this.currentDepth + 1}, model=${model}, duration=${duration}ms`);
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ result: answer }));
              } catch (e: any) {
                // Update call status on error (find by ID, not pop)
                call.status = "error";
                call.error = e.message;
                call.duration = Date.now() - (call.startTime || 0);
                this.callTree.activeCalls = this.callTree.activeCalls.filter(c => c.id !== callId);
                this.callTree.completedCalls.push(call);
                this.onSubCallComplete?.(call);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
              }
            });
          } else {
            res.writeHead(404);
            res.end();
          }
        });

        server!.listen(0, "127.0.0.1", () => {
          const addr = server!.address() as any;
          resolve(addr.port);
        });
        server!.on("error", reject);
      });

      // Start persistent Python REPL
      repl = new PersistentREPL(contextPath, serverPort, this.tempDir);

      // Build context metadata for the root LLM
      const contextLines = context.split("\n").length;
      const contextPreview = context.slice(0, 500).replace(/\n/g, "\\n");

      for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
        if (signal?.aborted) throw new Error("Aborted");

        this.onIterationStart?.(this.currentDepth, iteration);
        const iterStartTime = Date.now();

        const historyText = this.trajectory.length > 0
          ? "## Previous iterations:\n" + this.trajectory.map(s =>
              `### Step ${s.iteration} (depth ${s.depth})\nReasoning: ${s.reasoning}\nCode:\n\`\`\`repl\n${s.code}\n\`\`\`\nOutput:\n${s.output}`
            ).join("\n\n")
          : "No previous iterations yet.";

        const firstIterationNote = iteration === 1
          ? "You have not interacted with the REPL environment or seen your context yet. Your next action should be to explore the context and figure out how to answer the query — don't provide a final answer yet."
          : "";

        const iterationPrompt = ITERATION_PROMPT_TEMPLATE
          .replace("{iteration}", String(iteration))
          .replace("{maxIterations}", String(this.config.maxIterations))
          .replace("{depth}", String(this.currentDepth))
          .replace("{query}", query)
          .replace("{contextLength}", String(context.length))
          .replace("{contextLines}", String(contextLines))
          .replace("{contextPreview}", contextPreview)
          .replace("{firstIterationNote}", firstIterationNote)
          .replace("{history}", historyText);

        // Call the root LLM via pi's complete() function
        const llmResponse = await this.callLLM(iterationPrompt, RLM_SYSTEM_PROMPT, signal);
        
        // Debug: log the raw response
        debugLog(`[RAW RESPONSE ${iteration}] len=${llmResponse.length}, preview=${llmResponse.slice(0, 500)}`);

        const { reasoning, code } = this.parseResponse(llmResponse);
        
        // Debug: Log what was extracted
        debugLog(`[PARSE ${iteration}] code_len=${code.length}, reasoning_len=${reasoning.length}`);
        debugLog(`[ITER ${iteration}] Code generated (${code.length} chars): ${code.slice(0, 200)}...`);

        if (!code) {
          this.recordStep({
            iteration,
            depth: this.currentDepth,
            reasoning: reasoning || llmResponse,
            code: "(no code produced)",
            output: "No code block found in response.",
          });
          continue;
        }

        // Execute the code in the persistent Python REPL
        const result = await repl.execute(code);

        // Check for final answer (FINAL, FINAL_VAR, or SUBMIT)
        const finalAnswer = result.finalAnswer || result.finalVar || result.submitted;
        if (finalAnswer !== undefined && finalAnswer !== null) {
          const iterDuration = Date.now() - iterStartTime;
          this.onIterationComplete?.(this.currentDepth, iteration, iterDuration);
          
          const output = `FINAL: ${finalAnswer}`;
          this.recordStep({
            iteration,
            depth: this.currentDepth,
            reasoning,
            code,
            output,
          });
          
          return finalAnswer;
        }

        const output = this.formatOutput(result);
        this.recordStep({ iteration, depth: this.currentDepth, reasoning, code, output });

        // Track consecutive errors
        if (result.error) {
          this.consecutiveErrors++;
          if (this.consecutiveErrors >= this.config.maxErrors) {
            throw new Error(`Too many consecutive errors (${this.consecutiveErrors}), stopping RLM`);
          }
        } else {
          this.consecutiveErrors = 0;
        }
        
        const iterDuration = Date.now() - iterStartTime;
        this.onIterationComplete?.(this.currentDepth, iteration, iterDuration);
      }

      // Max iterations reached — extract best-effort answer
      return await this.extractFallback(query, signal);
    } finally {
      repl?.shutdown();
      server?.close();
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Spawn a child RLM for recursive reasoning
   */
  private async spawnChildRLM(prompt: string, context: string, model?: string, signal?: AbortSignal): Promise<string> {
    if (this.currentDepth >= this.config.maxDepth) {
      // At max depth, fall back to simple LLM call
      return this.callSubLLM(prompt, model, signal);
    }

    const childConfig: RLMConfig = {
      ...this.config,
    };

    const childEngine = new RLMEngine(
      childConfig,
      this.pi,
      this.ctx,
      this.currentDepth + 1,
      this.callTree,
      this.sharedState,
      model,
    );
    
    // Propagate callbacks
    childEngine.onSubCallStart = this.onSubCallStart;
    childEngine.onSubCallComplete = this.onSubCallComplete;
    childEngine.onIterationStart = this.onIterationStart;
    childEngine.onIterationComplete = this.onIterationComplete;

    // Use same context but different query (child RLM gets its own exploration)
    return childEngine.run(prompt, context, signal);
  }

  private async resolveModel(modelId?: string): Promise<any> {
    if (!modelId) return this.ctx.model;

    const registryAny = this.ctx.modelRegistry as any;
    let resolved =
      registryAny?.getModelById?.(modelId) ??
      registryAny?.getModel?.(modelId) ??
      registryAny?.models?.find?.((m: any) => m?.id === modelId);

    if (resolved && typeof resolved.then === "function") {
      resolved = await resolved;
    }

    return resolved ?? this.ctx.model;
  }

  /**
   * Call the LLM using pi's complete() function.
   */
  private async callLLM(
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal,
    modelOverrideId?: string,
  ): Promise<string> {
    const model = await this.resolveModel(modelOverrideId ?? this.forcedModelId);
    if (!model) throw new Error("No model configured");

    const apiKey = await this.ctx.modelRegistry.getApiKey(model);
    if (!apiKey) throw new Error(`No API key for model: ${model.id}`);

    const debugLog = (msg: string) => {
      try { writeFileSync("/tmp/rlm-debug.log", msg + "\n", { flag: "a" }); } catch {}
    };

    debugLog(`[${new Date().toISOString()}] callLLM: model=${model.id}, provider=${model.provider}, prompt_len=${prompt.length}`);

    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };

    try {
      const response = await complete(model, {
        systemPrompt,
        messages: [userMessage],
      }, {
        apiKey,
        signal,
      });

      debugLog(`complete() returned: stopReason=${response.stopReason}, content_items=${response.content.length}`);

      if (response.stopReason === "aborted") {
        throw new Error("Aborted");
      }

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map(c => c.text)
        .join("\n");

      return text;
    } catch (e: any) {
      debugLog(`complete() ERROR: ${e.message}\n${e.stack}`);
      throw e;
    }
  }

  /**
   * Sub-LLM call (used by llm_query inside the REPL).
   * Optionally uses a specific model if provided.
   */
  private async callSubLLM(prompt: string, modelId?: string, signal?: AbortSignal): Promise<string> {
    if (this.sharedState.llmCalls >= this.config.maxLLMCalls) {
      throw new Error(`Sub-LLM call limit reached (${this.config.maxLLMCalls})`);
    }

    this.sharedState.llmCalls++;
    this.callTree.totalLLMCalls = this.sharedState.llmCalls;

    return this.callLLM(prompt, undefined, signal, modelId);
  }

  private parseResponse(response: string): { reasoning: string; code: string } {
    // Extract ALL code blocks - various formats
    const codeBlocks: string[] = [];
    const decodePrompt = (value: string) =>
      value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .trim();
    
    // Try ```repl ... ``` blocks first (official format)
    let regex = /```repl\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    let firstMatchIndex = -1;

    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      codeBlocks.push(match[1].trim());
    }

    // Fallback to ```python/py``` blocks
    if (codeBlocks.length === 0) {
      regex = /```(?:python|py)?\s*\n([\s\S]*?)```/g;
      while ((match = regex.exec(response)) !== null) {
        if (firstMatchIndex === -1) firstMatchIndex = match.index;
        codeBlocks.push(match[1].trim());
      }
    }

    // Try <repl>...</repl> style tags
    regex = /<repl>([\s\S]*?)<\/repl>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      codeBlocks.push(match[1].trim());
    }

    // Try <rlm_query>...</rlm_query> tags
    regex = /<rlm_query>([\s\S]*?)<\/rlm_query>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      codeBlocks.push(match[1].trim());
    }

    // Try <llm_query>...</llm_query> tags
    regex = /<llm_query>([\s\S]*?)<\/llm_query>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      codeBlocks.push(match[1].trim());
    }

    // Try <tool_call><tool name="llm_query_batched">...</tool_call> style
    // Extract the prompts parameter and generate Python code
    regex = /<tool_call>\s*<tool name="llm_query_batched">([\s\S]*?)<\/tool_call>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      const content = match[1];
      // Extract prompts array
      const promptsMatch = content.match(/<param name="prompts">(\[[\s\S]*?\])/);
      if (promptsMatch) {
        codeBlocks.push(`results = llm_query_batched(${promptsMatch[1]})`);
      }
    }

    // Try <llm_query>...</llm_query> tags (standalone, no tool_call wrapper)
    regex = /<llm_query>\s*<param name="prompt">([\s\S]*?)<\/param>\s*<\/llm_query>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      const prompt = decodePrompt(match[1]);
      codeBlocks.push(`result = llm_query(${JSON.stringify(prompt)})`);
    }

    // Try <llm_query_batched>...</llm_query_batched> tags (standalone)
    regex = /<llm_query_batched>\s*<param name="prompts">(\[[\s\S]*?\])\s*<\/param>\s*<\/llm_query_batched>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      codeBlocks.push(`results = llm_query_batched(${match[1]})`);
    }

    // Try <invoke name="llm_query"> format
    regex = /<invoke name="llm_query">\s*([\s\S]*?)\s*<\/invoke>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      const prompt = decodePrompt(match[1]);
      codeBlocks.push(`result = llm_query(${JSON.stringify(prompt)})`);
    }

    // Try <invoke name="llm_query_batched"> format
    regex = /<invoke name="llm_query_batched">\s*(\[[\s\S]*?\])\s*<\/invoke>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      codeBlocks.push(`results = llm_query_batched(${match[1]})`);
    }

    // Try <tool_call><tool name="llm_query">...</tool_call>
    regex = /<tool_call>\s*<tool name="llm_query">([\s\S]*?)<\/tool_call>/g;
    while ((match = regex.exec(response)) !== null) {
      if (firstMatchIndex === -1) firstMatchIndex = match.index;
      const content = match[1];
      // Extract prompt param
      const promptMatch = content.match(/<param name="prompt">([\s\S]*?)<\/param>/);
      if (promptMatch) {
        const prompt = decodePrompt(promptMatch[1]);
        codeBlocks.push(`result = llm_query(${JSON.stringify(prompt)})`);
      }
    }

    const code = codeBlocks.join("\n\n");

    // Everything before the first code block is reasoning
    let reasoning = firstMatchIndex >= 0
      ? response.slice(0, firstMatchIndex).trim()
      : response;

    reasoning = reasoning.replace(/^#+\s*/gm, "").trim();
    if (!reasoning) reasoning = "(no explicit reasoning)";

    return { reasoning, code };
  }

  private formatOutput(result: REPLResult): string {
    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.showVars) {
      if (output) output += "\n";
      output += `[Variables: ${JSON.stringify(result.showVars)}]`;
    }
    if (result.stderr) {
      if (output) output += "\n";
      output += `[stderr] ${result.stderr}`;
    }
    if (!output) output = "(no output — did you forget to print?)";

    if (output.length > this.config.maxOutputChars) {
      output = output.slice(0, this.config.maxOutputChars) + `\n... (truncated, ${output.length} total chars)`;
    }
    return output;
  }

  private async extractFallback(query: string, signal?: AbortSignal): Promise<string> {
    const historyText = this.trajectory.map(s =>
      `Step ${s.iteration} (depth ${s.depth}): ${s.reasoning}\nCode: ${s.code}\nOutput: ${s.output}`
    ).join("\n\n");

    const prompt = `Based on the following RLM trajectory, provide the best answer to the query.

Query: ${query}

Trajectory:
${historyText}

Extract the final answer from the information gathered above.`;

    return this.callLLM(prompt, undefined, signal);
  }
}

/**
 * Format the call tree for visualization - with ASCII tree hierarchy
 */
export function formatCallTreeVisualization(tree: RLMCallTree): string {
  let output = `\n📊 RLM Call Tree\n`;
  output += `═══════════════════════════════════════════════════\n`;
  output += `Root: "${tree.rootQuery.slice(0, 50)}..."\n`;
  output += `Stats: ${tree.iterations.length} iters | ${tree.totalLLMCalls} llm | ${tree.totalRLMCalls} rlm | depth ${tree.maxDepth}\n`;
  output += `═══════════════════════════════════════════════════\n`;
  
  // Show active running calls first (live) with tree structure
  if (tree.activeCalls && tree.activeCalls.length > 0) {
    output += `\n🔄 ACTIVE (${tree.activeCalls.length}):\n`;
    for (let i = 0; i < tree.activeCalls.length; i++) {
      const call = tree.activeCalls[i];
      const isLast = i === tree.activeCalls.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const icon = call.type === "rlm_query" ? "🔁" : "⚡";
      const elapsed = call.startTime ? Date.now() - call.startTime : 0;
      output += `│\n${prefix}${icon} ${call.type} [running] ${elapsed}ms\n`;
      output += `${isLast ? "    " : "│   "}└── "${call.prompt.slice(0, 60)}..."\n`;
    }
  }
  
  // Show recent completed calls with tree structure
  if (tree.completedCalls && tree.completedCalls.length > 0) {
    output += `\n✓ COMPLETED (last ${Math.min(5, tree.completedCalls.length)}):\n`;
    const recent = tree.completedCalls.slice(-5);
    for (let i = 0; i < recent.length; i++) {
      const call = recent[i];
      const isLast = i === recent.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const icon = call.type === "rlm_query" ? "🔁" : "⚡";
      const statusIcon = call.status === "completed" ? "✓" : "✗";
      const result = call.result?.slice(0, 40) || call.error?.slice(0, 40) || "(empty)";
      output += `│\n${prefix}${icon} ${statusIcon} ${call.type} ${call.duration}ms\n`;
      output += `${isLast ? "    " : "│   "}├── prompt: "${call.prompt.slice(0, 50)}..."\n`;
      output += `${isLast ? "    " : "│   "}└── result: ${result}\n`;
    }
  }
  
  // Show iterations by depth with full tree hierarchy
  const byDepth = new Map<number, RLMTrajectoryStep[]>();
  for (const step of tree.iterations) {
    const depth = step.depth || 0;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(step);
  }
  
  if (byDepth.size > 0) {
    const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
    const maxDepth = depths[depths.length - 1];
    
    output += `\n📍 ITERATIONS BY DEPTH:\n`;
    for (let d = 0; d <= maxDepth; d++) {
      const steps = byDepth.get(d);
      if (!steps || steps.length === 0) continue;
      
      const depthIndent = "  ".repeat(d);
      
      output += `${depthIndent}┌── Depth ${d} (${steps.length} iters)\n`;
      
      // Show last 3 iterations for this depth
      const recentSteps = steps.slice(-3);
      for (let i = 0; i < recentSteps.length; i++) {
        const step = recentSteps[i];
        const isLast = i === recentSteps.length - 1 && d === maxDepth;
        const stepPrefix = isLast ? "└── " : "├── ";
        const stepIndent = depthIndent + (d < maxDepth ? "│  " : "   ");
        
        output += `${stepIndent}${stepPrefix}Iter ${step.iteration}: ${step.reasoning.slice(0, 35)}...\n`;
        
        // Show sub-calls for this iteration
        if (step.subCalls && step.subCalls.length > 0) {
          const callIndent = stepIndent + (isLast ? "    " : "│   ");
          for (let j = 0; j < step.subCalls.length; j++) {
            const call = step.subCalls[j];
            const callIsLast = j === step.subCalls.length - 1;
            const callPrefix = callIsLast ? "└── " : "├── ";
            const icon = call.type === "rlm_query" ? "🔁" : "⚡";
            output += `${callIndent}${callPrefix}${icon} ${call.type} (${call.duration}ms)\n`;
          }
        }
      }
    }
  }
  
  return output;
}

/**
 * Format live status line with minimal info
 */
export function formatLiveStatus(tree: RLMCallTree): string {
  const active = tree.activeCalls?.length || 0;
  const iters = tree.iterations.length;
  
  // Build active calls string
  let activeStr = "";
  if (active > 0 && tree.activeCalls) {
    const calls = tree.activeCalls.map(c => {
      const icon = c.type === "rlm_query" ? "🔁" : "⚡";
      const elapsed = c.startTime ? Date.now() - c.startTime : 0;
      return `${icon}${elapsed}ms`;
    }).join(", ");
    activeStr = ` [${calls}]`;
  }
  
  // Show most recent call if any
  let recentStr = "";
  if (tree.completedCalls && tree.completedCalls.length > 0) {
    const last = tree.completedCalls[tree.completedCalls.length - 1];
    const icon = last.type === "rlm_query" ? "🔁" : "⚡";
    recentStr = ` | ${icon} "${last.prompt.slice(0, 25)}..." → ${last.result?.slice(0, 20) || last.error?.slice(0, 20) || "..."}`;
  }
  
  return `Iter${iters} | llm:${tree.totalLLMCalls} rlm:${tree.totalRLMCalls}${activeStr}${recentStr}`;
}
