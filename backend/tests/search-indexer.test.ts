import { afterEach, describe, expect, it, jest } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  createUser,
  getSearchDoc,
  listSearchIndex,
} from "../src/db/repository";
import type { User } from "../src/db/repository";
import { scanUserSpace } from "../src/search/indexer";
import { startScanScheduler } from "../src/search/scheduler";
import type { ScanCycleResult } from "../src/search/scheduler";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDb(): Database {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  return db;
}

function seedUser(db: Database, overrides: Partial<User> = {}): User {
  const username = overrides.username ?? "alice";
  return createUser(db, {
    username,
    bucket: overrides.bucket ?? "jivedrive-prod",
    prefix: overrides.prefix ?? `users/${username}/`,
  });
}

/** One object in the fake S3 store. */
interface FakeObject {
  etag: string;
  size: number;
  /** String bodies (e2e-mock style) or byte providers (real-SDK style). */
  body: string | Uint8Array | (() => Promise<Uint8Array>);
}

/** A fake S3 space: objects under alice's prefix, keyed by full key. */
type FakeStore = Map<string, FakeObject>;

function textObject(body: string, etag: string): FakeObject {
  return { etag, size: new TextEncoder().encode(body).length, body };
}

/**
 * A stub S3 client (s3.test.ts pattern): routes by command constructor
 * name, records every send, and serves listings/downloads from the
 * store. Listings paginate at `pageSize` to exercise the scan's
 * continuation loop.
 */
function fakeClient(
  store: FakeStore,
  pageSize = 1000,
  failGets: ReadonlySet<string> = new Set(),
): {
  client: S3Client;
  calls: Array<{ name: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor
        .name;
      const input = (command as { input: Record<string, unknown> }).input ?? {};
      calls.push({ name, input });
      switch (name) {
        case "ListObjectsV2Command": {
          const prefix = (input.Prefix as string) ?? "";
          const token = input.ContinuationToken as string | undefined;
          const start = token ? Number(token) : 0;
          const keys = [...store.keys()]
            .filter((k) => k.startsWith(prefix))
            .sort();
          const page = keys.slice(start, start + pageSize);
          const isTruncated = start + page.length < keys.length;
          return {
            Contents: page.map((key) => {
              const object = store.get(key)!;
              return {
                Key: key,
                ETag: object.etag,
                Size: object.size,
                LastModified: new Date(0),
              };
            }),
            IsTruncated: isTruncated,
            ...(isTruncated
              ? { NextContinuationToken: String(start + page.length) }
              : {}),
          };
        }
        case "GetObjectCommand": {
          const key = input.Key as string;
          const object = store.get(key);
          if (!object || failGets.has(key)) {
            const err = new Error("NoSuchKey") as Error & { name: string };
            err.name = "NoSuchKey";
            throw err;
          }
          if (typeof object.body === "string") return { Body: object.body };
          if (object.body instanceof Uint8Array) return { Body: object.body };
          const provider = object.body as () => Promise<Uint8Array>;
          return { Body: { transformToByteArray: async () => provider() } };
        }
        default:
          throw new Error(`Unexpected command: ${name}`);
      }
    },
  } as unknown as S3Client;
  return { client, calls };
}

const CAP = 1000;

describe("scanUserSpace", () => {
  it("indexes a new object and stores its extracted text (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/docs/notes.txt", textObject("hello from notes", '"e1"')],
    ]);
    const { client, calls } = fakeClient(store);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/docs/notes.txt")).toEqual({
      fileName: "notes.txt",
      body: "hello from notes",
    });
    // One listing, one download: the new object was fetched exactly once.
    expect(calls.filter((c) => c.name === "GetObjectCommand")).toHaveLength(1);
    const list = calls.find((c) => c.name === "ListObjectsV2Command");
    expect(list?.input.Bucket).toBe("jivedrive-prod");
    expect(list?.input.Prefix).toBe("users/alice/");
  });

  it("re-extracts an object whose etag or size changed (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/report.txt", textObject("version one", '"v1"')],
    ]);
    const { client } = fakeClient(store);
    await scanUserSpace(client, db, alice, CAP);

    store.set("users/alice/report.txt", textObject("version two!", '"v2"'));
    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 0, reindexed: 1, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/report.txt")).toEqual({
      fileName: "report.txt",
      body: "version two!",
    });
  });

  it("treats a size-only change as a change (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/report.txt", textObject("version one", '"v1"')],
    ]);
    const { client } = fakeClient(store);
    await scanUserSpace(client, db, alice, CAP);

    // Same etag, different size (an e2e-mock-style overwrite).
    store.set("users/alice/report.txt", {
      etag: '"v1"',
      size: 999,
      body: "changed anyway",
    });
    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 0, reindexed: 1, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/report.txt")?.body).toBe(
      "changed anyway",
    );
  });

  it("removes the rows of objects that vanished from the listing (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/stays.txt", textObject("stay", '"s1"')],
      ["users/alice/gone.txt", textObject("gone", '"g1"')],
    ]);
    const { client } = fakeClient(store);
    await scanUserSpace(client, db, alice, CAP);

    store.delete("users/alice/gone.txt");
    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 0, reindexed: 0, removed: 1 });
    expect(getSearchDoc(db, alice.id, "users/alice/gone.txt")).toBeNull();
    expect(getSearchDoc(db, alice.id, "users/alice/stays.txt")).not.toBeNull();
  });

  it("indexes oversized files by name only, without downloading (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const bigBody = "z".repeat(2000); // > CAP (1000)
    const store: FakeStore = new Map([
      ["users/alice/huge.txt", textObject(bigBody, '"big"')],
    ]);
    const { client, calls } = fakeClient(store);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(calls.filter((c) => c.name === "GetObjectCommand")).toHaveLength(0);
    expect(getSearchDoc(db, alice.id, "users/alice/huge.txt")).toEqual({
      fileName: "huge.txt",
      body: "",
    });
  });

  it("does not re-download unchanged objects on a second scan (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/same.txt", textObject("same text", '"same"')],
    ]);
    const { client, calls } = fakeClient(store);
    await scanUserSpace(client, db, alice, CAP);
    const downloadsAfterFirst = calls.filter(
      (c) => c.name === "GetObjectCommand",
    ).length;

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 0, reindexed: 0, removed: 0 });
    expect(calls.filter((c) => c.name === "GetObjectCommand")).toHaveLength(
      downloadsAfterFirst,
    );
  });

  it("degrades unextractable files to name-only and keeps scanning (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const corrupt = readFileSync(
      join(
        fileURLToPath(new URL("./fixtures", import.meta.url)),
        "corrupt.pdf",
      ),
    );
    const store: FakeStore = new Map([
      [
        "users/alice/broken.pdf",
        {
          etag: '"bad"',
          size: corrupt.length,
          body: corrupt,
        },
      ],
      ["users/alice/fine.txt", textObject("fine text", '"ok"')],
    ]);
    const { client } = fakeClient(store);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 2, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/broken.pdf")).toEqual({
      fileName: "broken.pdf",
      body: "",
    });
    expect(getSearchDoc(db, alice.id, "users/alice/fine.txt")?.body).toBe(
      "fine text",
    );
  });

  it("indexes a failed download name-only and keeps scanning (FR-008)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/broken.txt", textObject("never read", '"bad"')],
      ["users/alice/fine.txt", textObject("fine text", '"ok"')],
    ]);
    const { client, calls } = fakeClient(
      store,
      1000,
      new Set(["users/alice/broken.txt"]),
    );

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 2, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/broken.txt")).toEqual({
      fileName: "broken.txt",
      body: "",
    });
    expect(getSearchDoc(db, alice.id, "users/alice/fine.txt")?.body).toBe(
      "fine text",
    );
    // Only the failing object's GET failed; the other was downloaded.
    expect(calls.filter((c) => c.name === "GetObjectCommand")).toHaveLength(2);
  });

  it("re-attempts a failed download on the next scan", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/heal.txt", textObject("recovered", '"h1"')],
    ]);
    const failing = fakeClient(store, 1000, new Set(["users/alice/heal.txt"]));
    const first = await scanUserSpace(failing.client, db, alice, CAP);
    expect(first).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/heal.txt")?.body).toBe("");

    // The blank sentinel etag makes the object pend again even though
    // its listing fingerprint is unchanged.
    const { client, calls } = fakeClient(store);
    const second = await scanUserSpace(client, db, alice, CAP);
    expect(second).toEqual({ indexed: 0, reindexed: 1, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/heal.txt")).toEqual({
      fileName: "heal.txt",
      body: "recovered",
    });
    expect(calls.filter((c) => c.name === "GetObjectCommand")).toHaveLength(1);
  });

  it("reads real-SDK-style byte streams (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      [
        "users/alice/stream.txt",
        {
          etag: '"s1"',
          size: 5,
          body: async () => new TextEncoder().encode("hello"),
        },
      ],
    ]);
    const { client } = fakeClient(store);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/stream.txt")?.body).toBe(
      "hello",
    );
  });

  it("pages through truncated listings (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/a.txt", textObject("a", '"a"')],
      ["users/alice/b.txt", textObject("b", '"b"')],
      ["users/alice/c.txt", textObject("c", '"c"')],
    ]);
    const { client } = fakeClient(store, /* pageSize */ 2);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 3, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/c.txt")?.body).toBe("c");
  });

  it("ignores folder placeholder keys and other users' objects (T006)", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/empty/", { etag: '"e"', size: 0, body: "" }],
      ["users/alice/real.txt", textObject("real", '"r"')],
      ["users/bob/other.txt", textObject("other", '"o"')],
    ]);
    const { client } = fakeClient(store);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/real.txt")).not.toBeNull();
    expect(getSearchDoc(db, alice.id, "users/bob/other.txt")).toBeNull();
  });

  /** Drain microtasks and timers so gated downloads and admissions settle. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  it("bounds concurrent downloads by a byte budget, not object count", async () => {
    const db = createDb();
    const alice = seedUser(db);
    // Text weight 1.5 x 550 B = 825 charged per object; the 5x-cap budget
    // (5000 charged bytes at CAP=1000) admits six, defers the rest.
    let inflight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const tracked = (bytes: Uint8Array): FakeObject => ({
      etag: '"t"',
      size: bytes.length,
      body: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise<void>((r) => gates.push(r));
        inflight--;
        return bytes;
      },
    });
    const store: FakeStore = new Map(
      Array.from(
        { length: 10 },
        (_, i) =>
          [
            `users/alice/f${i}.txt`,
            tracked(new TextEncoder().encode("x".repeat(550))),
          ] as const,
      ),
    );
    const { client } = fakeClient(store);

    const scanning = scanUserSpace(client, db, alice, CAP);
    await flush();
    expect(inflight).toBe(6);

    while (gates.length) {
      gates.shift()!();
      await flush();
    }
    const counts = await scanning;

    expect(counts).toEqual({ indexed: 10, reindexed: 0, removed: 0 });
    expect(peak).toBe(6);
  });

  it("runs an extraction-weighted heavyweight object exclusively", async () => {
    const db = createDb();
    const alice = seedUser(db);
    // PDF weight 4 x 990 B = 3960 charged; two would exceed the 5x-cap
    // budget (5000), so each heavyweight runs alone and the others wait.
    let inflight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const store: FakeStore = new Map(
      [0, 1, 2].map(
        (i) =>
          [
            `users/alice/heavy${i}.pdf`,
            {
              etag: `"p${i}"`,
              size: 990,
              body: async () => {
                inflight++;
                peak = Math.max(peak, inflight);
                await new Promise<void>((r) => gates.push(r));
                inflight--;
                return new Uint8Array(990);
              },
            } satisfies FakeObject,
          ] as const,
      ),
    );
    const { client } = fakeClient(store);

    const scanning = scanUserSpace(client, db, alice, CAP);
    await flush();
    expect(inflight).toBe(1);

    // Extractions round-trip through a real worker, so the next gated
    // download starts on a macrotask boundary — poll for gates instead
    // of assuming microtask timing. Release all three; the heavyweight
    // budget admits exactly one download at a time, which is the
    // behaviour under test.
    let released = 0;
    while (released < 3) {
      while (gates.length) {
        gates.shift()!();
        released++;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const counts = await scanning;

    expect(counts).toEqual({ indexed: 3, reindexed: 0, removed: 0 });
    expect(peak).toBe(1);
    // Extractions now round-trip through a real worker; the first job
    // pays pdf.js's module load, so allow well over the 5s default.
  }, 30_000);

  it("degrades to name-only when the downloaded body exceeds the cap", async () => {
    const db = createDb();
    const alice = seedUser(db);
    let downloads = 0;
    const store: FakeStore = new Map([
      [
        "users/alice/lied.txt",
        {
          etag: '"l1"',
          size: 100, // listed within the cap...
          body: async () => {
            downloads++;
            return new TextEncoder().encode("y".repeat(2000)); // ...but 2x over
          },
        } satisfies FakeObject,
      ],
    ]);
    const { client } = fakeClient(store);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(counts).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(getSearchDoc(db, alice.id, "users/alice/lied.txt")?.body).toBe("");
    // Blank etag marks "never extracted": the next scan re-attempts it.
    const row = listSearchIndex(db, alice.id).find(
      (r) => r.key === "users/alice/lied.txt",
    );
    expect(row?.etag).toBe("");
    await scanUserSpace(client, db, alice, CAP);
    expect(downloads).toBe(2);
  });
});

describe("scanUserSpace folder index (folder search results, #13)", () => {
  /** Every stored folder key of one user, sorted. */
  function folderKeys(db: Database, userId: string): string[] {
    return (
      db
        .query("SELECT key FROM search_folders WHERE userId = ? ORDER BY key")
        .all(userId) as Array<{ key: string }>
    ).map((row) => row.key);
  }

  it("records every ancestor folder of a file and every placeholder folder", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/", textObject("", '"root"')],
      ["users/alice/top.txt", textObject("top", '"t"')],
      ["users/alice/projects/2026/plan.txt", textObject("plan", '"p"')],
      ["users/alice/projects/2026/notes.txt", textObject("notes", '"n"')],
      ["users/alice/empty/", textObject("", '"e"')],
      ["users/alice/empty/nested/", textObject("", '"en"')],
    ]);
    // One key per page: folders are gathered across the whole listing.
    const { client } = fakeClient(store, 1);

    const counts = await scanUserSpace(client, db, alice, CAP);

    expect(folderKeys(db, alice.id)).toEqual([
      "users/alice/empty/",
      "users/alice/empty/nested/",
      "users/alice/projects/",
      "users/alice/projects/2026/",
    ]);
    // Placeholders are still not indexed as files.
    expect(counts).toEqual({ indexed: 3, reindexed: 0, removed: 0 });
  });

  it("drops folders that vanished from the listing on the next scan", async () => {
    const db = createDb();
    const alice = seedUser(db);
    const store: FakeStore = new Map([
      ["users/alice/keep/a.txt", textObject("a", '"a"')],
      ["users/alice/gone/deep/b.txt", textObject("b", '"b"')],
      ["users/alice/placeholder/", textObject("", '"p"')],
    ]);
    const { client } = fakeClient(store);
    await scanUserSpace(client, db, alice, CAP);

    store.delete("users/alice/gone/deep/b.txt");
    store.delete("users/alice/placeholder/");
    await scanUserSpace(client, db, alice, CAP);

    expect(folderKeys(db, alice.id)).toEqual(["users/alice/keep/"]);
  });

  it("derives folders for a user scoped to the bucket root", async () => {
    const db = createDb();
    const root = seedUser(db, { username: "root", prefix: "" });
    const store: FakeStore = new Map([
      ["photos/2025/beach.jpg", textObject("jpg", '"j"')],
      ["readme.txt", textObject("hi", '"r"')],
    ]);
    const { client } = fakeClient(store);

    await scanUserSpace(client, db, root, CAP);

    expect(folderKeys(db, root.id)).toEqual(["photos/", "photos/2025/"]);
  });
});

describe("startScanScheduler", () => {
  /**
   * Drain pending microtasks so started scan cycles finish: Bun
   * processes a bounded slice of the queue per await, so loop a few
   * rounds — enough for a whole fake-client scan chain to settle.
   */
  async function drain(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  it("scans every user at the configured interval (T007)", async () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const store: FakeStore = new Map([
      ["users/alice/a.txt", textObject("a text", '"a"')],
      ["users/bob/b.txt", textObject("b text", '"b"')],
    ]);
    const { client } = fakeClient(store);
    const results: ScanCycleResult[] = [];

    jest.useFakeTimers();
    try {
      const scheduler = startScanScheduler({
        client,
        db,
        intervalSeconds: 1,
        maxBytes: CAP,
        onCycle: (result) => results.push(result),
      });

      // The scheduler bootstrap-scans immediately, then every interval.
      await drain();
      expect(results).toHaveLength(2);
      expect(new Set(results.map((r) => r.userId))).toEqual(
        new Set([alice.id, bob.id]),
      );
      expect(results.every((r) => r.counts?.indexed === 1)).toBe(true);

      results.length = 0;
      jest.advanceTimersByTime(1000);
      await drain();
      expect(results).toHaveLength(2);
      scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips a user whose scan is already running (T007)", async () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    let releaseSlow!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const store: FakeStore = new Map([
      [
        "users/alice/slow.txt",
        {
          etag: '"s"',
          size: 4,
          body: async () => {
            await gate;
            return new TextEncoder().encode("slow");
          },
        },
      ],
      ["users/bob/quick.txt", textObject("quick", '"q"')],
    ]);
    const { client, calls } = fakeClient(store);
    const results: ScanCycleResult[] = [];

    jest.useFakeTimers();
    try {
      const scheduler = startScanScheduler({
        client,
        db,
        intervalSeconds: 1,
        maxBytes: CAP,
        onCycle: (result) => results.push(result),
      });
      await drain();

      const bobDownloads = () =>
        calls.filter(
          (c) =>
            c.name === "GetObjectCommand" &&
            String(c.input.Key).startsWith("users/bob/"),
        ).length;
      const aliceDownloads = () =>
        calls.filter(
          (c) =>
            c.name === "GetObjectCommand" &&
            String(c.input.Key).startsWith("users/alice/"),
        ).length;

      // Cycle 1: bob finished, alice is stuck mid-scan.
      expect(bobDownloads()).toBe(1);
      expect(aliceDownloads()).toBe(1);
      expect(scheduler.running.has(bob.id)).toBe(false);
      expect(results.some((r) => r.userId === bob.id && r.counts)).toBe(true);

      // Cycle 2: alice's scan is still in flight, so only bob is scanned.
      // Bob's object changed meanwhile, so his rescan re-downloads it.
      store.set("users/bob/quick.txt", textObject("quick two", '"q2"'));
      jest.advanceTimersByTime(1000);
      await drain();
      expect(bobDownloads()).toBe(2);
      expect(aliceDownloads()).toBe(1);
      expect(results.filter((r) => r.userId === alice.id)).toHaveLength(0);

      // Releasing the gate lets alice's scan complete with counts.
      releaseSlow();
      await drain();
      const aliceResults = results.filter((r) => r.userId === alice.id);
      expect(aliceResults).toHaveLength(1);
      expect(aliceResults[0]?.counts).toEqual({
        indexed: 1,
        reindexed: 0,
        removed: 0,
      });
      scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
