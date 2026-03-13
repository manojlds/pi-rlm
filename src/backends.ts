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
  const sessionName = `pi-rlm-${stamp}`;
  const tools = profileToTools(request.toolsProfile);

  await fs.writeFile(promptPath, request.prompt, "utf8");

  const modelPart = request.model ? ` --model ${shellQuote(request.model)}` : "";
  const command = [
    `PROMPT_CONTENT=$(cat ${shellQuote(promptPath)})`,
    `PI_OFFLINE=1 pi ${defaultCliFlags.join(" ")} --tools ${shellQuote(tools)}${modelPart} \"$PROMPT_CONTENT\" > ${shellQuote(outputPath)} 2>&1`
  ].join("; ");

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
    await safeUnlink(promptPath);
    throw new Error(`tmux backend failed to start: ${startResult.stderr || startResult.stdout}`);
  }

  const deadline = Date.now() + request.timeoutMs;

  try {
    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        await killTmuxSession(sessionName);
        throw new Error("RLM request aborted");
      }

      const alive = await hasTmuxSession(sessionName);
      if (!alive) break;
      await sleep(250);
    }

    if (await hasTmuxSession(sessionName)) {
      await killTmuxSession(sessionName);
      throw new Error(`tmux backend timed out after ${request.timeoutMs}ms`);
    }

    const output = await fs.readFile(outputPath, "utf8").catch(() => "");
    return output.trim() || "(no response)";
  } finally {
    await safeUnlink(promptPath);
    await safeUnlink(outputPath);
  }
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
