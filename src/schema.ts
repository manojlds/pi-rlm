import { StringEnum } from "@mariozechner/pi-ai";
import { Static, Type } from "@sinclair/typebox";

const opSchema = StringEnum(["start", "status", "wait", "cancel"] as const);
const backendSchema = StringEnum(["sdk", "cli", "tmux"] as const);
const modeSchema = StringEnum(["auto", "solve", "decompose"] as const);
const toolsProfileSchema = StringEnum(["coding", "read-only"] as const);

export const rlmToolParamsSchema = Type.Object({
  op: Type.Optional(opSchema),
  id: Type.Optional(Type.String({ description: "Run ID for status/wait/cancel" })),
  task: Type.Optional(Type.String({ description: "Task to solve recursively" })),

  backend: Type.Optional(backendSchema),
  mode: Type.Optional(modeSchema),
  async: Type.Optional(Type.Boolean({ description: "Return immediately and run in background" })),
  model: Type.Optional(Type.String({ description: "Optional provider/model[:thinking] override" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for subcalls" })),
  toolsProfile: Type.Optional(toolsProfileSchema),

  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
  maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  maxBranching: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
  waitTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3600000 })),
  tmuxUseCurrentSession: Type.Optional(
    Type.Boolean({
      description: "For backend=tmux, place depth windows/panes in the current tmux session"
    })
  )
});

export type RlmToolParams = Static<typeof rlmToolParamsSchema>;
