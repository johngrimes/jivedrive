import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  sessionCookie,
  validateSession,
} from "../src/auth/sessions";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

function createDb(): Database {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("createSession", () => {
  it("creates a session with a random opaque token and 30-day default TTL", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const now = new Date("2026-08-12T00:00:00.000Z");

    const { token, session } = createSession(db, user.id, { now });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.token).toBe(token);
    expect(session.userId).toBe(user.id);
    expect(session.createdAt).toBe("2026-08-12T00:00:00.000Z");
    expect(session.expiresAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("honours a custom TTL", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const now = new Date("2026-08-12T00:00:00.000Z");

    const { session } = createSession(db, user.id, { now, ttlDays: 7 });
    expect(session.expiresAt).toBe("2026-08-19T00:00:00.000Z");
  });

  it("generates a unique token for each session", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });

    const first = createSession(db, user.id);
    const second = createSession(db, user.id);
    expect(first.token).not.toBe(second.token);
  });
});

describe("validateSession", () => {
  it("returns the session for a valid token", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-12T00:00:00Z"),
    });

    const session = validateSession(
      db,
      token,
      new Date("2026-08-13T00:00:00Z"),
    );
    expect(session?.userId).toBe(user.id);
  });

  it("returns null for an unknown token", () => {
    const db = createDb();
    expect(validateSession(db, "nope", new Date())).toBeNull();
  });

  it("returns null for an expired session and deletes the row", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 1,
    });

    const later = new Date("2026-08-03T00:00:00Z");
    expect(validateSession(db, token, later)).toBeNull();

    // The expired row must have been removed from the database.
    expect(
      db.query("SELECT COUNT(*) AS n FROM sessions WHERE token = ?").get(token),
    ).toEqual({
      n: 0,
    });
  });

  it("treats a session expiring exactly now as expired", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 1,
    });

    expect(
      validateSession(db, token, new Date("2026-08-02T00:00:00Z")),
    ).toBeNull();
  });
});

describe("destroySession", () => {
  it("removes the session row", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id);

    destroySession(db, token);
    expect(validateSession(db, token)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({
      n: 0,
    });
  });
});

describe("cookie helpers", () => {
  it("builds a session cookie with the required attributes", () => {
    const cookie = sessionCookie("token123", {
      maxAgeSeconds: 2592000,
      secure: true,
    });

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
  });

  it("omits the Secure attribute when not required", () => {
    const cookie = sessionCookie("token123", {
      maxAgeSeconds: 3600,
      secure: false,
    });
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("builds a clearing cookie that expires immediately", () => {
    const cookie = clearSessionCookie({ secure: true });

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
