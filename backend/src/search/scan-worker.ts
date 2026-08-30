/**
 * The scan worker (007-file-search): runs the whole scan engine —
 * S3 listing, downloads, text extraction and SQLite writes — on a
 * dedicated thread, so the server's main thread never pays for the
 * scan's I/O latency or SQLite commit/fsync work (on the prod VPS's
 * slow disk those commits blocked the main thread for tens of seconds
 * at a time, tripping the liveness probe).
 *
 * Jobs run strictly one at a time: SQLite is single-writer and the
 * scheduler never wanted concurrent scans of one user anyway. The
 * worker owns its own database connection (WAL keeps it out of the
 * server's way) and S3 client, reused across jobs.
 */
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import type { User } from "../db/repository";
import type { ScanCounts } from "./indexer";
import { scanUserSpace } from "./indexer";
import { extractTextPure } from "./extract";
import { openDatabase } from "../db/migrate";
import { createS3Client } from "../s3/client";

export interface ScanWorkerInit {
  dbPath: string;
  s3: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

interface ScanJob {
  id: number;
  user: User;
  cap: number;
  dbPath: string;
  s3: ScanWorkerInit["s3"];
}

interface ScanOutcome {
  id: number;
  counts?: ScanCounts;
  error?: string;
}

/** Minimal typed view of the DedicatedWorkerGlobalScope surface. */
const ctx = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScanJob>) => void) | null;
  postMessage(message: ScanOutcome): void;
};

const queue: ScanJob[] = [];
let draining = false;
let db: Database | null = null;
let client: S3Client | null = null;

async function jobResources(job: ScanJob): Promise<{
  db: Database;
  client: S3Client;
}> {
  if (!db || !client) {
    // The scan's connection relaxes durability: the index self-heals
    // (a torn commit surfaces as a blank etag and is re-attempted),
    // and NORMAL removes the per-commit fsync that made VPS-disk
    // commits block for seconds.
    db = openDatabase(job.dbPath);
    db.run("PRAGMA synchronous = NORMAL;");
    client = createS3Client(job.s3);
  }
  return { db, client };
}

async function run(job: ScanJob): Promise<void> {
  try {
    const { db, client } = await jobResources(job);
    const counts = await scanUserSpace(
      client,
      db,
      job.user,
      job.cap,
      extractTextPure,
    );
    ctx.postMessage({ id: job.id, counts });
  } catch (error) {
    ctx.postMessage({
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

ctx.onmessage = (event) => {
  queue.push(event.data);
  void drain();
};

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      await run(queue.shift()!);
    }
  } finally {
    draining = false;
  }
}
