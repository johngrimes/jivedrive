/**
 * In-memory scan status registry (admin scan reporting): tracks the
 * latest scan run per user — running, succeeded or failed. Both scan
 * paths record into it, the background scheduler's cycle and the admin
 * reindex endpoint, so the admin status view reflects every scan.
 *
 * Records live only for the process lifetime: after a restart the view
 * falls back to "idle" until the bootstrap cycle reports again. When two
 * scans of one user overlap (a manual reindex during a cycle), a
 * completion never overwrites a run that started later — runs are
 * ordered by a monotonic registry counter carried in the run token, not
 * by the wall clock, so same-millisecond starts cannot race.
 */
import type { ScanCounts } from "./indexer";

/** The state of a recorded scan run. */
export type ScanState = "running" | "ok" | "error";

/** The latest recorded scan run for one user. */
export interface ScanRecord {
  state: ScanState;
  /** ISO 8601 start time of the recorded run. */
  startedAt: string;
  /** ISO 8601 finish time; null while the run is in flight. */
  finishedAt: string | null;
  /** Index/reindex/remove counts; null unless the run succeeded. */
  counts: ScanCounts | null;
  /** The failure message; null unless the run failed. */
  error: string | null;
}

/** Identity of one in-flight scan run, handed out by recordStart. */
export interface ScanRunToken {
  /** The scanning user's id. */
  userId: string;
  /** Monotonic registry counter value ordering overlapping runs. */
  runId: number;
  /** The run's start time. */
  startedAt: Date;
}

/** Write-side of the scan status registry. */
export interface ScanStatusRegistry {
  /**
   * Mark a user's scan as running; pass the returned token back to
   * {@link ScanStatusRegistry.recordSuccess} or
   * {@link ScanStatusRegistry.recordFailure} when the run finishes.
   *
   * @param userId - the scanning user's id
   * @returns the run token identifying this run
   */
  recordStart(userId: string): ScanRunToken;
  /**
   * Record a successful scan.
   *
   * @param run - the token recordStart returned for this run
   * @param counts - the scan's outcome counts
   */
  recordSuccess(run: ScanRunToken, counts: ScanCounts): void;
  /**
   * Record a failed scan.
   *
   * @param run - the token recordStart returned for this run
   * @param error - the thrown failure
   */
  recordFailure(run: ScanRunToken, error: unknown): void;
  /** The latest record per user id; users never scanned are absent. */
  all(): ReadonlyMap<string, ScanRecord>;
}

/** The run a record belongs to: registry-ordered, per-user latest. */
interface RunEntry {
  /** Monotonic registry counter value of the recorded run. */
  runId: number;
  record: ScanRecord;
}

/**
 * Create an empty scan status registry.
 *
 * @returns the registry
 */
export function createScanStatusRegistry(): ScanStatusRegistry {
  const runs = new Map<string, RunEntry>();
  let nextRunId = 0;

  function setIfCurrent(
    run: ScanRunToken,
    state: "ok" | "error",
    counts: ScanCounts | null,
    error: string | null,
  ): void {
    const existing = runs.get(run.userId);
    // A completion only overwrites its own run (same run id) or a
    // record of an older run; ANY newer run of the same user — in
    // flight or already finished — keeps the record, so a slow older
    // scan can never replace a newer run's outcome.
    if (existing && existing.runId > run.runId) {
      return;
    }
    runs.set(run.userId, {
      runId: run.runId,
      record: {
        state,
        startedAt: run.startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        counts,
        error,
      },
    });
  }

  return {
    recordStart(userId: string): ScanRunToken {
      const token: ScanRunToken = {
        userId,
        runId: ++nextRunId,
        startedAt: new Date(),
      };
      runs.set(userId, {
        runId: token.runId,
        record: {
          state: "running",
          startedAt: token.startedAt.toISOString(),
          finishedAt: null,
          counts: null,
          error: null,
        },
      });
      return token;
    },

    recordSuccess(run: ScanRunToken, counts: ScanCounts): void {
      setIfCurrent(run, "ok", counts, null);
    },

    recordFailure(run: ScanRunToken, error: unknown): void {
      setIfCurrent(
        run,
        "error",
        null,
        error instanceof Error ? error.message : String(error),
      );
    },

    all(): ReadonlyMap<string, ScanRecord> {
      return new Map([...runs].map(([userId, run]) => [userId, run.record]));
    },
  };
}
