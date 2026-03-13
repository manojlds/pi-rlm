#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

type RlmBackend = "sdk" | "cli" | "tmux";
type RlmMode = "auto" | "solve" | "decompose";
type RlmToolsProfile = "coding" | "read-only";

interface CliOptions {
  backend: RlmBackend;
  mode: RlmMode;
  cwd: string;
  toolsProfile: RlmToolsProfile;
  maxDepth: number;
  maxNodes: number;
  maxBranching: number;
  concurrency: number;
  timeoutMs: number;
  json: boolean;
  live: boolean;
  liveRefreshMs: number;
  piBin: string;
  tmuxUseCurrentSession: boolean;
  task: string;
  help: boolean;
  version: boolean;
  model?: string;
}

interface ToolStartParams {
  op: "start";
  task: string;
  backend: RlmBackend;
  mode: RlmMode;
  cwd: string;
  toolsProfile: RlmToolsProfile;
  maxDepth: number;
  maxNodes: number;
  maxBranching: number;
  concurrency: number;
  timeoutMs: number;
  async: false;
  tmuxUseCurrentSession: boolean;
  model?: string;
}

type JsonRecord = Record<string, any>;

type ToolContent = { type?: string; text?: string };

interface ToolResultPayload {
  content?: ToolContent[];
  details?: JsonRecord;
  [key: string]: any;
}

interface RunResult {
  code: number | null;
  stderr: string;
  toolResult?: ToolResultPayload;
  toolError: boolean;
  toolArgsMatch: boolean;
}

interface LiveNode {
  id: string;
  depth: number;
  task: string;
  status: string;
  action?: string;
  reason?: string;
  error?: string;
  parentId?: string;
  children: string[];
  order: number;
}

interface LiveRunMeta {
  backend?: string;
  mode?: string;
  maxDepth?: number;
  maxNodes?: number;
  maxBranching?: number;
  concurrency?: number;
}

interface LiveRunEnd {
  durationMs?: number;
  nodesVisited?: number;
  maxDepthSeen?: number;
  finalChars?: number;
}

interface LiveMonitor {
  refreshMs: number;
  runId?: string;
  eventsPath?: string;
  offset: number;
  remainder: string;
  polling: boolean;
  timer?: NodeJS.Timeout;
  nodes: Map<string, LiveNode>;
  nextOrder: number;
  runMeta?: LiveRunMeta;
  runEnd?: LiveRunEnd;
  toolError: boolean;
  lastFrame: string;
}

const defaults: Omit<CliOptions, "task" | "help" | "version" | "model"> = {
  backend: "sdk",
  mode: "auto",
  cwd: process.cwd(),
  toolsProfile: "coding",
  maxDepth: 2,
  maxNodes: 24,
  maxBranching: 3,
  concurrency: 2,
  timeoutMs: 180000,
  json: false,
  live: false,
  liveRefreshMs: 250,
  piBin: "pi",
  tmuxUseCurrentSession: false
};

const allowedBackends = new Set<RlmBackend>(["sdk", "cli", "tmux"]);
const allowedModes = new Set<RlmMode>(["auto", "solve", "decompose"]);
const allowedProfiles = new Set<RlmToolsProfile>(["coding", "read-only"]);

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.help) {
      printHelp();
      process.exit(0);
    }

    if (opts.version) {
      process.stdout.write("pi-rlm-cli/0.1.0\n");
      process.exit(0);
    }

    if (!opts.task || !opts.task.trim()) {
      fail('Missing task. Pass --task "..." or a positional task string.');
    }

    if (opts.live && opts.json) {
      fail("--live and --json cannot be used together.");
    }

    if (opts.live && !process.stdout.isTTY) {
      fail("--live requires a TTY terminal.");
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const extensionPath = resolve(__dirname, "..", "index.ts");

    const toolParams: ToolStartParams = {
      op: "start",
      task: opts.task,
      backend: opts.backend,
      mode: opts.mode,
      cwd: opts.cwd,
      toolsProfile: opts.toolsProfile,
      maxDepth: opts.maxDepth,
      maxNodes: opts.maxNodes,
      maxBranching: opts.maxBranching,
      concurrency: opts.concurrency,
      timeoutMs: opts.timeoutMs,
      async: false,
      tmuxUseCurrentSession: opts.tmuxUseCurrentSession,
      ...(opts.model ? { model: opts.model } : {})
    };

    const prompt = createPrompt(toolParams);
    const args = createPiArgs(extensionPath, prompt);

    const run: RunResult = opts.live
      ? await runPiLive(opts.piBin, args, toolParams, opts.liveRefreshMs)
      : await runPi(opts.piBin, args, toolParams);

    if (!run.toolResult) {
      const stderr = run.stderr.trim();
      if (stderr) {
        fail(`Failed to capture rlm tool result.\n${stderr}`);
      }
      fail("Failed to capture rlm tool result.");
    }

    if (!run.toolArgsMatch) {
      fail("The underlying pi agent did not execute rlm with the exact requested arguments.");
    }

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: !run.toolError,
            params: toolParams,
            result: run.toolResult
          },
          null,
          2
        )}\n`
      );
    } else {
      if (opts.live) {
        process.stdout.write("\n");
      }

      const text = extractText(run.toolResult.content);
      if (text) {
        process.stdout.write(`${text}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(run.toolResult, null, 2)}\n`);
      }
    }

    const failed = run.toolError || run.code !== 0;
    process.exit(failed ? 1 : 0);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function createPrompt(toolParams: ToolStartParams): string {
  return [
    "You MUST call the rlm tool exactly once using these exact arguments.",
    "Do not modify any value. Do not call any other tool.",
    "After the tool call, respond with exactly: __PI_RLM_DONE__",
    "Arguments JSON:",
    JSON.stringify(toolParams)
  ].join("\n");
}

function createPiArgs(extensionPath: string, prompt: string): string[] {
  return [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-tools",
    "-e",
    extensionPath,
    "--mode",
    "json",
    prompt
  ];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    ...defaults,
    task: "",
    help: false,
    version: false
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      opts.version = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--live") {
      opts.live = true;
      continue;
    }
    if (arg === "--tmux-current-session") {
      opts.tmuxUseCurrentSession = true;
      continue;
    }

    if (arg === "--task") {
      opts.task = expectValue(argv, ++i, "--task");
      continue;
    }
    if (arg.startsWith("--task=")) {
      opts.task = arg.slice("--task=".length);
      continue;
    }

    if (arg === "--backend") {
      opts.backend = expectValue(argv, ++i, "--backend") as RlmBackend;
      continue;
    }
    if (arg.startsWith("--backend=")) {
      opts.backend = arg.slice("--backend=".length) as RlmBackend;
      continue;
    }

    if (arg === "--mode") {
      opts.mode = expectValue(argv, ++i, "--mode") as RlmMode;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      opts.mode = arg.slice("--mode=".length) as RlmMode;
      continue;
    }

    if (arg === "--model") {
      opts.model = expectValue(argv, ++i, "--model");
      continue;
    }
    if (arg.startsWith("--model=")) {
      opts.model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--cwd") {
      opts.cwd = expectValue(argv, ++i, "--cwd");
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      opts.cwd = arg.slice("--cwd=".length);
      continue;
    }

    if (arg === "--tools-profile") {
      opts.toolsProfile = expectValue(argv, ++i, "--tools-profile") as RlmToolsProfile;
      continue;
    }
    if (arg.startsWith("--tools-profile=")) {
      opts.toolsProfile = arg.slice("--tools-profile=".length) as RlmToolsProfile;
      continue;
    }

    if (arg === "--max-depth") {
      opts.maxDepth = parseIntArg(expectValue(argv, ++i, "--max-depth"), "--max-depth");
      continue;
    }
    if (arg.startsWith("--max-depth=")) {
      opts.maxDepth = parseIntArg(arg.slice("--max-depth=".length), "--max-depth");
      continue;
    }

    if (arg === "--max-nodes") {
      opts.maxNodes = parseIntArg(expectValue(argv, ++i, "--max-nodes"), "--max-nodes");
      continue;
    }
    if (arg.startsWith("--max-nodes=")) {
      opts.maxNodes = parseIntArg(arg.slice("--max-nodes=".length), "--max-nodes");
      continue;
    }

    if (arg === "--max-branching") {
      opts.maxBranching = parseIntArg(expectValue(argv, ++i, "--max-branching"), "--max-branching");
      continue;
    }
    if (arg.startsWith("--max-branching=")) {
      opts.maxBranching = parseIntArg(arg.slice("--max-branching=".length), "--max-branching");
      continue;
    }

    if (arg === "--concurrency") {
      opts.concurrency = parseIntArg(expectValue(argv, ++i, "--concurrency"), "--concurrency");
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      opts.concurrency = parseIntArg(arg.slice("--concurrency=".length), "--concurrency");
      continue;
    }

    if (arg === "--timeout-ms") {
      opts.timeoutMs = parseIntArg(expectValue(argv, ++i, "--timeout-ms"), "--timeout-ms");
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      opts.timeoutMs = parseIntArg(arg.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }

    if (arg === "--live-refresh-ms") {
      opts.liveRefreshMs = parseIntArg(expectValue(argv, ++i, "--live-refresh-ms"), "--live-refresh-ms");
      continue;
    }
    if (arg.startsWith("--live-refresh-ms=")) {
      opts.liveRefreshMs = parseIntArg(
        arg.slice("--live-refresh-ms=".length),
        "--live-refresh-ms"
      );
      continue;
    }

    if (arg === "--pi-bin") {
      opts.piBin = expectValue(argv, ++i, "--pi-bin");
      continue;
    }
    if (arg.startsWith("--pi-bin=")) {
      opts.piBin = arg.slice("--pi-bin=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      fail(`Unknown argument: ${arg}`);
    }

    positional.push(arg);
  }

  if (!opts.task && positional.length > 0) {
    opts.task = positional.join(" ");
  }

  if (!allowedBackends.has(opts.backend)) {
    fail(`Invalid --backend '${opts.backend}'. Expected one of: sdk, cli, tmux`);
  }
  if (!allowedModes.has(opts.mode)) {
    fail(`Invalid --mode '${opts.mode}'. Expected one of: auto, solve, decompose`);
  }
  if (!allowedProfiles.has(opts.toolsProfile)) {
    fail(`Invalid --tools-profile '${opts.toolsProfile}'. Expected one of: coding, read-only`);
  }

  ensureRange(opts.maxDepth, 0, 8, "--max-depth");
  ensureRange(opts.maxNodes, 1, 300, "--max-nodes");
  ensureRange(opts.maxBranching, 1, 8, "--max-branching");
  ensureRange(opts.concurrency, 1, 8, "--concurrency");
  ensureRange(opts.timeoutMs, 1000, 3600000, "--timeout-ms");
  ensureRange(opts.liveRefreshMs, 100, 5000, "--live-refresh-ms");

  return opts;
}

function expectValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function parseIntArg(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    fail(`Invalid integer for ${flag}: '${value}'`);
  }
  return parsed;
}

function ensureRange(value: number, min: number, max: number, flag: string): void {
  if (value < min || value > max) {
    fail(`Invalid ${flag} value '${value}'. Expected ${min}..${max}.`);
  }
}

async function runPi(command: string, args: string[], expectedToolParams: ToolStartParams): Promise<RunResult> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  const state: Omit<RunResult, "code"> = {
    stderr: "",
    toolResult: undefined,
    toolError: false,
    toolArgsMatch: false
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line: string) => {
    const event = parseJsonLine(line);
    if (!event) return;

    if (event.type === "tool_execution_start" && event.toolName === "rlm") {
      state.toolArgsMatch = deepEqual(event.args, expectedToolParams);
    }

    if (event.type === "tool_execution_end" && event.toolName === "rlm" && event.result) {
      state.toolResult = event.result as ToolResultPayload;
      state.toolError = Boolean(event.isError);
    }
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    state.stderr += chunk.toString();
  });

  const code = await waitForChild(child);
  rl.close();

  return {
    code,
    ...state
  };
}

async function runPiLive(
  command: string,
  args: string[],
  expectedToolParams: ToolStartParams,
  refreshMs: number
): Promise<RunResult> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  const state: Omit<RunResult, "code"> & { runId?: string; liveMonitor: LiveMonitor } = {
    stderr: "",
    toolResult: undefined,
    toolError: false,
    toolArgsMatch: false,
    runId: undefined,
    liveMonitor: createLiveMonitor(refreshMs)
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line: string) => {
    const event = parseJsonLine(line);
    if (!event) return;

    if (event.type === "tool_execution_start" && event.toolName === "rlm") {
      state.toolArgsMatch = deepEqual(event.args, expectedToolParams);
    }

    if (event.type === "tool_execution_update" && event.toolName === "rlm") {
      const runIdFromUpdate = extractRunIdFromUpdateEvent(event);
      if (!state.runId && runIdFromUpdate) {
        state.runId = runIdFromUpdate;
        startLiveMonitor(state.liveMonitor, runIdFromUpdate);
      }
    }

    if (event.type === "tool_execution_end" && event.toolName === "rlm" && event.result) {
      state.toolResult = event.result as ToolResultPayload;
      state.toolError = Boolean(event.isError);
      state.liveMonitor.toolError = state.toolError;

      if (!state.runId) {
        const runIdFromResult = extractRunIdFromToolResult(event.result as ToolResultPayload);
        if (runIdFromResult) {
          state.runId = runIdFromResult;
          startLiveMonitor(state.liveMonitor, runIdFromResult);
        }
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    state.stderr += chunk.toString();
  });

  const code = await waitForChild(child);
  rl.close();
  await stopLiveMonitor(state.liveMonitor);

  return {
    code,
    stderr: state.stderr,
    toolResult: state.toolResult,
    toolError: state.toolError,
    toolArgsMatch: state.toolArgsMatch
  };
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function parseJsonLine(line: string): JsonRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function extractRunIdFromUpdateEvent(event: JsonRecord): string | undefined {
  const partialResult = isRecord(event.partialResult) ? event.partialResult : undefined;
  const text = extractText(partialResult?.content as ToolContent[] | undefined);
  if (!text) return undefined;

  const match = text.match(/RLM run\s+([a-f0-9]{8})\s+started/i);
  return match?.[1];
}

function extractRunIdFromToolResult(result: ToolResultPayload): string | undefined {
  const details = isRecord(result?.details) ? result.details : undefined;
  if (typeof details?.run_id === "string") {
    return details.run_id;
  }

  const text = extractText(result?.content);
  if (!text) return undefined;

  const match = text.match(/run_id:\s*([a-f0-9]{8})/i);
  return match?.[1];
}

function createLiveMonitor(refreshMs: number): LiveMonitor {
  return {
    refreshMs,
    runId: undefined,
    eventsPath: undefined,
    offset: 0,
    remainder: "",
    polling: false,
    timer: undefined,
    nodes: new Map(),
    nextOrder: 1,
    runMeta: undefined,
    runEnd: undefined,
    toolError: false,
    lastFrame: ""
  };
}

function startLiveMonitor(monitor: LiveMonitor, runId: string): void {
  if (monitor.timer) return;

  monitor.runId = runId;
  monitor.eventsPath = join(tmpdir(), "pi-rlm-runs", runId, "events.jsonl");

  renderLiveMonitor(monitor, true);
  void pollLiveEvents(monitor);

  monitor.timer = setInterval(() => {
    void pollLiveEvents(monitor);
  }, monitor.refreshMs);
}

async function stopLiveMonitor(monitor: LiveMonitor): Promise<void> {
  if (monitor.timer) {
    clearInterval(monitor.timer);
    monitor.timer = undefined;
  }

  await pollLiveEvents(monitor);
  renderLiveMonitor(monitor, true);
}

async function pollLiveEvents(monitor: LiveMonitor): Promise<void> {
  if (!monitor.eventsPath || monitor.polling) return;

  monitor.polling = true;

  try {
    let stat;
    try {
      stat = await fs.stat(monitor.eventsPath);
    } catch {
      return;
    }

    if (stat.size < monitor.offset) {
      monitor.offset = 0;
      monitor.remainder = "";
    }

    if (stat.size === monitor.offset) {
      return;
    }

    const length = stat.size - monitor.offset;
    const handle = await fs.open(monitor.eventsPath, "r");
    let chunk = "";

    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, monitor.offset);
      monitor.offset = stat.size;
      chunk = buffer.toString("utf8");
    } finally {
      await handle.close();
    }

    applyLiveChunk(monitor, chunk);
    renderLiveMonitor(monitor);
  } finally {
    monitor.polling = false;
  }
}

function applyLiveChunk(monitor: LiveMonitor, chunk: string): void {
  const data = `${monitor.remainder}${chunk}`;
  const lines = data.split("\n");
  monitor.remainder = lines.pop() ?? "";

  for (const line of lines) {
    const event = parseJsonLine(line);
    if (!event) continue;
    applyLiveEvent(monitor, event);
  }
}

function applyLiveEvent(monitor: LiveMonitor, event: JsonRecord): void {
  if (event.type === "run_start") {
    monitor.runMeta = {
      backend: asString(event.backend),
      mode: asString(event.mode),
      maxDepth: asNumber(event.maxDepth),
      maxNodes: asNumber(event.maxNodes),
      maxBranching: asNumber(event.maxBranching),
      concurrency: asNumber(event.concurrency)
    };
    return;
  }

  if (event.type === "run_end") {
    monitor.runEnd = {
      durationMs: asNumber(event.durationMs),
      nodesVisited: asNumber(event.nodesVisited),
      maxDepthSeen: asNumber(event.maxDepthSeen),
      finalChars: asNumber(event.finalChars)
    };
    return;
  }

  const nodeId = asString(event.nodeId);
  if (!nodeId) {
    return;
  }

  const node = getOrCreateLiveNode(monitor, nodeId);

  const depth = asNumber(event.depth);
  if (typeof depth === "number") {
    node.depth = depth;
  }

  const task = asString(event.task);
  if (task) {
    node.task = task;
  }

  if (Object.prototype.hasOwnProperty.call(event, "parentId")) {
    linkLiveParent(monitor, node, normalizeParentId(event.parentId));
  }

  switch (event.type) {
    case "node_start":
      node.status = "running";
      break;
    case "node_decompose":
      node.action = "decompose";
      if (typeof event.reason === "string") node.reason = event.reason;
      break;
    case "node_end":
      node.status = "completed";
      if (typeof event.action === "string") node.action = event.action;
      if (typeof event.reason === "string") node.reason = event.reason;
      break;
    case "node_cancelled":
      node.status = "cancelled";
      if (typeof event.error === "string") {
        node.error = event.error;
        node.reason = node.reason || event.error;
      }
      break;
    case "node_error":
      node.status = "failed";
      if (typeof event.error === "string") {
        node.error = event.error;
      }
      break;
    case "node_skipped":
      node.status = "cancelled";
      if (typeof event.reason === "string") {
        node.reason = event.reason;
      }
      break;
    default:
      break;
  }
}

function getOrCreateLiveNode(monitor: LiveMonitor, nodeId: string): LiveNode {
  let node = monitor.nodes.get(nodeId);
  if (node) return node;

  node = {
    id: nodeId,
    depth: 0,
    task: "",
    status: "pending",
    action: undefined,
    reason: undefined,
    error: undefined,
    parentId: undefined,
    children: [],
    order: monitor.nextOrder++
  };

  monitor.nodes.set(nodeId, node);
  return node;
}

function normalizeParentId(parentId: unknown): string | undefined {
  if (parentId === null || parentId === undefined) return undefined;
  return String(parentId);
}

function linkLiveParent(monitor: LiveMonitor, node: LiveNode, parentId: string | undefined): void {
  if (node.parentId === parentId) return;

  if (node.parentId) {
    const previousParent = monitor.nodes.get(node.parentId);
    if (previousParent) {
      previousParent.children = previousParent.children.filter((childId) => childId !== node.id);
    }
  }

  node.parentId = parentId;

  if (!parentId) return;

  const parent = getOrCreateLiveNode(monitor, parentId);
  if (!parent.children.includes(node.id)) {
    parent.children.push(node.id);
  }
}

function renderLiveMonitor(monitor: LiveMonitor, force = false): void {
  const frame = buildLiveFrame(monitor);
  if (!force && frame === monitor.lastFrame) return;

  monitor.lastFrame = frame;
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(frame);
}

function buildLiveFrame(monitor: LiveMonitor): string {
  const lines: string[] = [];

  lines.push(`pi-rlm live tree | run_id: ${monitor.runId ?? "(waiting...)"}`);

  if (monitor.runMeta) {
    lines.push(
      `backend=${monitor.runMeta.backend} mode=${monitor.runMeta.mode} depth<=${monitor.runMeta.maxDepth} nodes<=${monitor.runMeta.maxNodes}`
    );
  }

  if (monitor.runEnd) {
    const finalStatus = monitor.toolError ? "failed" : "completed";
    lines.push(
      `status=${finalStatus} nodes=${monitor.runEnd.nodesVisited} maxDepthSeen=${monitor.runEnd.maxDepthSeen} durationMs=${monitor.runEnd.durationMs}`
    );
  } else {
    lines.push(`status=running observed_nodes=${monitor.nodes.size}`);
  }

  lines.push("");

  const roots = Array.from(monitor.nodes.values())
    .filter((node) => !node.parentId)
    .sort((a, b) => a.order - b.order);

  if (roots.length === 0) {
    lines.push("(waiting for node events...)");
    lines.push("\nLegend: [status] (action) task");
    return `${lines.join("\n")}\n`;
  }

  const visited = new Set<string>();
  roots.forEach((root, idx) => {
    renderLiveNode(monitor, root.id, "", idx === roots.length - 1, visited, lines);
  });

  lines.push("");
  lines.push("Legend: [status] (action) task");
  return `${lines.join("\n")}\n`;
}

function renderLiveNode(
  monitor: LiveMonitor,
  nodeId: string,
  prefix: string,
  isLast: boolean,
  visited: Set<string>,
  lines: string[]
): void {
  const node = monitor.nodes.get(nodeId);
  if (!node) return;

  const connector = isLast ? "└─" : "├─";
  const action = node.action ? ` (${node.action})` : "";
  const line = `${prefix}${connector} ${node.id} [d=${node.depth}] [${node.status}]${action} ${short(node.task || "(task pending)", 90)}`;
  lines.push(line);

  const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;

  if (node.reason) {
    lines.push(`${childPrefix}reason: ${short(node.reason, 76)}`);
  }
  if (node.error && node.error !== node.reason) {
    lines.push(`${childPrefix}error: ${short(node.error, 76)}`);
  }

  if (visited.has(node.id)) {
    lines.push(`${childPrefix}(cycle detected in live event graph)`);
    return;
  }

  visited.add(node.id);
  const children = node.children
    .map((childId) => monitor.nodes.get(childId))
    .filter((child): child is LiveNode => Boolean(child))
    .sort((a, b) => a.order - b.order);

  children.forEach((child, idx) => {
    renderLiveNode(monitor, child.id, childPrefix, idx === children.length - 1, visited, lines);
  });
  visited.delete(node.id);
}

function short(value: string, maxChars = 80): string {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function extractText(content: ToolContent[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i += 1) {
      if (!deepEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }

  const objA = a as JsonRecord;
  const objB = b as JsonRecord;

  const aKeys = Object.keys(objA);
  const bKeys = Object.keys(objB);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqual(objA[key], objB[key])) return false;
  }

  return true;
}

function printHelp(): void {
  process.stdout.write("pi-rlm - run Recursive Language Model tasks directly\n\n");
  process.stdout.write("Usage:\n");
  process.stdout.write("  pi-rlm --task \"Analyze src architecture\" [options]\n");
  process.stdout.write("  pi-rlm \"Analyze src architecture\" [options]\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --backend <sdk|cli|tmux>      Backend for subcalls (default: sdk)\n");
  process.stdout.write("  --mode <auto|solve|decompose> Recursion mode (default: auto)\n");
  process.stdout.write("  --model <provider/model[:thinking]>  Optional model override\n");
  process.stdout.write("  --cwd <path>                  Working directory for subcalls (default: current dir)\n");
  process.stdout.write("  --tools-profile <coding|read-only>   Tool profile (default: coding)\n");
  process.stdout.write("  --max-depth <n>               Max recursion depth (default: 2)\n");
  process.stdout.write("  --max-nodes <n>               Max total nodes (default: 24)\n");
  process.stdout.write("  --max-branching <n>           Max subtasks per decomposition (default: 3)\n");
  process.stdout.write("  --concurrency <n>             Child concurrency (default: 2)\n");
  process.stdout.write("  --timeout-ms <n>              Timeout per model call (default: 180000)\n");
  process.stdout.write("  --live                        Show live tree visualization (TTY only)\n");
  process.stdout.write("  --live-refresh-ms <n>         Live refresh interval in ms (default: 250)\n");
  process.stdout.write("  --tmux-current-session        For backend=tmux, use current tmux session windows\n");
  process.stdout.write("  --json                        Print machine-readable JSON\n");
  process.stdout.write("  --pi-bin <path>               Override pi binary path (default: pi)\n");
  process.stdout.write("  -h, --help                    Show help\n");
  process.stdout.write("  -v, --version                 Show version\n\n");
  process.stdout.write("Notes:\n");
  process.stdout.write("  - This wrapper runs a single synchronous rlm start operation.\n");
  process.stdout.write("  - It shells out to the installed 'pi' CLI and loads this extension.\n");
  process.stdout.write("  - --live reads /tmp/pi-rlm-runs/<runId>/events.jsonl for real-time tree updates.\n");
}

function fail(message: string): never {
  process.stderr.write(`pi-rlm: ${message}\n`);
  process.exit(1);
}

void main();
