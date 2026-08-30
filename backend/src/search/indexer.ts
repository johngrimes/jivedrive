/**
 * The scan engine (007-file-search): reconciles one user's search index
 * with their S3 space. A full recursive listing of the user's prefix is
 * diffed against the index by the (key → etag + size) fingerprint; only
 * new or changed objects are downloaded and re-extracted (R-004), files
 * above the size cap are indexed name-only (R-009), and objects that
 * vanished are removed from the index (FR-007).
 */
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "bun:sqlite";
import {
  listSearchIndex,
  removeSearchDoc,
  upsertSearchDoc,
} from "../db/repository";
import type { User } from "../db/repository";
import { extractable, extractText } from "./extract";

/** Default page size for listings, matching the S3 protocol limit. */
const MAX_KEYS = 1000;

/**
 * How many objects one scan downloads and extracts concurrently. The
 * per-object work is I/O-bound (one S3 GET plus extraction), while the
 * SQLite writes stay serialized — bun:sqlite is synchronous and
 * single-connection — so the pool only bounds in-flight bodies and
 * extraction CPU, never the database.
 */
const SCAN_CONCURRENCY = 12;

/** The outcome of one {@link scanUserSpace} run. */
export interface ScanCounts {
  /** Objects newly added to the index. */
  indexed: number;
  /** Previously indexed objects re-downloaded and re-extracted. */
  reindexed: number;
  /** Indexed objects whose storage object has vanished. */
  removed: number;
}

/** One object as seen in a listing. */
interface ListedObject {
  key: string;
  etag: string;
  size: number;
}

/** The base name of an object key: everything after the last "/". */
function baseName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Read an object body from an SDK GetObject output. The SDK delivers a
 * stream (with `transformToByteArray`); test/e2e fakes deliver plain
 * strings or byte arrays, so all three are accepted.
 *
 * @param body - the GetObject output's Body member
 * @returns the object bytes
 */
async function readObjectBody(body: unknown): Promise<Uint8Array> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof stream.transformToByteArray === "function") {
    return stream.transformToByteArray();
  }
  throw new Error("Unsupported S3 object body");
}

/**
 * List every object under the user's prefix, following S3 pagination
 * until exhausted. Folder-placeholder keys (ending in "/") are skipped:
 * they carry no name to index.
 *
 * @param client - S3 client
 * @param user - the user whose space is listed (bucket + prefix scope)
 * @returns all listed objects
 */
async function listAllObjects(
  client: S3Client,
  user: User,
): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let cursor: string | undefined;
  do {
    const output = (await client.send(
      new ListObjectsV2Command({
        Bucket: user.bucket,
        Prefix: user.prefix,
        MaxKeys: MAX_KEYS,
        ...(cursor ? { ContinuationToken: cursor } : {}),
      }),
    )) as {
      Contents?: Array<{ Key?: string; ETag?: string; Size?: number }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };
    for (const object of output.Contents ?? []) {
      const key = object.Key ?? "";
      if (key === "" || key.endsWith("/")) continue;
      objects.push({ key, etag: object.ETag ?? "", size: object.Size ?? 0 });
    }
    cursor = output.IsTruncated ? output.NextContinuationToken : undefined;
  } while (cursor);
  return objects;
}

/**
 * Reconcile one user's search index with their S3 space (FR-007).
 *
 * New objects are downloaded (when within `cap` and their extension is
 * extractable — anything else would only be discarded) and their
 * extracted text indexed; changed objects (different etag or size) are
 * re-downloaded and re-extracted; vanished objects have both index rows
 * removed. Unchanged objects are never re-downloaded. Objects above the
 * cap, files without an extraction handler, files whose extraction
 * fails, and files whose download fails are indexed name-only
 * (body = "") — per-object failures never abort the scan (FR-008). A
 * download failure stores a blank etag so the next cycle re-attempts
 * it: transient failures self-heal, and a permanent one (a listed
 * object that can never be re-fetched, e.g. a key that does not
 * round-trip through the SDK) costs one failed GET per cycle.
 * Downloads and extraction run with bounded
 * concurrency; each completed object is written to the index as it
 * settles (the writes serialize on the synchronous SQLite connection).
 *
 * @param client - S3 client (injectable; tests substitute a stub)
 * @param db - database connection
 * @param user - the user whose space is scanned
 * @param cap - maximum object size, in bytes, eligible for extraction
 * @returns the counts of indexed, reindexed and removed objects
 */
export async function scanUserSpace(
  client: S3Client,
  db: Database,
  user: User,
  cap: number,
): Promise<ScanCounts> {
  const counts: ScanCounts = { indexed: 0, reindexed: 0, removed: 0 };

  const listed = await listAllObjects(client, user);
  const listedByKey = new Map(listed.map((object) => [object.key, object]));
  const indexedByKey = new Map(
    listSearchIndex(db, user.id).map((row) => [row.key, row]),
  );

  // Removals first: rows whose object is gone from the listing.
  for (const [key] of indexedByKey) {
    if (!listedByKey.has(key)) {
      removeSearchDoc(db, user.id, key);
      counts.removed++;
    }
  }

  const pending: Array<{ object: ListedObject; existing: boolean }> = [];
  for (const object of listed) {
    const existing = indexedByKey.get(object.key);
    if (
      existing &&
      existing.etag === object.etag &&
      existing.size === object.size
    ) {
      continue;
    }
    pending.push({ object, existing: existing !== undefined });
  }

  // Download and extract with bounded concurrency, writing each result
  // as it settles. A per-object download failure never aborts the scan
  // (FR-008): the object is indexed name-only with a blank etag, which
  // makes the next cycle's diff re-pend it — transient failures
  // self-heal, and a permanent one costs one failed GET per cycle.
  let cursor = 0;
  const fetchBody = async (object: ListedObject): Promise<string> => {
    if (object.size > cap || !extractable(baseName(object.key))) return "";
    const output = (await client.send(
      new GetObjectCommand({ Bucket: user.bucket, Key: object.key }),
    )) as { Body?: unknown };
    const bytes = await readObjectBody(output.Body);
    return (await extractText(bytes, baseName(object.key))) ?? "";
  };
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const index = cursor++;
      const next = pending[index];
      if (!next) return;
      const { object, existing } = next;
      let body: string | null = null;
      try {
        body = await fetchBody(object);
      } catch (error) {
        console.warn(
          `Search scan: indexing ${object.key} name-only after failed download:`,
          error instanceof Error ? error.message : error,
        );
      }
      upsertSearchDoc(db, {
        userId: user.id,
        key: object.key,
        // Blank etag marks "listed but never downloaded": the next
        // cycle's fingerprint diff then re-attempts the download.
        etag: body === null ? "" : object.etag,
        size: object.size,
        fileName: baseName(object.key),
        body: body ?? "",
      });
      if (existing) {
        counts.reindexed++;
      } else {
        counts.indexed++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, pending.length) }, worker),
  );

  return counts;
}
