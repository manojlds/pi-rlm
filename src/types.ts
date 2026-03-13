export type RlmBackend = "sdk" | "cli" | "tmux";
export type RlmMode = "auto" | "solve" | "decompose";
export type RlmOp = "start" | "status" | "wait" | "cancel";
export type RlmToolsProfile = "coding" | "read-only";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type NodeStatus = "running" | "completed" | "failed" | "cancelled";

export interface StartRunInput {
  task: string;
  backend: RlmBackend;
  mode: RlmMode;
  async: boolean;
  model?: string;
  cwd: string;
  toolsProfile: RlmToolsProfile;
  maxDepth: number;
  maxNodes: number;
  maxBranching: number;
  concurrency: number;
  timeoutMs: number;
  tmuxUseCurrentSession: boolean;
}

export interface RlmNode {
  id: string;
  depth: number;
  task: string;
  status: NodeStatus;
  decision?: {
    action: "solve" | "decompose";
    reason: string;
    raw?: string;
  };
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  children: RlmNode[];
}

export interface RunArtifacts {
  dir: string;
  eventsPath: string;
  treePath: string;
  outputPath: string;
}

export interface RunStats {
  nodesVisited: number;
  maxDepthSeen: number;
  durationMs: number;
}

export interface RlmRunResult {
  runId: string;
  backend: RlmBackend;
  final: string;
  root: RlmNode;
  artifacts: RunArtifacts;
  stats: RunStats;
}

export interface RunRecord {
  id: string;
  input: StartRunInput;
  status: RunStatus;
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  controller: AbortController;
  promise: Promise<RlmRunResult>;
  result?: RlmRunResult;
}

export interface PlannerDecision {
  action: "solve" | "decompose";
  reason: string;
  subtasks?: string[];
}
