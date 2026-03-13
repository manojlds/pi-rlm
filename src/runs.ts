import { RlmRunResult, RunRecord, RunStatus, StartRunInput } from "./types";
import { createRunId, toErrorMessage } from "./utils";

const maxRecords = 200;

export class RunStore {
  private readonly records = new Map<string, RunRecord>();

  start(
    input: StartRunInput,
    executor: (runId: string, signal: AbortSignal) => Promise<RlmRunResult>,
    externalSignal?: AbortSignal
  ): RunRecord {
    const id = createRunId();
    const controller = new AbortController();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener(
          "abort",
          () => {
            controller.abort();
          },
          { once: true }
        );
      }
    }

    const record: RunRecord = {
      id,
      input,
      status: "running",
      createdAt: Date.now(),
      startedAt: Date.now(),
      controller,
      promise: Promise.resolve(null as unknown as RlmRunResult)
    };

    const runPromise = (async () => {
      try {
        const result = await executor(id, controller.signal);
        record.status = "completed";
        record.finishedAt = Date.now();
        record.result = result;
        return result;
      } catch (error) {
        const message = toErrorMessage(error);
        record.finishedAt = Date.now();
        if (controller.signal.aborted || message.toLowerCase().includes("cancel")) {
          record.status = "cancelled";
        } else {
          record.status = "failed";
        }
        record.error = message;
        throw error;
      } finally {
        this.prune();
      }
    })();

    // Prevent unhandled-rejection crashes when async callers start a run and don't await it.
    void runPromise.catch(() => undefined);
    record.promise = runPromise;

    this.records.set(id, record);
    this.prune();
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.records.get(id);
  }

  list(): RunRecord[] {
    return Array.from(this.records.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async wait(id: string, timeoutMs: number): Promise<{
    status: RunStatus;
    record: RunRecord;
    done: boolean;
  }> {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown run id: ${id}`);
    }

    if (record.status !== "running") {
      return { status: record.status, record, done: true };
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        record.promise.then(() => undefined).catch(() => undefined),
        new Promise((resolve) => {
          timeoutHandle = setTimeout(resolve, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const done = record.status !== "running";
    return { status: record.status, record, done };
  }

  cancel(id: string): RunRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown run id: ${id}`);
    }

    if (record.status === "running") {
      record.controller.abort();
    }

    return record;
  }

  private prune(): void {
    const records = this.list();
    if (records.length <= maxRecords) return;

    for (const record of records.slice(maxRecords)) {
      if (record.status === "running") continue;
      this.records.delete(record.id);
    }
  }
}
