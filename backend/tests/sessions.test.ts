import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser, getSessionByToken } from "../src/db/repository";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  sessionCookie,
  sweepExpiredSessions,
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

  it("invalidates and deletes a session idle beyond the window (T046)", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 30, // absolute TTL: 2026-08-31
    });

    // 8 days after creation — inside the 30-day absolute TTL but past the
    // 7-day idle window (default JIVEDRIVE_SESSION_IDLE_DAYS).
    const later = new Date("2026-08-09T00:00:00Z");
    expect(validateSession(db, token, later)).toBeNull();

    // The idle-expired row must be lazily purged.
    expect(getSessionByToken(db, token)).toBeNull();
  });

  it("rolls the idle clock on valid validation, keeping the session alive (T047)", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 30,
    });

    // Activity 4 days in: valid, and the idle clock advances to the
    // validation time.
    const first = validateSession(db, token, new Date("2026-08-05T00:00:00Z"));
    expect(first?.userId).toBe(user.id);
    expect(getSessionByToken(db, token)?.lastUsedAt).toBe(
      "2026-08-05T00:00:00.000Z",
    );

    // 10 days after creation, 3 days after the first touch: without the
    // roll this would be idle-expired (creation + 7 days = 08-08); the
    // rolled clock (08-05 + 7 days = 08-12) keeps it valid.
    const second = validateSession(db, token, new Date("2026-08-11T00:00:00Z"));
    expect(second?.userId).toBe(user.id);
    expect(getSessionByToken(db, token)?.lastUsedAt).toBe(
      "2026-08-11T00:00:00.000Z",
    );
  });

  it("absolute TTL still caps a session with recent activity (T048)", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 30, // expires 2026-08-31
    });

    // Activity the day before the absolute TTL: inside the idle window, so
    // only the absolute cap can invalidate the session.
    db.query("UPDATE sessions SET lastUsedAt = ? WHERE token = ?").run(
      "2026-08-30T00:00:00.000Z",
      token,
    );

    // Past the absolute TTL the session is invalid even with fresh activity,
    // and the row is deleted.
    expect(
      validateSession(db, token, new Date("2026-09-01T00:00:00Z")),
    ).toBeNull();
    expect(getSessionByToken(db, token)).toBeNull();
  });
});

describe("sweepExpiredSessions (US5)", () => {
  it("purges absolute- and idle-expired sessions, keeping live ones (T049)", () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const live = createSession(db, user.id, {
      now: new Date("2026-08-10T00:00:00Z"),
      ttlDays: 30,
    });
    const idleExpired = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 30,
    });
    const absoluteExpired = createSession(db, user.id, {
      now: new Date("2026-07-01T00:00:00Z"),
      ttlDays: 30, // expires 2026-07-31, before the sweep's now
    });

    // The idle-expired session's clock was last touched 21 days before the
    // sweep (well beyond the 7-day window), though it is inside its TTL.
    db.query("UPDATE sessions SET lastUsedAt = ? WHERE token = ?").run(
      "2026-07-20T00:00:00.000Z",
      idleExpired.token,
    );

    const now = new Date("2026-08-10T00:00:00Z");
    const deleted = sweepExpiredSessions(db, now, 7);

    expect(deleted).toBe(2);
    expect(getSessionByToken(db, live.token)).not.toBeNull();
    expect(getSessionByToken(db, idleExpired.token)).toBeNull();
    expect(getSessionByToken(db, absoluteExpired.token)).toBeNull();
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
