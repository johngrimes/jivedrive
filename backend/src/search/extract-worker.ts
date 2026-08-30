/**
 * The extraction worker (007-file-search): runs PDF (unpdf/pdf.js) and
 * DOCX (mammoth) parsing off the server's main thread. One job at a
 * time — heavy documents serialise by design (the scan's weighted
 * download budget assumes at most one heavy extraction's memory peak).
 *
 * The parent ({@link ./extract.ts}) recycles this worker periodically,
 * so pdf.js's retained page structures cannot accumulate into an
 * OOM (observed on prod: an unbounded run of extractions breached the
 * container's memory limit).
 */
import { extractTextPure } from "./extract";

interface WorkerJob {
  id: number;
  buffer: Uint8Array;
  fileName: string;
}

const queue: WorkerJob[] = [];
let draining = false;
/**
 * Minimal typed view of the DedicatedWorkerGlobalScope surface used
 * here; the DOM/webworker lib pair cannot be mixed in one tsconfig, so
 * the exact worker type is unavailable on the main-thread build.
 */
const ctx = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage(message: {
    id: number;
    text: string | null;
    error: string | null;
  }): void;
};

ctx.onmessage = (event) => {
  queue.push(event.data);
  void drain();
};

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      let text: string | null = null;
      let error: string | null = null;
      try {
        text = await extractTextPure(job.buffer, job.fileName);
      } catch (err) {
        // extractTextPure is written never to throw; belt and braces so
        // a thrown bug cannot wedge the queue.
        error = err instanceof Error ? err.message : String(err);
      }
      ctx.postMessage({ id: job.id, text, error });
    }
  } finally {
    draining = false;
  }
}
