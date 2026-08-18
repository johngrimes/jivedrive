import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  countAdmins,
  createCredential,
  createInvite,
  createUser,
  getCredentialById,
  getInviteByToken,
  getSessionByToken,
  getUserByUsername,
  listInvites,
  markInviteClaimed,
} from "../src/db/repository";
import { createSession, validateSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import { createS3Client } from "../src/s3/client";
import type { AppConfig } from "../src/config";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A config whose origin forms the invite link base. */
const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  rateLimit: {
    authPerMinute: 20,
    authBurst: 10,
    filesPerMinute: 300,
    filesBurst: 100,
    trustProxy: false,
  },
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
  },
  bootstrapAdmin: {
    username: null,
    bucket: null,
    prefix: "",
    isAdmin: true,
    enrollmentToken: null,
  },
  webauthn: { rpId: "localhost", origin: "http://localhost:5173" },
};

const bucket = "jivedrive-prod";

/** The session cookie for the seeded admin. */
const adminCookie = "jivedrive_session=admin-session";

/** The session cookie for the seeded non-admin member. */
const memberCookie = "jivedrive_session=member-session";

/** The admin user list entry returned by the API. */
interface AdminUserBody {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
  createdAt: string;
}

/** The invite entry returned by the API. */
interface AdminInviteBody {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
  expiresAt: string;
  status: "pending" | "claimed" | "expired";
}

/** Response of the create and resend invite endpoints. */
interface InviteResponse {
  invite: AdminInviteBody;
  link: string;
}

/**
 * Create an app over a fresh in-memory database with a seeded admin and a
 * seeded non-admin member, each with a session.
 *
 * @param withS3Stub - also install a recording S3 stub so tests can prove
 *   no storage calls happen
 * @returns the app, db and the recorded S3 calls
 */
function createAdminApp(withS3Stub = false): {
  app: ReturnType<typeof createApp>;
  db: Database;
  calls: Array<{ name: string }>;
} {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const admin = createUser(db, {
    username: "admin",
    bucket,
    prefix: "users/admin/",
    isAdmin: true,
  });
  createSession(db, admin.id, { token: "admin-session" });
  const member = createUser(db, {
    username: "member",
    bucket,
    prefix: "users/member/",
  });
  createSession(db, member.id, { token: "member-session" });

  const calls: Array<{ name: string }> = [];
  let client: S3Client | undefined;
  if (withS3Stub) {
    const s3Client = createS3Client(config.s3);
    s3Client.send = (async (command: unknown) => {
      calls.push({
        name: (command as { constructor: { name: string } }).constructor.name,
      });
      return {};
    }) as unknown as S3Client["send"];
    client = s3Client;
  }

  const app = createApp({ config, db, s3Client: client });
  return { app, db, calls };
}

/** The seeded admin and member rows. */
function seededUsers(db: Database): {
  admin: NonNullable<ReturnType<typeof getUserByUsername>>;
  member: NonNullable<ReturnType<typeof getUserByUsername>>;
} {
  return {
    admin: getUserByUsername(db, "admin") as NonNullable<
      ReturnType<typeof getUserByUsername>
    >,
    member: getUserByUsername(db, "member") as NonNullable<
      ReturnType<typeof getUserByUsername>
    >,
  };
}

/** POST a create-invite request with the admin cookie. */
async function postInvite(
  app: ReturnType<typeof createApp>,
  body: unknown,
  cookie = adminCookie,
): Promise<Response> {
  return app.request("/api/admin/invites", {
    method: "POST",
    headers: {
      cookie,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/admin/users", () => {
  it("lists all users with the contract shape plus createdAt", async () => {
    const { app } = createAdminApp();

    const res = await app.request("/api/admin/users", {
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: AdminUserBody[] };
    expect(body.users).toHaveLength(2);
    const admin = body.users.find((u) => u.username === "admin");
    const member = body.users.find((u) => u.username === "member");
    expect(admin).toMatchObject({
      username: "admin",
      bucket,
      prefix: "users/admin/",
      isAdmin: true,
    });
    expect(admin?.id).toBeTruthy();
    // createdAt is a timestamp extension beyond the contract User schema.
    expect(Number.isNaN(Date.parse(admin?.createdAt ?? ""))).toBe(false);
    expect(member).toMatchObject({
      username: "member",
      bucket,
      prefix: "users/member/",
      isAdmin: false,
    });
  });

  it("refuses a non-admin with 403 and an unsigned request with 401", async () => {
    const { app } = createAdminApp();

    const forbidden = await app.request("/api/admin/users", {
      headers: { cookie: memberCookie },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "forbidden" });

    const unsigned = await app.request("/api/admin/users");
    expect(unsigned.status).toBe(401);
  });
});

describe("DELETE /api/admin/users", () => {
  /** DELETE a user id with the admin cookie. */
  async function removeUser(
    app: ReturnType<typeof createApp>,
    id: string,
    cookie = adminCookie,
  ): Promise<Response> {
    return app.request(`/api/admin/users?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { cookie },
    });
  }

  it("removes a non-admin user and invalidates their session, credentials and claimed invites", async () => {
    const { app, db } = createAdminApp();
    const { member } = seededUsers(db);

    // Give the member a credential, a session and a claimed invite so the
    // cascade (data-model.md deletion rules) is observable.
    createCredential(db, {
      id: "member-cred",
      userId: member.id,
      publicKey: "pub",
    });
    const invite = createInvite(db, {
      token: "inv-member-claimed",
      username: "member",
      bucket,
      prefix: "users/member/",
      issuedByUserId: seededUsers(db).admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    markInviteClaimed(db, invite.id, member.id);

    const res = await removeUser(app, member.id);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(getUserByUsername(db, "member")).toBeNull();
    // The member's session row is cascade-deleted, so their session token
    // no longer validates (removing a user ends their sessions).
    expect(getSessionByToken(db, "member-session")).toBeNull();
    expect(getInviteByToken(db, "inv-member-claimed")).toBeNull();
    // The admin and their session survive.
    expect(getUserByUsername(db, "admin")).not.toBeNull();
    expect(getSessionByToken(db, "admin-session")).not.toBeNull();
  });

  it("does not allow removing your own account", async () => {
    const { app, db } = createAdminApp();
    // A second admin exists, so removing yourself is not a last-admin
    // case: it hits the remove-self protection.
    createUser(db, {
      username: "second",
      bucket,
      prefix: "users/second/",
      isAdmin: true,
    });
    const { admin } = seededUsers(db);

    const res = await removeUser(app, admin.id);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "remove_self" });
    expect(getUserByUsername(db, "admin")).not.toBeNull();
  });

  it("does not allow removing the last admin", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);

    const res = await removeUser(app, admin.id);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "last_admin" });
    expect(getUserByUsername(db, "admin")).not.toBeNull();
  });

  it("allows removing an admin when another admin remains", async () => {
    const { app, db } = createAdminApp();
    const second = createUser(db, {
      username: "second",
      bucket,
      prefix: "users/second/",
      isAdmin: true,
    });

    const res = await removeUser(app, second.id);

    expect(res.status).toBe(204);
    expect(getUserByUsername(db, "second")).toBeNull();
    expect(getUserByUsername(db, "admin")).not.toBeNull();
  });

  it("returns 204 for an unknown id (idempotent removal)", async () => {
    const { app } = createAdminApp();

    const res = await removeUser(app, "no-such-user");

    expect(res.status).toBe(204);
  });

  it("rejects a missing id with 400", async () => {
    const { app } = createAdminApp();

    const res = await app.request("/api/admin/users", {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("never touches storage: no S3 calls during a user removal", async () => {
    const { app, db, calls } = createAdminApp(true);
    const { member } = seededUsers(db);

    const res = await removeUser(app, member.id);

    expect(res.status).toBe(204);
    // FR-014: removing a user must not delete any objects in storage; the
    // admin routes have no S3 dependency and no command is ever sent.
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-admin with 403 and an unsigned request with 401", async () => {
    const { app, db } = createAdminApp();
    const { member } = seededUsers(db);

    const forbidden = await removeUser(app, member.id, memberCookie);
    expect(forbidden.status).toBe(403);
    expect(getUserByUsername(db, "member")).not.toBeNull();

    const unsigned = await app.request("/api/admin/users?id=x", {
      method: "DELETE",
    });
    expect(unsigned.status).toBe(401);
  });
});

describe("DELETE /api/admin/users/:id/passkeys", () => {
  /** DELETE all passkeys of a user id with the admin cookie. */
  async function resetPasskeys(
    app: ReturnType<typeof createApp>,
    id: string,
    cookie = adminCookie,
  ): Promise<Response> {
    return app.request(`/api/admin/users/${encodeURIComponent(id)}/passkeys`, {
      method: "DELETE",
      headers: { cookie },
    });
  }

  it("deletes credentials, revokes all sessions, cancels pending invites and returns the re-enrollment invite and link (T023)", async () => {
    const { app, db } = createAdminApp();
    const target = createUser(db, {
      username: "target",
      bucket,
      prefix: "users/target/",
    });
    // Two credentials, discoverable and legacy alike: the reset must delete
    // every row, not only the discoverable ones.
    createCredential(db, {
      id: "target-cred-1",
      userId: target.id,
      publicKey: "pub-1",
      discoverable: true,
    });
    createCredential(db, {
      id: "target-cred-2",
      userId: target.id,
      publicKey: "pub-2",
      discoverable: false,
    });
    // Two sessions with known tokens, so revocation is observable through
    // validateSession after the reset (FR-006).
    createSession(db, target.id, { token: "target-session-1" });
    createSession(db, target.id, { token: "target-session-2" });
    // A pending invite for the username: cancelled by the reset so exactly
    // one live invite exists.
    createInvite(db, {
      token: "inv-target-pending",
      username: "target",
      bucket,
      prefix: "users/target/",
      issuedByUserId: seededUsers(db).admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    // A claimed invite for the same username: survives for audit.
    const claimed = createInvite(db, {
      token: "inv-target-claimed",
      username: "target",
      bucket,
      prefix: "users/target/",
      issuedByUserId: seededUsers(db).admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    markInviteClaimed(db, claimed.id, target.id);

    const res = await resetPasskeys(app, target.id);

    // 200 with the re-enrollment invite and its link (contract v1.2.0).
    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteResponse;
    expect(body.link).toMatch(/\/register\?token=/);
    // The new invite carries the user's own bucket/prefix/isAdmin so the
    // US1 attach flow can redeem it against the existing account.
    expect(body.invite).toMatchObject({
      username: "target",
      bucket,
      prefix: "users/target/",
      isAdmin: false,
      status: "pending",
    });
    expect(getCredentialById(db, "target-cred-1")).toBeNull();
    expect(getCredentialById(db, "target-cred-2")).toBeNull();
    // Every session of the target is revoked: the tokens no longer validate.
    expect(validateSession(db, "target-session-1")).toBeNull();
    expect(validateSession(db, "target-session-2")).toBeNull();
    // The pending invite is cancelled; the claimed invite survives.
    expect(getInviteByToken(db, "inv-target-pending")).toBeNull();
    expect(getInviteByToken(db, "inv-target-claimed")).not.toBeNull();
    // Exactly one live (pending) invite exists for the username.
    const pendingForTarget = listInvites(db).filter(
      (invite) =>
        invite.username === "target" && invite.claimedByUserId === null,
    );
    expect(pendingForTarget).toHaveLength(1);
    // The user row stays (a reset is not a removal) and the admin's
    // session is untouched.
    expect(getUserByUsername(db, "target")).not.toBeNull();
    expect(validateSession(db, "admin-session")).not.toBeNull();
  });

  it("returns 404 for an unknown user, creating no invite and deleting nothing (T025)", async () => {
    const { app, db } = createAdminApp();
    const { member } = seededUsers(db);
    createCredential(db, {
      id: "member-cred",
      userId: member.id,
      publicKey: "pub",
      discoverable: true,
    });
    const invitesBefore = listInvites(db).length;

    const res = await resetPasskeys(app, "no-such-user");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "User not found",
      code: "not_found",
    });
    // No invite was created and no credential or session was touched.
    expect(listInvites(db)).toHaveLength(invitesBefore);
    expect(getCredentialById(db, "member-cred")).not.toBeNull();
    expect(validateSession(db, "member-session")).not.toBeNull();
    expect(getUserByUsername(db, "admin")).not.toBeNull();
    expect(getUserByUsername(db, "member")).not.toBeNull();
  });

  it("revokes the caller's own session on self-reset and still returns the link (T024)", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    createCredential(db, {
      id: "admin-cred",
      userId: admin.id,
      publicKey: "pub-admin",
      discoverable: true,
    });

    const res = await resetPasskeys(app, admin.id);

    // Self-reset is allowed (FR-006); the credential is gone and the
    // caller's own session row is deleted by the reset, but the response
    // still returns the re-enrollment link (no dead end).
    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteResponse;
    expect(body.link).toMatch(/\/register\?token=/);
    expect(getCredentialById(db, "admin-cred")).toBeNull();
    expect(validateSession(db, "admin-session")).toBeNull();
    expect(getUserByUsername(db, "admin")).not.toBeNull();
  });

  it("allows resetting the last admin: the user row and admin count are untouched (T026)", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    createCredential(db, {
      id: "admin-cred",
      userId: admin.id,
      publicKey: "pub-admin",
      discoverable: true,
    });
    createSession(db, admin.id, { token: "admin-session-2" });
    // Only the seeded admin has isAdmin: resetting them is the last-admin
    // case, which must be allowed.
    expect(countAdmins(db)).toBe(1);

    const res = await resetPasskeys(app, admin.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteResponse;
    expect(body.link).toMatch(/\/register\?token=/);
    // The user row is kept: only credentials, sessions and invites are
    // touched, so the admin count never changes — nothing to guard.
    expect(getUserByUsername(db, "admin")).not.toBeNull();
    expect(countAdmins(db)).toBe(1);
    expect(validateSession(db, "admin-session")).toBeNull();
    expect(validateSession(db, "admin-session-2")).toBeNull();
  });

  it("leaves other users' sessions untouched by a reset (T027)", async () => {
    const { app, db } = createAdminApp();
    const target = createUser(db, {
      username: "target",
      bucket,
      prefix: "users/target/",
    });
    createSession(db, target.id, { token: "target-session" });
    expect(validateSession(db, "member-session")).not.toBeNull();

    const res = await resetPasskeys(app, target.id);

    expect(res.status).toBe(200);
    expect(validateSession(db, "target-session")).toBeNull();
    // The seeded member's session (and the admin's) still validate.
    expect(validateSession(db, "member-session")).not.toBeNull();
    expect(validateSession(db, "admin-session")).not.toBeNull();
  });

  it("refuses a non-admin with 403 and an unsigned request with 401", async () => {
    const { app, db } = createAdminApp();
    const { member } = seededUsers(db);
    createCredential(db, {
      id: "member-cred",
      userId: member.id,
      publicKey: "pub",
      discoverable: true,
    });

    const forbidden = await resetPasskeys(app, member.id, memberCookie);
    expect(forbidden.status).toBe(403);
    // US4 scenario 2: nothing is deleted by the refused request.
    expect(getCredentialById(db, "member-cred")).not.toBeNull();

    const unsigned = await app.request(
      `/api/admin/users/${member.id}/passkeys`,
      { method: "DELETE" },
    );
    expect(unsigned.status).toBe(401);
    expect(getCredentialById(db, "member-cred")).not.toBeNull();
  });
});

describe("GET /api/admin/invites", () => {
  it("lists invites with derived status: pending, claimed and expired", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const now = Date.now();

    // Pending: unclaimed and not yet expired.
    createInvite(db, {
      token: "inv-pending",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    });
    // Claimed: claimedByUserId set, regardless of expiry.
    const claimed = createInvite(db, {
      token: "inv-claimed",
      username: "dave",
      bucket,
      prefix: "users/dave/",
      issuedByUserId: admin.id,
      expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    });
    markInviteClaimed(db, claimed.id, admin.id);
    // Expired: past expiresAt and never claimed.
    createInvite(db, {
      token: "inv-expired",
      username: "erin",
      bucket,
      prefix: "users/erin/",
      issuedByUserId: admin.id,
      expiresAt: new Date(now - 60 * 60 * 1000).toISOString(),
    });

    const res = await app.request("/api/admin/invites", {
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: AdminInviteBody[] };
    const byUsername = new Map(
      body.invites.map((invite) => [invite.username, invite]),
    );
    expect(byUsername.get("carol")).toMatchObject({
      bucket,
      prefix: "users/carol/",
      isAdmin: false,
      status: "pending",
    });
    expect(byUsername.get("dave")?.status).toBe("claimed");
    expect(byUsername.get("erin")?.status).toBe("expired");
    // A claimed invite that is also past expiry reports claimed, not
    // expired (claimed wins: state transitions in data-model.md).
  });

  it("refuses a non-admin with 403 and an unsigned request with 401", async () => {
    const { app } = createAdminApp();

    const forbidden = await app.request("/api/admin/invites", {
      headers: { cookie: memberCookie },
    });
    expect(forbidden.status).toBe(403);

    const unsigned = await app.request("/api/admin/invites");
    expect(unsigned.status).toBe(401);
  });
});

describe("POST /api/admin/invites", () => {
  it("creates a pending invite with a 48-hour expiry and a link containing the token", async () => {
    const { app, db } = createAdminApp();
    const before = Date.now();

    const res = await postInvite(app, {
      username: "carol",
      bucket,
      prefix: "users/carol/",
    });
    const after = Date.now();

    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.invite).toMatchObject({
      username: "carol",
      bucket,
      prefix: "users/carol/",
      isAdmin: false,
      status: "pending",
    });
    // FR-003: invites expire 48 hours after creation.
    const expiresAt = Date.parse(body.invite.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 48 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 48 * 60 * 60 * 1000);
    // The link is the full registration URL containing the token, derived
    // from the configured origin.
    expect(body.link.startsWith("http://localhost:5173/register?token=")).toBe(
      true,
    );
    const token = body.link.split("token=")[1] as string;
    expect(token).toBeTruthy();
    expect(getInviteByToken(db, token)?.username).toBe("carol");
  });

  it("records the admin flag and normalises the prefix", async () => {
    const { app, db } = createAdminApp();

    const res = await postInvite(app, {
      username: "carol",
      bucket,
      prefix: "teams/carol",
      isAdmin: true,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteResponse;
    expect(body.invite).toMatchObject({
      isAdmin: true,
      prefix: "teams/carol/",
    });
    // The stored invite carries the admin flag too.
    const storedToken = body.link.split("token=")[1] as string;
    const stored = getInviteByToken(db, storedToken);
    expect(stored?.isAdmin).toBe(true);
    expect(stored?.prefix).toBe("teams/carol/");
  });

  it("returns 409 when the username is already a user", async () => {
    const { app } = createAdminApp();

    const res = await postInvite(app, {
      username: "member",
      bucket,
      prefix: "users/member/",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "username_taken" });
  });

  it("returns 409 when a pending invite already exists for the username", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    createInvite(db, {
      token: "existing-pending",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const res = await postInvite(app, {
      username: "carol",
      bucket,
      prefix: "users/carol/",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "invite_pending" });
    // The original invite is untouched.
    expect(getInviteByToken(db, "existing-pending")).not.toBeNull();
  });

  it("allows a new invite for a username whose earlier invite was cancelled", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const cancelled = createInvite(db, {
      token: "cancelled-invite",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    // Cancel the first invite, then invite the same username again.
    const cancelRes = await app.request(`/api/admin/invites/${cancelled.id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(cancelRes.status).toBe(204);

    const res = await postInvite(app, {
      username: "carol",
      bucket,
      prefix: "users/carol/",
    });

    expect(res.status).toBe(201);
    // The cancelled invite is gone, so no duplicate-pending conflict.
    expect(getInviteByToken(db, "cancelled-invite")).toBeNull();
  });

  it("rejects invalid username, bucket, prefix and body shapes with 400", async () => {
    const { app, db, calls } = createAdminApp();

    const badBodies: unknown[] = [
      { username: "Alice!", bucket, prefix: "users/alice/" },
      { username: "alice", bucket: "Invalid_Bucket_Name", prefix: "u/" },
      { username: "alice", bucket, prefix: "/leading/slash/" },
      { username: "alice", bucket, prefix: "users/../bob/" },
      { username: "alice", bucket, prefix: "u/", isAdmin: "yes" },
      {},
      { username: "alice", bucket },
      "not json",
    ];
    for (const body of badBodies) {
      const res = await postInvite(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = (await res.json()) as { code: string };
      // Malformed shapes carry "bad_request"; validation failures carry
      // "invalid_input"; either way the request is refused.
      expect(["invalid_input", "bad_request"].includes(json.code)).toBe(true);
    }
    // No invite was created by any rejected request.
    expect(listInvites(db)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-admin with 403 and an unsigned request with 401", async () => {
    const { app } = createAdminApp();

    const forbidden = await postInvite(
      app,
      { username: "carol", bucket, prefix: "users/carol/" },
      memberCookie,
    );
    expect(forbidden.status).toBe(403);

    const unsigned = await app.request("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "carol",
        bucket,
        prefix: "users/carol/",
      }),
    });
    expect(unsigned.status).toBe(401);
  });
});

describe("POST /api/admin/invites/:id/resend", () => {
  /** Seed a pending invite and return its id and token. */
  function seedPending(db: Database): { id: string; token: string } {
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "resend-me",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    return { id: invite.id, token: invite.token };
  }

  it("issues a fresh token and a new 48-hour expiry for a pending invite", async () => {
    const { app, db } = createAdminApp();
    const { id } = seedPending(db);
    const before = Date.now();

    const res = await app.request(`/api/admin/invites/${id}/resend`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteResponse;
    expect(body.invite.id).toBe(id);
    expect(body.invite.username).toBe("carol");
    expect(body.invite.status).toBe("pending");
    // The old token no longer resolves to the invite; the link carries
    // the fresh token (the old link is dead).
    expect(getInviteByToken(db, "resend-me")).toBeNull();
    const newToken = body.link.split("token=")[1] as string;
    expect(newToken).not.toBe("resend-me");
    expect(getInviteByToken(db, newToken)?.id).toBe(id);
    const expiresAt = Date.parse(body.invite.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 48 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 48 * 60 * 60 * 1000);
  });

  it("re-activates an expired invite with a fresh token and expiry", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "expired-resend",
      username: "dave",
      bucket,
      prefix: "users/dave/",
      issuedByUserId: admin.id,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const res = await app.request(`/api/admin/invites/${invite.id}/resend`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteResponse;
    expect(body.invite.status).toBe("pending");
    expect(Date.parse(body.invite.expiresAt)).toBeGreaterThan(Date.now());
    expect(getInviteByToken(db, "expired-resend")).toBeNull();
    const newToken = body.link.split("token=")[1] as string;
    expect(getInviteByToken(db, newToken)?.id).toBe(invite.id);
  });

  it("returns 404 for an unknown invite", async () => {
    const { app } = createAdminApp();

    const res = await app.request("/api/admin/invites/no-such-id/resend", {
      method: "POST",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("returns 404 for an already-claimed invite", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "claimed-resend",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    markInviteClaimed(db, invite.id, admin.id);

    const res = await app.request(`/api/admin/invites/${invite.id}/resend`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "invite_claimed" });
  });

  it("refuses a non-admin with 403", async () => {
    const { app, db } = createAdminApp();
    const { id } = seedPending(db);

    const res = await app.request(`/api/admin/invites/${id}/resend`, {
      method: "POST",
      headers: { cookie: memberCookie },
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/admin/invites/:id", () => {
  it("cancels a pending invite (204) and removes it from the listing", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "cancel-pending",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const res = await app.request(`/api/admin/invites/${invite.id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(getInviteByToken(db, "cancel-pending")).toBeNull();
  });

  it("also cancels an expired invite", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "cancel-expired",
      username: "dave",
      bucket,
      prefix: "users/dave/",
      issuedByUserId: admin.id,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const res = await app.request(`/api/admin/invites/${invite.id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(204);
    expect(getInviteByToken(db, "cancel-expired")).toBeNull();
  });

  it("keeps a claimed invite: 404 instead of cancelling", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "cancel-claimed",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    markInviteClaimed(db, invite.id, admin.id);

    const res = await app.request(`/api/admin/invites/${invite.id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "invite_claimed" });
    // The claimed invite record (who claimed it) survives.
    expect(getInviteByToken(db, "cancel-claimed")).not.toBeNull();
  });

  it("returns 404 for an unknown invite", async () => {
    const { app } = createAdminApp();

    const res = await app.request("/api/admin/invites/no-such-id", {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("refuses a non-admin with 403 and an unsigned request with 401", async () => {
    const { app, db } = createAdminApp();
    const { admin } = seededUsers(db);
    const invite = createInvite(db, {
      token: "cancel-forbidden",
      username: "carol",
      bucket,
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const forbidden = await app.request(`/api/admin/invites/${invite.id}`, {
      method: "DELETE",
      headers: { cookie: memberCookie },
    });
    expect(forbidden.status).toBe(403);
    expect(getInviteByToken(db, "cancel-forbidden")).not.toBeNull();

    const unsigned = await app.request(`/api/admin/invites/${invite.id}`, {
      method: "DELETE",
    });
    expect(unsigned.status).toBe(401);
  });
});
