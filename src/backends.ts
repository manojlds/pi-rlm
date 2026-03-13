import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  type ExtensionContext
} from "@mariozechner/pi-coding-agent";
import { RlmBackend, RlmToolsProfile } from "./types";
import { parseModelPattern, shellQuote, sleep, toErrorMessage } from "./utils";

export interface CompletionRequest {
  backend: RlmBackend;
  prompt: string;
  cwd: string;
  model?: string;
  toolsProfile: RlmToolsProfile;
  timeoutMs: number;
  signal?: AbortSignal;
  runId?: string;
  nodeId?: string;
  depth?: number;
  stage?: string;
  tmuxUseCurrentSession?: boolean;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const defaultCliFlags = [
  "-p",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes"
];

const tmuxWindowLocks = new Map<string, Promise<void>>();

export async function completeWithBackend(
  request: CompletionRequest,
  ctx: ExtensionContext
): Promise<string> {
  switch (request.backend) {
    case "sdk":
      return completeWithSdk(request, ctx);
    case "cli":
      return completeWithCli(request);
    case "tmux":
      return completeWithTmux(request);
    default:
      return completeWithSdk(request, ctx);
  }
}

function profileToTools(profile: RlmToolsProfile): string {
  if (profile === "read-only") {
    return "read,grep,find,ls";
  }
  return "read,bash,edit,write";
}

async function completeWithSdk(request: CompletionRequest, ctx: ExtensionContext): Promise<string> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => []
  });
  await resourceLoader.reload();

  let model = ctx.model;
  let thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;

  const parsedModel = parseModelPattern(request.model);
  if (parsedModel) {
    const found = ctx.modelRegistry.find(parsedModel.provider, parsedModel.id);
    if (found) {
      model = found;
    }
    thinkingLevel = parsedModel.thinkingLevel;
  }

  const tools =
    request.toolsProfile === "read-only"
      ? createReadOnlyTools(request.cwd)
      : createCodingTools(request.cwd);

  const { session } = await createAgentSession({
    cwd: request.cwd,
    model,
    thinkingLevel,
    tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory()
  });

  let output = "";
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      output += event.assistantMessageEvent.delta;
    }
  });

  const abortHandler = () => {
    void session.abort();
  };

  if (request.signal) {
    request.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await withTimeout(session.prompt(request.prompt), request.timeoutMs, () => {
      void session.abort();
    });
  } finally {
    unsubscribe();
    if (request.signal) {
      request.signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }

  const trimmed = output.trim();
  if (trimmed) return trimmed;

  return extractLastAssistantText(session.messages) || "(no response)";
}

async function completeWithCli(request: CompletionRequest): Promise<string> {
  const args = [...defaultCliFlags, "--tools", profileToTools(request.toolsProfile)];

  if (request.model) {
    args.push("--model", request.model);
  }

  args.push(request.prompt);

  const result = await runProcess("pi", args, {
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    env: {
      ...process.env,
      PI_OFFLINE: "1"
    }
  });

  if (result.code !== 0) {
    throw new Error(`pi subprocess failed (${result.code ?? "unknown"}): ${result.stderr || result.stdout}`);
  }

  const text = result.stdout.trim() || result.stderr.trim();
  return text || "(no response)";
}

async function completeWithTmux(request: CompletionRequest): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const promptPath = join(tmpdir(), `pi-rlm-${stamp}.prompt.txt`);
  const outputPath = join(tmpdir(), `pi-rlm-${stamp}.output.log`);
  const tools = profileToTools(request.toolsProfile);

  await fs.writeFile(promptPath, request.prompt, "utf8");

  const modelPart = request.model ? ` --model ${shellQuote(request.model)}` : "";
  const command = [
    `PROMPT_CONTENT=$(cat ${shellQuote(promptPath)})`,
    `PI_OFFLINE=1 pi ${defaultCliFlags.join(" ")} --tools ${shellQuote(tools)}${modelPart} \"$PROMPT_CONTENT\" > ${shellQuote(outputPath)} 2>&1`
  ].join("; ");

  try {
    if (request.runId && typeof request.depth === "number") {
      const paneId = await startStructuredTmuxCall(request, command);
      const paneState = await waitForTmuxPane(paneId, request.timeoutMs, request.signal);
      if (request.tmuxUseCurrentSession && paneState === "dead") {
        await cleanupCurrentSessionPaneArtifacts(paneId);
      }
    } else {
      await runEphemeralTmuxCall(request, command, stamp);
    }

    const output = await fs.readFile(outputPath, "utf8").catch(() => "");
    return output.trim() || "(no response)";
  } finally {
    await safeUnlink(promptPath);
    await safeUnlink(outputPath);
  }
}

async function startStructuredTmuxCall(
  request: CompletionRequest,
  command: string
): Promise<string> {
  const currentSessionName = request.tmuxUseCurrentSession
    ? await getCurrentTmuxSessionName()
    : undefined;
  const useCurrentSession = Boolean(currentSessionName);

  const sessionName = currentSessionName ?? toTmuxRunSessionName(request.runId!);
  const windowName = toTmuxDepthWindowName(request.depth!, useCurrentSession);

  if (useCurrentSession) {
    const { paneId, windowTarget } = await startPaneInDepthWindow(
      sessionName,
      windowName,
      request.cwd,
      command,
      request.signal
    );

    await setTmuxPaneTitle(paneId, toTmuxPaneTitle(request));
    await setTmuxWindowTiled(windowTarget);
    return paneId;
  }

  const createResult = await runProcess(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-n",
      windowName,
      "-c",
      request.cwd,
      "-P",
      "-F",
      "#{pane_id}",
      command
    ],
    {
      cwd: request.cwd,
      timeoutMs: 10000,
      signal: request.signal
    }
  );

  if (createResult.code === 0) {
    await configureStructuredTmuxSession(sessionName);
    const paneId = createResult.stdout.trim();
    const windowTarget = (await getTmuxWindowIdForPane(paneId)) ?? `${sessionName}:${windowName}`;
    await setTmuxPaneTitle(paneId, toTmuxPaneTitle(request));
    await setTmuxWindowTiled(windowTarget);
    return paneId;
  }

  const createOutput = `${createResult.stderr}\n${createResult.stdout}`;
  if (!isTmuxDuplicateSessionError(createOutput)) {
    throw new Error(`tmux backend failed to start run session: ${createResult.stderr || createResult.stdout}`);
  }

  await configureStructuredTmuxSession(sessionName);
  const { paneId, windowTarget } = await startPaneInDepthWindow(
    sessionName,
    windowName,
    request.cwd,
    command,
    request.signal
  );

  await setTmuxPaneTitle(paneId, toTmuxPaneTitle(request));
  await setTmuxWindowTiled(windowTarget);
  return paneId;
}

async function runEphemeralTmuxCall(
  request: CompletionRequest,
  command: string,
  stamp: string
): Promise<void> {
  const sessionName = `pi-rlm-${stamp}`;

  const startResult = await runProcess(
    "tmux",
    ["new-session", "-d", "-s", sessionName, command],
    {
      cwd: request.cwd,
      timeoutMs: 10000,
      signal: request.signal
    }
  );

  if (startResult.code !== 0) {
    throw new Error(`tmux backend failed to start: ${startResult.stderr || startResult.stdout}`);
  }

  const deadline = Date.now() + request.timeoutMs;

  while (Date.now() < deadline) {
    if (request.signal?.aborted) {
      await killTmuxSession(sessionName);
      throw new Error("RLM request aborted");
    }

    const alive = await hasTmuxSession(sessionName);
    if (!alive) return;
    await sleep(250);
  }

  if (await hasTmuxSession(sessionName)) {
    await killTmuxSession(sessionName);
    throw new Error(`tmux backend timed out after ${request.timeoutMs}ms`);
  }
}

async function configureStructuredTmuxSession(sessionName: string): Promise<void> {
  await runProcess(
    "tmux",
    ["set-window-option", "-g", "-t", sessionName, "remain-on-exit", "on"],
    {
      timeoutMs: 5000
    }
  ).catch(() => undefined);
}

async function withTmuxWindowLock<T>(
  sessionName: string,
  windowName: string,
  worker: () => Promise<T>
): Promise<T> {
  const key = `${sessionName}:${windowName}`;
  const previous = tmuxWindowLocks.get(key) ?? Promise.resolve();

  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous
    .then(() => current)
    .catch(() => current);
  tmuxWindowLocks.set(key, queued);

  await previous;

  try {
    return await worker();
  } finally {
    release?.();
    if (tmuxWindowLocks.get(key) === queued) {
      tmuxWindowLocks.delete(key);
    }
  }
}

async function startPaneInDepthWindow(
  sessionName: string,
  windowName: string,
  cwd: string,
  command: string,
  signal?: AbortSignal
): Promise<{ paneId: string; windowTarget: string }> {
  return withTmuxWindowLock(sessionName, windowName, async () => {
    const existingWindowId = await getTmuxWindowIdByName(sessionName, windowName);

    if (existingWindowId) {
      const splitResult = await runProcess(
        "tmux",
        [
          "split-window",
          "-d",
          "-t",
          existingWindowId,
          "-c",
          cwd,
          "-P",
          "-F",
          "#{pane_id}",
          command
        ],
        {
          cwd,
          timeoutMs: 10000,
          signal
        }
      );

      if (splitResult.code !== 0) {
        throw new Error(`tmux backend failed to create pane: ${splitResult.stderr || splitResult.stdout}`);
      }

      return {
        paneId: splitResult.stdout.trim(),
        windowTarget: existingWindowId
      };
    }

    const createResult = await runProcess(
      "tmux",
      [
        "new-window",
        "-d",
        "-t",
        sessionName,
        "-n",
        windowName,
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
        command
      ],
      {
        cwd,
        timeoutMs: 10000,
        signal
      }
    );

    if (createResult.code === 0) {
      const paneId = createResult.stdout.trim();
      const windowTarget = (await getTmuxWindowIdForPane(paneId)) ?? `${sessionName}:${windowName}`;
      return { paneId, windowTarget };
    }

    const createOutput = `${createResult.stderr}\n${createResult.stdout}`;
    if (isTmuxDuplicateWindowError(createOutput)) {
      const recoveredWindowId = await getTmuxWindowIdByName(sessionName, windowName);
      if (recoveredWindowId) {
        const recoveredSplit = await runProcess(
          "tmux",
          [
            "split-window",
            "-d",
            "-t",
            recoveredWindowId,
            "-c",
            cwd,
            "-P",
            "-F",
            "#{pane_id}",
            command
          ],
          {
            cwd,
            timeoutMs: 10000,
            signal
          }
        );

        if (recoveredSplit.code === 0) {
          return {
            paneId: recoveredSplit.stdout.trim(),
            windowTarget: recoveredWindowId
          };
        }
      }
    }

    throw new Error(`tmux backend failed to create depth window: ${createResult.stderr || createResult.stdout}`);
  });
}

async function getCurrentTmuxSessionName(): Promise<string | undefined> {
  const result = await runProcess("tmux", ["display-message", "-p", "#S"], {
    timeoutMs: 5000,
    env: process.env
  }).catch(() => ({ code: null, stdout: "", stderr: "" }));

  if (!result || result.code !== 0) {
    return undefined;
  }

  const sessionName = result.stdout.trim();
  return sessionName || undefined;
}

async function cleanupCurrentSessionPaneArtifacts(paneId: string): Promise<void> {
  const paneMeta = await getTmuxPaneMetadata(paneId);
  if (!paneMeta) return;

  if (!paneMeta.windowName.startsWith("rlm-depth-")) {
    return;
  }

  await killTmuxPane(paneId);

  const windowPanes = await listTmuxWindowPanes(paneMeta.windowId);
  if (windowPanes.length === 0) {
    return;
  }

  const hasAlivePane = windowPanes.some((pane) => !pane.dead);
  if (!hasAlivePane) {
    await killTmuxWindow(paneMeta.windowId);
  }
}

async function getTmuxPaneMetadata(
  paneId: string
): Promise<{ windowId: string; windowName: string; sessionName: string } | undefined> {
  const result = await runProcess(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{window_id}\t#{window_name}\t#{session_name}"],
    {
      timeoutMs: 5000
    }
  );

  if (result.code !== 0) {
    return undefined;
  }

  const line = result.stdout.trim();
  if (!line) {
    return undefined;
  }

  const [windowId, windowName, sessionName] = line.split("\t");
  if (!windowId || !windowName || !sessionName) {
    return undefined;
  }

  return {
    windowId: windowId.trim(),
    windowName: windowName.trim(),
    sessionName: sessionName.trim()
  };
}

async function listTmuxWindowPanes(
  windowTarget: string
): Promise<Array<{ paneId: string; dead: boolean }>> {
  const result = await runProcess("tmux", ["list-panes", "-t", windowTarget, "-F", "#{pane_id}\t#{pane_dead}"], {
    timeoutMs: 5000
  });

  if (result.code !== 0) {
    return [];
  }

  const panes: Array<{ paneId: string; dead: boolean }> = [];

  for (const entry of result.stdout.split("\n")) {
    const line = entry.trim();
    if (!line) continue;

    const [paneId, deadFlag] = line.split("\t");
    if (!paneId) continue;

    panes.push({
      paneId: paneId.trim(),
      dead: deadFlag?.trim() === "1"
    });
  }

  return panes;
}

async function waitForTmuxPane(
  paneId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<"missing" | "dead"> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await killTmuxPane(paneId);
      throw new Error("RLM request aborted");
    }

    const paneState = await getTmuxPaneState(paneId);
    if (paneState === "missing" || paneState === "dead") {
      return paneState;
    }

    await sleep(250);
  }

  await killTmuxPane(paneId);
  throw new Error(`tmux backend timed out after ${timeoutMs}ms`);
}

async function getTmuxPaneState(paneId: string): Promise<"alive" | "dead" | "missing"> {
  const result = await runProcess("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"], {
    timeoutMs: 5000
  });

  if (result.code !== 0) {
    return "missing";
  }

  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${paneId} `));

  if (!line) {
    return "missing";
  }

  const deadFlag = line.slice(paneId.length + 1).trim();
  return deadFlag === "1" ? "dead" : "alive";
}

async function getTmuxWindowIdByName(
  sessionName: string,
  windowName: string
): Promise<string | undefined> {
  const result = await runProcess(
    "tmux",
    ["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{window_name}"],
    {
      timeoutMs: 5000
    }
  );

  if (result.code !== 0) {
    return undefined;
  }

  for (const entry of result.stdout.split("\n")) {
    const line = entry.trim();
    if (!line) continue;

    const [windowId, ...nameParts] = line.split("\t");
    if (!windowId) continue;

    const currentName = nameParts.join("\t").trim();
    if (currentName === windowName) {
      return windowId;
    }
  }

  return undefined;
}

async function getTmuxWindowIdForPane(paneId: string): Promise<string | undefined> {
  if (!paneId) return undefined;

  const result = await runProcess("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
    timeoutMs: 5000
  });

  if (result.code !== 0) {
    return undefined;
  }

  const windowId = result.stdout.trim();
  return windowId || undefined;
}

async function setTmuxPaneTitle(paneId: string, paneTitle: string): Promise<void> {
  if (!paneId) return;

  await runProcess("tmux", ["select-pane", "-t", paneId, "-T", paneTitle], {
    timeoutMs: 5000
  }).catch(() => undefined);
}

async function setTmuxWindowTiled(windowTarget: string): Promise<void> {
  await runProcess("tmux", ["select-layout", "-t", windowTarget, "tiled"], {
    timeoutMs: 5000
  }).catch(() => undefined);
}

async function killTmuxPane(paneId: string): Promise<void> {
  await runProcess("tmux", ["kill-pane", "-t", paneId], {
    timeoutMs: 5000
  }).catch(() => undefined);
}

async function killTmuxWindow(windowTarget: string): Promise<void> {
  await runProcess("tmux", ["kill-window", "-t", windowTarget], {
    timeoutMs: 5000
  }).catch(() => undefined);
}

function toTmuxRunSessionName(runId: string): string {
  const sanitized = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `pi-rlm-${sanitized}`.slice(0, 48);
}

function toTmuxDepthWindowName(depth: number, useCurrentSession: boolean): string {
  return useCurrentSession ? `rlm-depth-${depth}` : `depth-${depth}`;
}

function toTmuxPaneTitle(request: CompletionRequest): string {
  const node = request.nodeId ?? "root";
  const stage = request.stage ?? "call";
  const depth = typeof request.depth === "number" ? `d${request.depth}` : "dx";
  return `${depth}:${node}:${stage}`.slice(0, 64);
}

function isTmuxDuplicateSessionError(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("duplicate session") || normalized.includes("session already exists");
}

function isTmuxDuplicateWindowError(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("duplicate window") || normalized.includes("window already exists");
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;

    const text = message.content
      .filter((chunk): chunk is { type: string; text?: string } =>
        typeof chunk === "object" && chunk !== null && "type" in chunk
      )
      .filter((chunk) => chunk.type === "text" && typeof chunk.text === "string")
      .map((chunk) => chunk.text as string)
      .join("")
      .trim();

    if (text) return text;
  }

  return "";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hasTmuxSession(sessionName: string): Promise<boolean> {
  const result = await runProcess("tmux", ["has-session", "-t", sessionName], {
    timeoutMs: 5000
  });
  return result.code === 0;
}

async function killTmuxSession(sessionName: string): Promise<void> {
  await runProcess("tmux", ["kill-session", "-t", sessionName], {
    timeoutMs: 5000
  }).catch(() => undefined);
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // ignore
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      fn();
    };

    const abortHandler = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(() => reject(new Error("Process aborted")));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        finish(() => reject(new Error(`Process timed out after ${options.timeoutMs}ms`)));
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(new Error(`Failed to execute '${command}': ${toErrorMessage(error)}`)));
    });

    child.on("close", (code) => {
      finish(() => resolve({ code, stdout, stderr }));
    });
  });
}
