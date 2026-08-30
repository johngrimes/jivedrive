/**
 * Repository tests for the content-search query helper (007-file-search,
 * US2, T016). Lives in its own file because `db.test.ts` is owned by the
 * parallel US4 workstream; the conventions mirror it: a real in-memory
 * SQLite database with the migrations applied.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser, searchContent, upsertSearchDoc } from "../src/db/repository";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Open an in-memory database with the real schema applied. */
function createDb(): Database {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  return db;
}

/** Create a user with sensible defaults and return the stored row. */
function seedUser(db: Database, username: string) {
  return createUser(db, {
    username,
    bucket: "jivedrive-prod",
    prefix: `users/${username}/`,
  });
}

describe("searchContent", () => {
  it("finds documents whose body contains the phrase and returns marked snippets", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/notes/meeting.txt",
      etag: '"etag"',
      size: 10,
      fileName: "meeting.txt",
      body: "attendees confirmed the quarterly budget review before noon",
    });

    const hits = searchContent(db, alice.id, "budget review");

    expect(hits).toEqual([
      {
        key: "users/alice/notes/meeting.txt",
        fileName: "meeting.txt",
        snippet: expect.stringContaining("<mark>budget review</mark>"),
      },
    ]);
  });

  it("matches case-insensitively", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/readme.md",
      etag: '"etag"',
      size: 10,
      fileName: "readme.md",
      body: "The Quarterly Budget Review went well",
    });

    const hits = searchContent(db, alice.id, "BUDGET review");

    expect(hits).toHaveLength(1);
    // The snippet quotes the document's own casing.
    expect(hits[0]?.snippet).toContain("<mark>Budget Review</mark>");
  });

  it("never returns rows outside the owner's space (constitution IV)", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    const carol = seedUser(db, "carol");
    upsertSearchDoc(db, {
      userId: carol.id,
      key: "users/carol/hers.txt",
      etag: '"etag"',
      size: 10,
      fileName: "hers.txt",
      body: "a secret budget review",
    });

    expect(searchContent(db, alice.id, "budget review")).toEqual([]);
  });

  it("returns nothing for queries under 3 characters (FR-016)", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/notes.txt",
      etag: '"etag"',
      size: 10,
      fileName: "notes.txt",
      body: "mentions ab in the body",
    });

    expect(searchContent(db, alice.id, "ab")).toEqual([]);
    expect(searchContent(db, alice.id, "a")).toEqual([]);
  });

  it("keeps FTS5 operators and quotes literal in the phrase", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/literal.txt",
      etag: '"etag"',
      size: 10,
      fileName: "literal.txt",
      body: 'the "(not" AND operators OR are literal',
    });

    const hits = searchContent(db, alice.id, '(not" AND operators OR');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.fileName).toBe("literal.txt");
  });

  it("respects the limit", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    for (const name of ["a", "b", "c"]) {
      upsertSearchDoc(db, {
        userId: alice.id,
        key: `users/alice/${name}.txt`,
        etag: '"etag"',
        size: 10,
        fileName: `${name}.txt`,
        body: "the needle is in here",
      });
    }

    expect(searchContent(db, alice.id, "needle", 2)).toHaveLength(2);
    expect(searchContent(db, alice.id, "needle")).toHaveLength(3);
  });
});
