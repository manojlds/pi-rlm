import crypto from "node:crypto";

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function createRunId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function truncateText(
  text: string,
  maxChars: number
): { text: string; truncated: boolean; originalChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`,
    truncated: true,
    originalChars: text.length
  };
}

export function normalizeTask(task: string): string {
  return task.replace(/\s+/g, " ").trim().toLowerCase();
}

export function shortTask(task: string, max = 80): string {
  if (task.length <= max) return task;
  return `${task.slice(0, max - 3)}...`;
}

export function extractFirstJsonObject(text: string): string | undefined {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, i + 1);
      }
    }
  }

  return undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parseModelPattern(model: string | undefined): {
  provider: string;
  id: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
} | undefined {
  if (!model) return undefined;

  const trimmed = model.trim();
  if (!trimmed.includes("/")) return undefined;

  const lastColon = trimmed.lastIndexOf(":");
  const hasThinkingSuffix =
    lastColon > -1 &&
    thinkingLevels.has(trimmed.slice(lastColon + 1)) &&
    !trimmed.slice(lastColon + 1).includes("/");

  const modelPart = hasThinkingSuffix ? trimmed.slice(0, lastColon) : trimmed;
  const thinkingPart = hasThinkingSuffix ? trimmed.slice(lastColon + 1) : undefined;

  const slashIdx = modelPart.indexOf("/");
  const provider = modelPart.slice(0, slashIdx).trim().toLowerCase();
  const id = modelPart.slice(slashIdx + 1).trim();

  if (!provider || !id) return undefined;

  return {
    provider,
    id,
    thinkingLevel: thinkingPart as
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined
  };
}
