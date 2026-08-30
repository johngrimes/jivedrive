/**
 * The scan worker host: owns the long-lived scan worker thread and
 * hands out per-user scan jobs to it. Scans run strictly sequentially
 * inside the worker (single-writer SQLite); a bootstrap scan of a huge
 * space legitimately runs for hours, so jobs carry no timeout.
 *
 * A crashed worker fails its in-flight job (the scheduler's status
 * registry records the failure and the next cycle re-attempts) and is
 * recreated lazily on the next scan.
 */
import type { User } from "../db/repository";
import type { ScanCounts } from "./indexer";

export interface ScanWorkerHostOptions {
  /** Absolute or CWD-relative database path the worker opens. */
  dbPath: string;
  s3: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  /** Maximum object size eligible for extraction. */
  cap: number;
}

export interface ScanWorkerHost {
  /** Run one full scan of the user's space; resolves with the counts. */
  scan(user: User): Promise<ScanCounts>;
  /** Terminate the worker; in-flight scans reject. */
  stop(): void;
}

interface ScanOutcome {
  id: number;
  counts?: ScanCounts;
  error?: string;
}

export function startScanWorkerHost(
  options: ScanWorkerHostOptions,
): ScanWorkerHost {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (counts: ScanCounts) => void; reject: (error: unknown) => void }
  >();

  function failAllPending(reason: string): void {
    const jobs = [...pending.values()];
    pending.clear();
    for (const job of jobs) {
      job.reject(new Error(reason));
    }
  }

  function getWorker(): Worker {
    if (worker === null) {
      worker = new Worker(new URL("./scan-worker.ts", import.meta.url));
      worker.onmessage = (event: MessageEvent<ScanOutcome>) => {
        const job = pending.get(event.data.id);
        if (!job) return;
        pending.delete(event.data.id);
        if (event.data.error !== undefined) {
          job.reject(new Error(event.data.error));
        } else {
          job.resolve(event.data.counts!);
        }
      };
      worker.onerror = () => {
        failAllPending("scan worker crashed");
        worker?.terminate();
        worker = null;
      };
    }
    return worker;
  }

  return {
    scan(user: User): Promise<ScanCounts> {
      const id = nextId++;
      const w = getWorker();
      return new Promise<ScanCounts>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({
          id,
          user,
          cap: options.cap,
          dbPath: options.dbPath,
          s3: options.s3,
        });
      });
    },
    stop(): void {
      worker?.terminate();
      worker = null;
      failAllPending("scan worker stopped");
    },
  };
}
