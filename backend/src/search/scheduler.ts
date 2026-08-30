/**
 * The scan scheduler (007-file-search): a background loop that
 * reconciles every user's space at a fixed interval (FR-007). Each
 * cycle scans all users concurrently, but never starts a second scan of
 * a user whose previous scan is still in flight — a slow space cannot
 * pile up concurrent scans of itself. Scan failures are contained: one
 * user's listing error never stops the loop or the other users' scans.
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "bun:sqlite";
import { listUsers } from "../db/repository";
import type { User } from "../db/repository";
import { scanUserSpace } from "./indexer";
import type { ScanCounts } from "./indexer";
import type { ScanStatusRegistry } from "./status";

/** The outcome of one user's scan within a cycle. */
export interface ScanCycleResult {
  userId: string;
  /** Index/reindex/remove counts; undefined when the scan failed. */
  counts?: ScanCounts;
  /** The failure, when the scan threw (e.g. S3 listing error). */
  error?: unknown;
}

/** A running scan scheduler. */
export interface ScanSchedulerHandle {
  /**
   * Stop future cycles; in-flight scans finish. Safe to call more than
   * once.
   */
  stop(): void;
  /** Ids of users whose scan is currently in flight. */
  running: ReadonlySet<string>;
}

/** Options for {@link startScanScheduler}. */
export interface ScanSchedulerOptions {
  client: S3Client;
  db: Database;
  /** Seconds between cycles; every cycle scans every user. */
  intervalSeconds: number;
  /**
   * Maximum object size, in bytes, eligible for extraction (the
   * `searchIndexMaxBytes` config value passed through to the scan).
   */
  maxBytes: number;
  /** Per-scan result hook (tests, future admin reporting). */
  onCycle?: (result: ScanCycleResult) => void;
  /**
   * Optional scan status registry (admin reporting): every scan start,
   * success and failure is recorded so the admin scan-status view
   * reflects both this scheduler and manual reindex scans.
   */
  status?: ScanStatusRegistry;
}

/**
 * Start the background scan loop: one immediate bootstrap cycle (the
 * first deployment's initial scan, SC "initial scan completes → all
 * existing files searchable"), then a cycle every `intervalSeconds`.
 *
 * The interval is always positive (config minimum is 1 second); there is
 * no off switch. Failures are reported through `onCycle` (and logged)
 * instead of crashing the loop.
 *
 * @param options - S3 client, database, interval, size cap, result hook
 * @returns a handle to observe in-flight scans and stop the loop
 */
export function startScanScheduler(
  options: ScanSchedulerOptions,
): ScanSchedulerHandle {
  const { client, db, intervalSeconds, maxBytes, onCycle, status } = options;
  const running = new Set<string>();

  async function scanUser(user: User): Promise<void> {
    if (running.has(user.id)) return;
    running.add(user.id);
    const run = status?.recordStart(user.id);
    try {
      const counts = await scanUserSpace(client, db, user, maxBytes);
      if (run) status?.recordSuccess(run, counts);
      onCycle?.({ userId: user.id, counts });
    } catch (error) {
      if (run) status?.recordFailure(run, error);
      console.error(`Search scan failed for user ${user.username}:`, error);
      onCycle?.({ userId: user.id, error });
    } finally {
      running.delete(user.id);
    }
  }

  async function cycle(): Promise<void> {
    await Promise.all(listUsers(db).map(scanUser));
  }

  void cycle();
  const timer = setInterval(() => void cycle(), intervalSeconds * 1000);

  return {
    running,
    stop(): void {
      clearInterval(timer);
    },
  };
}
