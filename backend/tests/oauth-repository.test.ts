import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  consumeOAuthAuthorizationRequest,
  createOAuthAccessToken,
  createOAuthAuthorizationRequest,
  createOAuthClient,
  createOAuthCode,
  createOAuthGrant,
  createOAuthRefreshToken,
  createUser,
  deleteOAuthGrant,
  deleteUser,
  getOAuthAccessToken,
  getOAuthAuthorizationRequest,
  getOAuthClient,
  getOAuthCode,
  getOAuthGrant,
  getOAuthRefreshToken,
  listOAuthGrantsByUser,
  markOAuthCodeUsed,
  markOAuthRefreshTokenUsed,
  sweepExpiredOAuth,
  touchOAuthGrant,
} from "../src/db/repository";
import { migrationsDir } from "./oauth-test-helpers";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const T0 = "2026-11-08T00:00:00.000Z";

/** Offset an ISO instant by seconds. */
function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** A migrated database with alice, bob and a registered client. */
function createDb() {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket: "jivedrive-test",
    prefix: "users/alice/",
  });
  const bob = createUser(db, {
    username: "bob",
    bucket: "jivedrive-test",
    prefix: "users/bob/",
  });
  createOAuthClient(db, {
    clientId: "client-1",
    clientName: "Claude",
    redirectUris: ["https://claude.ai/cb"],
    createdAt: T0,
  });
  return { db, alice, bob };
}

/** Count rows in a table. */
function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;
}

describe("009 OAuth migration", () => {
  it("creates the six OAuth tables with cascading foreign keys", () => {
    const { db } = createDb();
    for (const table of [
      "oauth_clients",
      "oauth_authorization_requests",
      "oauth_grants",
      "oauth_codes",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
    ]) {
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
      ).toBeTruthy();
    }
    const grantKeys = db
      .query("PRAGMA foreign_key_list(oauth_grants)")
      .all() as Array<{ table: string; on_delete: string }>;
    expect(grantKeys.map((k) => [k.table, k.on_delete]).sort()).toEqual([
      ["oauth_clients", "CASCADE"],
      ["users", "CASCADE"],
    ]);
    for (const table of [
      "oauth_codes",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
    ]) {
      const keys = db
        .query(`PRAGMA foreign_key_list(${table})`)
        .all() as Array<{ table: string; on_delete: string }>;
      expect(keys).toEqual([
        expect.objectContaining({
          table: "oauth_grants",
          on_delete: "CASCADE",
        }),
      ]);
    }
  });
});

describe("OAuth repository", () => {
  it("round-trips a client with its redirect URIs", () => {
    const { db } = createDb();
    expect(getOAuthClient(db, "client-1")).toEqual({
      clientId: "client-1",
      clientName: "Claude",
      redirectUris: ["https://claude.ai/cb"],
      createdAt: T0,
    });
    expect(getOAuthClient(db, "nope")).toBeNull();
  });

  it("returns and consumes an authorization request only while active", () => {
    const { db } = createDb();
    const request = createOAuthAuthorizationRequest(db, {
      id: "req-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      state: null,
      codeChallenge: "challenge",
      resource: "http://localhost:5173/mcp",
      scope: "drive",
      createdAt: T0,
      expiresAt: at(600),
    });
    expect(
      getOAuthAuthorizationRequest(db, "req-1", new Date(at(599))),
    ).toEqual(request);
    expect(
      getOAuthAuthorizationRequest(db, "req-1", new Date(at(600))),
    ).toBeNull();
    expect(
      consumeOAuthAuthorizationRequest(db, "req-1", new Date(at(1))),
    ).toEqual(request);
    expect(
      consumeOAuthAuthorizationRequest(db, "req-1", new Date(at(1))),
    ).toBeNull();
    expect(count(db, "oauth_authorization_requests")).toBe(0);
  });

  it("lists a user's grants newest first with the client name", () => {
    const { db, alice, bob } = createDb();
    createOAuthGrant(db, {
      id: "g1",
      userId: alice.id,
      clientId: "client-1",
      createdAt: T0,
    });
    createOAuthGrant(db, {
      id: "g2",
      userId: alice.id,
      clientId: "client-1",
      createdAt: at(10),
    });
    createOAuthGrant(db, {
      id: "g3",
      userId: bob.id,
      clientId: "client-1",
      createdAt: at(20),
    });
    touchOAuthGrant(db, "g1", at(30));
    for (const id of ["g1", "g2"]) {
      createOAuthRefreshToken(db, {
        tokenHash: `r-${id}`,
        grantId: id,
        expiresAt: at(30 * 86400),
      });
    }
    expect(listOAuthGrantsByUser(db, alice.id, new Date(at(100)))).toEqual([
      {
        id: "g2",
        userId: alice.id,
        clientId: "client-1",
        clientName: "Claude",
        createdAt: at(10),
        lastUsedAt: null,
      },
      {
        id: "g1",
        userId: alice.id,
        clientId: "client-1",
        clientName: "Claude",
        createdAt: T0,
        lastUsedAt: at(30),
      },
    ]);
    expect(getOAuthGrant(db, "g3")?.userId).toBe(bob.id);
  });

  it("treats a grant with nothing usable left as dead: unlisted and swept", () => {
    const { db, alice } = createDb();
    // live-code: only an unused, unexpired code.
    createOAuthGrant(db, {
      id: "live-code",
      userId: alice.id,
      clientId: "client-1",
      createdAt: T0,
    });
    createOAuthCode(db, {
      codeHash: "c-live",
      grantId: "live-code",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "x",
      resource: "r",
      expiresAt: at(60),
    });
    // live-access: only an unexpired access token.
    createOAuthGrant(db, {
      id: "live-access",
      userId: alice.id,
      clientId: "client-1",
      createdAt: T0,
    });
    createOAuthAccessToken(db, {
      tokenHash: "a-live",
      grantId: "live-access",
      expiresAt: at(3600),
    });
    // live-refresh: an unused refresh token valid for 30 days.
    createOAuthGrant(db, {
      id: "live-refresh",
      userId: alice.id,
      clientId: "client-1",
      createdAt: T0,
    });
    createOAuthRefreshToken(db, {
      tokenHash: "r-live",
      grantId: "live-refresh",
      expiresAt: at(30 * 86400),
    });
    // dead-used: its only refresh token and code were already used.
    createOAuthGrant(db, {
      id: "dead-used",
      userId: alice.id,
      clientId: "client-1",
      createdAt: T0,
    });
    createOAuthRefreshToken(db, {
      tokenHash: "r-used",
      grantId: "dead-used",
      expiresAt: at(30 * 86400),
    });
    markOAuthRefreshTokenUsed(db, "r-used", at(1));
    createOAuthCode(db, {
      codeHash: "c-used",
      grantId: "dead-used",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "x",
      resource: "r",
      expiresAt: at(60),
    });
    markOAuthCodeUsed(db, "c-used", at(1));

    const ids = (now: string) =>
      listOAuthGrantsByUser(db, alice.id, new Date(now))
        .map((g) => g.id)
        .sort();
    expect(ids(at(10))).toEqual(["live-access", "live-code", "live-refresh"]);
    // The code expires at 60 s, the access token at 1 h.
    expect(ids(at(60))).toEqual(["live-access", "live-refresh"]);
    expect(ids(at(3600))).toEqual(["live-refresh"]);
    // 30 idle days later the refresh token has expired too.
    expect(ids(at(30 * 86400))).toEqual([]);

    sweepExpiredOAuth(db, new Date(at(3600)));
    expect(getOAuthGrant(db, "dead-used")).toBeNull();
    expect(getOAuthGrant(db, "live-code")).toBeNull();
    expect(getOAuthGrant(db, "live-access")).toBeNull();
    expect(getOAuthGrant(db, "live-refresh")).not.toBeNull();
    sweepExpiredOAuth(db, new Date(at(30 * 86400)));
    expect(getOAuthGrant(db, "live-refresh")).toBeNull();
    expect(count(db, "oauth_grants")).toBe(0);
  });

  it("marks codes and refresh tokens used exactly once", () => {
    const { db, alice } = createDb();
    createOAuthGrant(db, {
      id: "g1",
      userId: alice.id,
      clientId: "client-1",
      createdAt: T0,
    });
    createOAuthCode(db, {
      codeHash: "c",
      grantId: "g1",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "x",
      resource: "r",
      expiresAt: at(60),
    });
    expect(getOAuthCode(db, "c")?.usedAt).toBeNull();
    expect(markOAuthCodeUsed(db, "c", at(1))).toBe(true);
    expect(markOAuthCodeUsed(db, "c", at(2))).toBe(false);
    expect(getOAuthCode(db, "c")?.usedAt).toBe(at(1));

    createOAuthRefreshToken(db, {
      tokenHash: "r",
      grantId: "g1",
      expiresAt: at(100),
    });
    expect(markOAuthRefreshTokenUsed(db, "r", at(1))).toBe(true);
    expect(markOAuthRefreshTokenUsed(db, "r", at(2))).toBe(false);
    expect(getOAuthRefreshToken(db, "r")).toEqual({
      tokenHash: "r",
      grantId: "g1",
      expiresAt: at(100),
      usedAt: at(1),
    });
  });

  it("deleting a grant removes its codes and tokens", () => {
    const { db, alice } = createDb();
    seedGrantWithTokens(db, alice.id, "g1");
    deleteOAuthGrant(db, "g1");
    expect(count(db, "oauth_codes")).toBe(0);
    expect(count(db, "oauth_access_tokens")).toBe(0);
    expect(count(db, "oauth_refresh_tokens")).toBe(0);
  });

  it("deleteUser removes the user's grants and tokens only", () => {
    const { db, alice, bob } = createDb();
    seedGrantWithTokens(db, alice.id, "g1");
    seedGrantWithTokens(db, bob.id, "g2");
    deleteUser(db, alice.id);
    expect(getOAuthGrant(db, "g1")).toBeNull();
    expect(getOAuthAccessToken(db, "a-g1")).toBeNull();
    expect(getOAuthRefreshToken(db, "r-g1")).toBeNull();
    expect(getOAuthCode(db, "c-g1")).toBeNull();
    expect(getOAuthGrant(db, "g2")).not.toBeNull();
    expect(getOAuthAccessToken(db, "a-g2")).not.toBeNull();
    // The client survives (it may serve other users).
    expect(getOAuthClient(db, "client-1")).not.toBeNull();
  });

  it("sweeps never-granted clients after 1 day, formerly granted ones 30 days after their last grant", () => {
    const { db, alice } = createDb();
    createOAuthClient(db, {
      clientId: "never",
      clientName: "Never",
      redirectUris: ["https://x.example/cb"],
      createdAt: T0,
    });
    for (const [clientId, grantedAt] of [
      ["early", at(10)],
      ["late", at(20 * 86400)],
    ] as const) {
      createOAuthClient(db, {
        clientId,
        clientName: clientId,
        redirectUris: ["https://x.example/cb"],
        createdAt: T0,
      });
      createOAuthGrant(db, {
        id: `g-${clientId}`,
        userId: alice.id,
        clientId,
        createdAt: grantedAt,
      });
      deleteOAuthGrant(db, `g-${clientId}`);
    }
    expect(
      db
        .query("SELECT lastGrantedAt FROM oauth_clients WHERE clientId = ?")
        .get("early"),
    ).toEqual({ lastGrantedAt: at(10) });

    sweepExpiredOAuth(db, new Date(at(86400 - 1)));
    expect(getOAuthClient(db, "never")).not.toBeNull();
    sweepExpiredOAuth(db, new Date(at(86400)));
    expect(getOAuthClient(db, "never")).toBeNull();
    expect(getOAuthClient(db, "early")).not.toBeNull();

    sweepExpiredOAuth(db, new Date(at(30 * 86400 + 9)));
    expect(getOAuthClient(db, "early")).not.toBeNull();
    sweepExpiredOAuth(db, new Date(at(30 * 86400 + 10)));
    expect(getOAuthClient(db, "early")).toBeNull();
    // Registered long ago, but granted 20 days in: kept until day 50.
    expect(getOAuthClient(db, "late")).not.toBeNull();
    sweepExpiredOAuth(db, new Date(at(50 * 86400)));
    expect(getOAuthClient(db, "late")).toBeNull();
  });

  it("sweeps expired rows and stale clients without grants", () => {
    const { db, alice } = createDb();
    seedGrantWithTokens(db, alice.id, "g1");
    createOAuthAccessToken(db, {
      tokenHash: "a-live",
      grantId: "g1",
      expiresAt: at(40 * 86400),
    });
    createOAuthRefreshToken(db, {
      tokenHash: "r-live",
      grantId: "g1",
      expiresAt: at(40 * 86400),
    });
    createOAuthAuthorizationRequest(db, {
      id: "req-old",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      state: null,
      codeChallenge: "x",
      resource: "r",
      scope: "drive",
      createdAt: T0,
      expiresAt: at(600),
    });
    // An unused client registered long ago, and a fresh one.
    createOAuthClient(db, {
      clientId: "stale",
      clientName: "Old",
      redirectUris: ["https://x.example/cb"],
      createdAt: T0,
    });
    createOAuthClient(db, {
      clientId: "fresh",
      clientName: "New",
      redirectUris: ["https://x.example/cb"],
      createdAt: at(31 * 86400 - 60),
    });

    sweepExpiredOAuth(db, new Date(at(31 * 86400)));

    expect(count(db, "oauth_authorization_requests")).toBe(0);
    expect(getOAuthCode(db, "c-g1")).toBeNull();
    expect(getOAuthAccessToken(db, "a-g1")).toBeNull();
    expect(getOAuthRefreshToken(db, "r-g1")).toBeNull();
    expect(getOAuthAccessToken(db, "a-live")).not.toBeNull();
    expect(getOAuthRefreshToken(db, "r-live")).not.toBeNull();
    expect(getOAuthClient(db, "stale")).toBeNull();
    expect(getOAuthClient(db, "fresh")).not.toBeNull();
    // client-1 is old too but still has a grant.
    expect(getOAuthClient(db, "client-1")).not.toBeNull();
    expect(getOAuthGrant(db, "g1")).not.toBeNull();
  });
});

/** Seed a grant with one short-lived code, access and refresh token. */
function seedGrantWithTokens(db: Database, userId: string, id: string): void {
  createOAuthGrant(db, { id, userId, clientId: "client-1", createdAt: T0 });
  createOAuthCode(db, {
    codeHash: `c-${id}`,
    grantId: id,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: "x",
    resource: "r",
    expiresAt: at(60),
  });
  createOAuthAccessToken(db, {
    tokenHash: `a-${id}`,
    grantId: id,
    expiresAt: at(3600),
  });
  createOAuthRefreshToken(db, {
    tokenHash: `r-${id}`,
    grantId: id,
    expiresAt: at(30 * 86400),
  });
}
