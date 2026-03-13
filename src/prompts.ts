import { RlmNode } from "./types";

export function plannerPrompt(input: {
  task: string;
  depth: number;
  maxDepth: number;
  maxBranching: number;
  remainingNodeBudget: number;
}): string {
  return [
    "You are a recursion controller for a recursive language model run.",
    "Decide whether the task should be solved directly, or decomposed into subtasks.",
    "",
    "Return ONLY a JSON object with this schema:",
    '{"action":"solve"|"decompose","reason":"...","subtasks":["..."]}',
    "",
    "Rules:",
    "- Use action=solve if the task is atomic enough for one model pass.",
    "- Use action=decompose only when decomposition is clearly beneficial.",
    `- If action=decompose, return 2 to ${input.maxBranching} subtasks (never more).`,
    "- Subtasks must be clear, non-empty strings.",
    "- Do not include markdown or prose outside JSON.",
    "",
    `Current depth: ${input.depth} / ${input.maxDepth}`,
    `Remaining node budget: ${input.remainingNodeBudget}`,
    "",
    "Task:",
    input.task
  ].join("\n");
}

export function solverPrompt(input: {
  task: string;
  depth: number;
  maxDepth: number;
  forceReason?: string;
}): string {
  return [
    "You are a worker node in a recursive language model run.",
    "Solve the task directly and return a concrete answer.",
    "",
    `Depth: ${input.depth} / ${input.maxDepth}`,
    input.forceReason ? `Note: forced direct solve because ${input.forceReason}` : "",
    "",
    "Task:",
    input.task
  ]
    .filter(Boolean)
    .join("\n");
}

export function synthesisPrompt(input: {
  task: string;
  depth: number;
  children: RlmNode[];
}): string {
  const childBlocks = input.children
    .map((child, idx) => {
      const status = child.status.toUpperCase();
      const result = child.result ?? child.error ?? "(no output)";
      return [
        `### Child ${idx + 1} (${status})`,
        `Subtask: ${child.task}`,
        "Output:",
        result
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are the synthesizer node in a recursive language model run.",
    "Combine child results into one final response to the parent task.",
    "Use COMPLETED children as evidence.",
    "FAILED or CANCELLED children indicate missing work; do not infer their answers.",
    "If some children failed, produce a best-effort synthesis and explicitly note the gaps.",
    "Be explicit about uncertainties if child outputs conflict.",
    "",
    `Depth: ${input.depth}`,
    "",
    "Parent task:",
    input.task,
    "",
    "Child outputs:",
    childBlocks
  ].join("\n");
}
