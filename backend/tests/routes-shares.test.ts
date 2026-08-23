import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import { createS3Client } from "../src/s3/client";
import type { ServerEnv } from "../src/server";
import type { AppConfig } from "../src/config";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A config whose S3 endpoint is used only for local URL signing. */
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

/** The session cookie for a signed-in alice. */
const aliceCookie = "jivedrive_session=session-token-alice";
/** The session cookie for a signed-in bob (the share recipient). */
const bobCookie = "jivedrive_session=session-token-bob";

/** The outgoing share shape per the contract `ShareOutgoing` schema. */
interface ShareOutgoingBody {
  id: string;
  folder: string;
  folderName: string;
  recipient: { id: string; username: string };
  createdAt: string;
}

/** The incoming share shape per the contract `ShareIncoming` schema. */
interface ShareIncomingBody {
  id: string;
  folder: string;
  folderName: string;
  sharer: { id: string; username: string };
}

/** The response of GET /api/shares. */
interface ListSharesBody {
  incoming: ShareIncomingBody[];
  outgoing: ShareOutgoingBody[];
}

/** The response of POST /api/shares. */
interface CreateShareBody {
  share: ShareOutgoingBody;
}

/** The JSON error body of a refused request. */
interface ErrorBody {
  error: string;
  code: string;
}

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/**
 * Create an app over a fresh in-memory database seeded with alice and bob,
 * each with a session cookie mirroring the routes-files fixtures.
 *
 * @param s3Client - optional S3 client; defaults to a real signing client
 *   (used only for local URL signing, never network). Pass a recording
 *   stub when a test must prove no storage call happened.
 * @returns app, db and the two user ids
 */
function createSharesApp(s3Client?: S3Client): {
  app: TestApp;
  db: Database;
  aliceId: string;
  bobId: string;
} {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket,
    prefix: "users/alice/",
  });
  const bob = createUser(db, {
    username: "bob",
    bucket,
    prefix: "users/bob/",
  });
  createSession(db, alice.id, { token: "session-token-alice" });
  createSession(db, bob.id, { token: "session-token-bob" });
  const app = createApp({ config, db, s3Client });
  return { app, db, aliceId: alice.id, bobId: bob.id };
}

/**
 * POST a create-share request as the given cookie user.
 *
 * @param app - the test app
 * @param body - the JSON body (folder + recipientUsername)
 * @param cookie - session cookie, defaults to alice
 * @returns the response
 */
function postShare(
  app: TestApp,
  body: Record<string, unknown>,
  cookie = aliceCookie,
) {
  return app.request("/api/shares", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Assert that a response is a JSON error with the expected code.
 *
 * @param res - the response
 * @param status - expected HTTP status
 * @param code - expected machine-readable error code
 */
async function expectError(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ErrorBody;
  expect(body.code).toBe(code);
}

/**
 * Build an S3 client whose `send` is stubbed but whose config and
 * middleware stack are real, so presigning works without network access.
 *
 * @param handler - receives the command constructor name and input
 * @returns the stubbed S3 client
 */
function stubS3Client(
  handler: (commandName: string, input: Record<string, unknown>) => unknown,
): S3Client {
  const client = createS3Client(config.s3);
  client.send = (async (command: unknown) =>
    handler(
      (command as { constructor: { name: string } }).constructor.name,
      (command as { input: Record<string, unknown> }).input ?? {},
    )) as unknown as S3Client["send"];
  return client;
}

describe("POST /api/shares", () => {
  it("creates a share: 201, the stored row, and the contract response shape", async () => {
    const { app, db, aliceId, bobId } = createSharesApp();

    const res = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateShareBody;
    expect(body.share.id).toBeTruthy();
    expect(body.share).toMatchObject({
      folder: "projects/",
      folderName: "projects",
      recipient: { id: bobId, username: "bob" },
    });
    expect(typeof body.share.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.share.createdAt))).toBe(false);

    // The row is stored with the caller as owner and the recipient user.
    const row = db
      .query("SELECT * FROM shares WHERE id = ?")
      .get(body.share.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      ownerUserId: aliceId,
      recipientUserId: bobId,
      folder: "projects/",
    });
  });

  it("refuses the space root ('' and '/') with 400 invalid_folder", async () => {
    const { app } = createSharesApp();

    for (const folder of ["", "/"]) {
      const res = await postShare(app, { folder, recipientUsername: "bob" });
      await expectError(res, 400, "invalid_folder");
    }
  });

  it("refuses unsafe folders ('..' segments and absolute paths) with 400 invalid_folder", async () => {
    const { app } = createSharesApp();

    for (const folder of ["../x", "a/../b", "..", "/abs", "//abs"]) {
      const res = await postShare(app, { folder, recipientUsername: "bob" });
      await expectError(res, 400, "invalid_folder");
    }
  });

  it("refuses sharing a folder with yourself (400 cannot_share_with_self)", async () => {
    const { app } = createSharesApp();

    const res = await postShare(app, {
      folder: "projects",
      recipientUsername: "alice",
    });

    await expectError(res, 400, "cannot_share_with_self");
  });

  it("refuses an unknown recipient username (404 user_not_found)", async () => {
    const { app } = createSharesApp();

    const res = await postShare(app, {
      folder: "projects",
      recipientUsername: "nobody",
    });

    await expectError(res, 404, "user_not_found");
  });

  it("refuses a duplicate share with 409 and leaves the existing share unchanged", async () => {
    const { app, db } = createSharesApp();

    const first = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    expect(first.status).toBe(201);

    // Same folder string again: 409.
    const second = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    await expectError(second, 409, "already_shared");

    // A trailing-slash variant normalises to the same folder and hits the
    // same unique row: 409, still exactly one share.
    const third = await postShare(app, {
      folder: "projects/",
      recipientUsername: "bob",
    });
    await expectError(third, 409, "already_shared");

    const count = db.query("SELECT COUNT(*) AS n FROM shares").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("refuses missing or non-string body fields (400 bad_request)", async () => {
    const { app } = createSharesApp();

    const missingFolder = await postShare(app, { recipientUsername: "bob" });
    await expectError(missingFolder, 400, "bad_request");

    const missingRecipient = await postShare(app, { folder: "projects" });
    await expectError(missingRecipient, 400, "bad_request");

    const nonStringFolder = await postShare(app, {
      folder: 42,
      recipientUsername: "bob",
    });
    await expectError(nonStringFolder, 400, "bad_request");

    const nonStringRecipient = await postShare(app, {
      folder: "projects",
      recipientUsername: ["bob"],
    });
    await expectError(nonStringRecipient, 400, "bad_request");

    const invalidJson = await app.request("/api/shares", {
      method: "POST",
      headers: { cookie: aliceCookie, "content-type": "application/json" },
      body: "{not json",
    });
    await expectError(invalidJson, 400, "bad_request");
  });

  it("requires a session (401)", async () => {
    const { app } = createSharesApp();

    const res = await app.request("/api/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "projects", recipientUsername: "bob" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/shares", () => {
  it("lists outgoing shares with recipient identity and createdAt", async () => {
    const { app, bobId } = createSharesApp();
    await postShare(app, { folder: "projects", recipientUsername: "bob" });

    const res = await app.request("/api/shares", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ListSharesBody;
    expect(body.incoming).toEqual([]);
    expect(body.outgoing).toHaveLength(1);
    const outgoing = body.outgoing[0]!;
    expect(outgoing).toMatchObject({
      folder: "projects/",
      folderName: "projects",
      recipient: { id: bobId, username: "bob" },
    });
    expect(typeof outgoing.id).toBe("string");
    expect(typeof outgoing.createdAt).toBe("string");
  });

  it("lists incoming shares with sharer identity (no createdAt on incoming)", async () => {
    const { app, aliceId } = createSharesApp();
    await postShare(app, { folder: "projects", recipientUsername: "bob" });

    const res = await app.request("/api/shares", {
      headers: { cookie: bobCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ListSharesBody;
    expect(body.outgoing).toEqual([]);
    expect(body.incoming).toHaveLength(1);
    const incoming = body.incoming[0]!;
    expect(incoming).toMatchObject({
      folder: "projects/",
      folderName: "projects",
      sharer: { id: aliceId, username: "alice" },
    });
    expect(typeof incoming.id).toBe("string");
    // The contract `ShareIncoming` schema has no createdAt.
    expect("createdAt" in incoming).toBe(false);
  });

  it("derives folderName as the base name of the shared folder", async () => {
    const { app } = createSharesApp();
    await postShare(app, {
      folder: "projects/docs",
      recipientUsername: "bob",
    });

    const res = await app.request("/api/shares", {
      headers: { cookie: aliceCookie },
    });

    const body = (await res.json()) as ListSharesBody;
    expect(body.outgoing).toHaveLength(1);
    expect(body.outgoing[0]).toMatchObject({
      folder: "projects/docs/",
      folderName: "docs",
    });
  });

  it("returns empty incoming and outgoing lists when there are no shares", async () => {
    const { app } = createSharesApp();

    const res = await app.request("/api/shares", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ incoming: [], outgoing: [] });
  });

  it("requires a session (401)", async () => {
    const { app } = createSharesApp();

    const res = await app.request("/api/shares");

    expect(res.status).toBe(401);
  });
});
describe("DELETE /api/shares/:id", () => {
  it("revokes a share as the owner: 204, an empty body, and the row is gone", async () => {
    const { app, db } = createSharesApp();
    const created = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as CreateShareBody;

    const res = await app.request(`/api/shares/${share.id}`, {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // R6: hard delete — the row is gone and the owner's outgoing list no
    // longer shows the share.
    const row = db.query("SELECT * FROM shares WHERE id = ?").get(share.id);
    expect(row).toBeNull();
    const list = await app.request("/api/shares", {
      headers: { cookie: aliceCookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as ListSharesBody;
    expect(body.outgoing).toEqual([]);
  });

  it("refuses a non-owner revoking with 404 and leaves the row untouched (no existence leak)", async () => {
    const { app, db } = createSharesApp();
    const created = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    const { share } = (await created.json()) as CreateShareBody;

    // bob tries to revoke alice's share of `projects`: 404 `not_found`,
    // identical to an unknown id (R6) — bob cannot tell the share exists.
    const res = await app.request(`/api/shares/${share.id}`, {
      method: "DELETE",
      headers: { cookie: bobCookie },
    });
    await expectError(res, 404, "not_found");

    const row = db.query("SELECT * FROM shares WHERE id = ?").get(share.id);
    expect(row).not.toBeNull();
  });

  it("refuses an unknown id with 404 not_found", async () => {
    const { app } = createSharesApp();

    const res = await app.request("/api/shares/does-not-exist", {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });

    await expectError(res, 404, "not_found");
  });

  it("refuses every /api/files operation in the space after revocation (404, no S3 call)", async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = stubS3Client((name, input) => {
      calls.push({ name, input });
      return { Contents: [], CommonPrefixes: [], IsTruncated: false };
    });
    const { app } = createSharesApp(client);
    const created = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as CreateShareBody;

    // Revoke via the route — the behaviour under test.
    const revoke = await app.request(`/api/shares/${share.id}`, {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });
    expect(revoke.status).toBe(204);

    // R6: enforcement happens at resolution time, so every operation in
    // the former space now resolves to 404 before touching storage.
    const space = `shared:${share.id}`;
    const spaceParam = `space=${encodeURIComponent(space)}`;

    let res = await app.request(`/api/files?${spaceParam}`, {
      headers: { cookie: bobCookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });

    res = await app.request(
      `/api/files/download-url?${spaceParam}&key=${encodeURIComponent("plan.txt")}`,
      { headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        space,
        folder: "",
        fileName: "a.txt",
        overwrite: false,
      }),
    });
    expect(res.status).toBe(404);

    res = await app.request(
      `/api/files?${spaceParam}&key=${encodeURIComponent("plan.txt")}`,
      { method: "DELETE", headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/share-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ space, key: "plan.txt" }),
    });
    expect(res.status).toBe(404);

    // The space resolver refused before any storage command: no S3 call.
    expect(calls).toHaveLength(0);
  });

  it("re-shares the same folder with the same recipient after revocation (201 fresh row)", async () => {
    const { app } = createSharesApp();
    const created = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    const { share: first } = (await created.json()) as CreateShareBody;

    const revoke = await app.request(`/api/shares/${first.id}`, {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });
    expect(revoke.status).toBe(204);

    // US4 sc.5: the unique (owner, recipient, folder) row is gone, so a
    // fresh share of the same folder to the same recipient succeeds.
    const again = await postShare(app, {
      folder: "projects",
      recipientUsername: "bob",
    });
    expect(again.status).toBe(201);
    const body = (await again.json()) as CreateShareBody;
    expect(body.share.id).not.toBe(first.id);
    expect(body.share).toMatchObject({
      folder: "projects/",
      folderName: "projects",
      recipient: { username: "bob" },
    });
  });

  it("requires a session (401)", async () => {
    const { app } = createSharesApp();

    const res = await app.request("/api/shares/some-id", {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });
});
