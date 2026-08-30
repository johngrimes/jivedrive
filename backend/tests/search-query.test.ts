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
import {
  createUser,
  searchContent,
  searchFileNames,
  upsertSearchDoc,
} from "../src/db/repository";

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

describe("searchFileNames/searchContent with a key prefix (US3, T021)", () => {
  /**
   * Seed one document into alice's index.
   *
   * @param db - database connection
   * @param alice - the owning user
   * @param key - full object key including the storage prefix
   * @param fileName - base name of the object
   * @param body - extracted text (empty for name-only files)
   */
  function seed(
    db: Database,
    alice: { id: string },
    key: string,
    fileName: string,
    body = "",
  ): void {
    upsertSearchDoc(db, {
      userId: alice.id,
      key,
      etag: '"etag"',
      size: 10,
      fileName,
      body,
    });
  }

  it("restricts filename hits to keys under the prefix", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    seed(db, alice, "users/alice/projects/plan.txt", "plan.txt");
    seed(db, alice, "users/alice/private/secret-plan.txt", "secret-plan.txt");

    const hits = searchFileNames(
      db,
      alice.id,
      "plan",
      50,
      "users/alice/projects/",
    );

    expect(hits).toEqual([
      { key: "users/alice/projects/plan.txt", fileName: "plan.txt" },
    ]);
  });

  it("restricts content hits (and snippets) to keys under the prefix", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    seed(
      db,
      alice,
      "users/alice/projects/docs/report.pdf",
      "report.pdf",
      "the budget review lives here",
    );
    seed(
      db,
      alice,
      "users/alice/private/leak.txt",
      "leak.txt",
      "the budget review lives here too",
    );

    const hits = searchContent(
      db,
      alice.id,
      "budget review",
      50,
      "users/alice/projects/",
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("users/alice/projects/docs/report.pdf");
    expect(hits[0]?.snippet).toContain("<mark>budget review</mark>");
  });

  it("keeps LIKE wildcards in the prefix literal", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    seed(db, alice, "users/alice/50%/match.txt", "match.txt");
    seed(db, alice, "users/alice/50x/match.txt", "match.txt");

    // "50%/" must not degenerate into the "50…" prefix.
    expect(
      searchFileNames(db, alice.id, "match", 50, "users/alice/50%/"),
    ).toEqual([{ key: "users/alice/50%/match.txt", fileName: "match.txt" }]);
    // "a_b/" must not match "a-b/"-style keys either (via the LIKE path).
    seed(db, alice, "users/alice/a_b/ab.txt", "ab.txt");
    seed(db, alice, "users/alice/axb/ab.txt", "ab.txt");
    expect(searchFileNames(db, alice.id, "ab", 50, "users/alice/a_b/")).toEqual(
      [{ key: "users/alice/a_b/ab.txt", fileName: "ab.txt" }],
    );
  });

  it("applies the prefix to the short-query LIKE fallback too", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    seed(db, alice, "users/alice/projects/ab-tool.txt", "ab-tool.txt");
    seed(db, alice, "users/alice/private/ab-secret.txt", "ab-secret.txt");

    expect(
      searchFileNames(db, alice.id, "ab", 50, "users/alice/projects/"),
    ).toEqual([
      { key: "users/alice/projects/ab-tool.txt", fileName: "ab-tool.txt" },
    ]);
  });

  it("respects the limit with a prefix", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    for (const name of ["a", "b", "c"]) {
      seed(db, alice, `users/alice/projects/${name}.txt`, `${name}.txt`);
    }

    expect(
      searchFileNames(db, alice.id, "txt", 2, "users/alice/projects/"),
    ).toHaveLength(2);
    expect(
      searchFileNames(db, alice.id, "txt", 50, "users/alice/projects/"),
    ).toHaveLength(3);
  });
});
