#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const defaults = {
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
  piBin: "pi"
};

const allowedBackends = new Set(["sdk", "cli", "tmux"]);
const allowedModes = new Set(["auto", "solve", "decompose"]);
const allowedProfiles = new Set(["coding", "read-only"]);

async function main() {
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
      fail("Missing task. Pass --task \"...\" or a positional task string.");
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const extensionPath = resolve(__dirname, "..", "index.ts");

    const toolParams = {
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
      ...(opts.model ? { model: opts.model } : {})
    };

    const prompt = [
      "You MUST call the rlm tool exactly once using these exact arguments.",
      "Do not modify any value. Do not call any other tool.",
      "After the tool call, respond with exactly: __PI_RLM_DONE__",
      "Arguments JSON:",
      JSON.stringify(toolParams)
    ].join("\n");

    const args = [
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

    const run = await runPi(opts.piBin, args, toolParams);

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
      const text = extractText(run.toolResult.content);
      if (text) {
        process.stdout.write(`${text}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(run.toolResult, null, 2)}\n`);
      }
    }

    process.exit(run.toolError ? 1 : 0);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseArgs(argv) {
  const opts = { ...defaults, task: "", help: false, version: false };
  const positional = [];

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

    if (arg === "--task") {
      opts.task = expectValue(argv, ++i, "--task");
      continue;
    }
    if (arg.startsWith("--task=")) {
      opts.task = arg.slice("--task=".length);
      continue;
    }

    if (arg === "--backend") {
      opts.backend = expectValue(argv, ++i, "--backend");
      continue;
    }
    if (arg.startsWith("--backend=")) {
      opts.backend = arg.slice("--backend=".length);
      continue;
    }

    if (arg === "--mode") {
      opts.mode = expectValue(argv, ++i, "--mode");
      continue;
    }
    if (arg.startsWith("--mode=")) {
      opts.mode = arg.slice("--mode=".length);
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
      opts.toolsProfile = expectValue(argv, ++i, "--tools-profile");
      continue;
    }
    if (arg.startsWith("--tools-profile=")) {
      opts.toolsProfile = arg.slice("--tools-profile=".length);
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

  return opts;
}

function expectValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function parseIntArg(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    fail(`Invalid integer for ${flag}: '${value}'`);
  }
  return parsed;
}

function ensureRange(value, min, max, flag) {
  if (value < min || value > max) {
    fail(`Invalid ${flag} value '${value}'. Expected ${min}..${max}.`);
  }
}

async function runPi(command, args, expectedToolParams) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  let stderr = "";
  let toolResult = undefined;
  let toolError = false;
  let toolArgsMatch = false;

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (parsed && parsed.type === "tool_execution_start" && parsed.toolName === "rlm") {
      toolArgsMatch = deepEqual(parsed.args, expectedToolParams);
    }

    if (
      parsed &&
      parsed.type === "tool_execution_end" &&
      parsed.toolName === "rlm" &&
      parsed.result
    ) {
      toolResult = parsed.result;
      toolError = Boolean(parsed.isError);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  rl.close();

  return {
    code,
    stderr,
    toolResult,
    toolError,
    toolArgsMatch
  };
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;

  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }

  return true;
}

function printHelp() {
  process.stdout.write(`pi-rlm - run Recursive Language Model tasks directly\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  pi-rlm --task "Analyze src architecture" [options]\n`);
  process.stdout.write(`  pi-rlm "Analyze src architecture" [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --backend <sdk|cli|tmux>      Backend for subcalls (default: sdk)\n`);
  process.stdout.write(`  --mode <auto|solve|decompose> Recursion mode (default: auto)\n`);
  process.stdout.write(`  --model <provider/model[:thinking]>  Optional model override\n`);
  process.stdout.write(`  --cwd <path>                  Working directory for subcalls (default: current dir)\n`);
  process.stdout.write(`  --tools-profile <coding|read-only>   Tool profile (default: coding)\n`);
  process.stdout.write(`  --max-depth <n>               Max recursion depth (default: 2)\n`);
  process.stdout.write(`  --max-nodes <n>               Max total nodes (default: 24)\n`);
  process.stdout.write(`  --max-branching <n>           Max subtasks per decomposition (default: 3)\n`);
  process.stdout.write(`  --concurrency <n>             Child concurrency (default: 2)\n`);
  process.stdout.write(`  --timeout-ms <n>              Timeout per model call (default: 180000)\n`);
  process.stdout.write(`  --json                        Print machine-readable JSON\n`);
  process.stdout.write(`  --pi-bin <path>               Override pi binary path (default: pi)\n`);
  process.stdout.write(`  -h, --help                    Show help\n`);
  process.stdout.write(`  -v, --version                 Show version\n\n`);
  process.stdout.write(`Notes:\n`);
  process.stdout.write(`  - This wrapper runs a single synchronous rlm start operation.\n`);
  process.stdout.write(`  - It shells out to the installed 'pi' CLI and loads this extension.\n`);
}

function fail(message) {
  process.stderr.write(`pi-rlm: ${message}\n`);
  process.exit(1);
}

void main();
