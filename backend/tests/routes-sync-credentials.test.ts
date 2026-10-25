import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  createSyncCredential,
  createUser,
  getSyncCredential,
  getUserById,
  listSyncCredentials,
} from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import type { AppConfig } from "../src/config";
import type { Hono } from "hono";
import type { ServerEnv } from "../src/server";
import {
  FAKE_OVH_ENDPOINT,
  FAKE_OVH_PROJECT_ID,
  createFakeOvh,
} from "./ovh-test-helpers";
import type { FakeOvh } from "./ovh-test-helpers";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A config with OVH sync enabled against the fake OVH API. */
const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  searchScanIntervalSeconds: 3600,
  searchIndexMaxBytes: 10485760,
  rateLimit: {
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
    authPerMinute: 20,
    authBurst: 10,
    filesPerMinute: 300,
    filesBurst: 100,
    trustProxy: false,
  },
  s3: {
    endpoint: "https://s3.ca-east-tor.io.cloud.ovh.net",
    region: "ca-east-tor",
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
  ovh: {
    endpoint: FAKE_OVH_ENDPOINT,
    applicationKey: "app-key",
    applicationSecret: "app-secret",
    consumerKey: "consumer-key",
    projectId: FAKE_OVH_PROJECT_ID,
  },
};

const bucket = "jivedrive-prod";
const usersPath = `/cloud/project/${FAKE_OVH_PROJECT_ID}/user`;

const aliceCookie = "jivedrive_session=alice-session";
const bobCookie = "jivedrive_session=bob-session";
const wildCookie = "jivedrive_session=wild-session";
const adminCookie = "jivedrive_session=admin-session";

/** A credential entry in the list and create responses. */
interface CredentialBody {
  accessKeyId: string;
  label: string;
  createdAt: string;
}

/** The response of GET /api/sync-credentials. */
interface ListBody {
  enabled: boolean;
  credentials: CredentialBody[];
  limit: number;
}

/** The response of POST /api/sync-credentials. */
interface CreateBody {
  credential: CredentialBody;
  secretAccessKey: string;
  rcloneConfig: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
}

/** The JSON error body of a refused request. */
interface ErrorBody {
  error: string;
  code: string;
}

/**
 * Create an app over a fresh in-memory database seeded with alice, bob,
 * an admin and "wild" (whose prefix contains a wildcard), each signed in.
 *
 * @param options - config override (e.g. OVH disabled)
 * @returns app, db, the fake OVH API and the seeded user ids
 */
function createSyncApp(options: { config?: AppConfig } = {}) {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket,
    prefix: "users/alice/",
  });
  createSession(db, alice.id, { token: "alice-session" });
  const bob = createUser(db, { username: "bob", bucket, prefix: "users/bob/" });
  createSession(db, bob.id, { token: "bob-session" });
  const wild = createUser(db, {
    username: "wild",
    bucket,
    prefix: "users/w*ld/",
  });
  createSession(db, wild.id, { token: "wild-session" });
  const admin = createUser(db, {
    username: "admin",
    bucket,
    prefix: "users/admin/",
    isAdmin: true,
  });
  createSession(db, admin.id, { token: "admin-session" });
  const ovh = createFakeOvh();
  const app = createApp({
    config: options.config ?? config,
    db,
    ovhFetch: ovh.fetch,
  });
  return { app, db, ovh, aliceId: alice.id, bobId: bob.id };
}

/** POST a new key with the given cookie and label. */
function createKey(
  app: Hono<ServerEnv>,
  cookie: string,
  label: unknown = "laptop",
) {
  return app.request("/api/sync-credentials", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
}

/** The fake's calls as "METHOD path" strings. */
function callLines(ovh: FakeOvh): string[] {
  return ovh.calls.map((call) => `${call.method} ${call.path}`);
}

/**
 * Insert a key row directly (its OVH user need not exist in the fake).
 */
function seedKey(
  db: Database,
  userId: string,
  accessKeyId: string,
  createdAt?: string,
  label = "key",
  ovhUserId = "999",
): void {
  createSyncCredential(db, {
    accessKeyId,
    userId,
    ovhUserId,
    label,
    createdAt,
  });
}

describe("GET /api/sync-credentials", () => {
  it("requires a signed-in user", async () => {
    const { app } = createSyncApp();
    const res = await app.request("/api/sync-credentials");
    expect(res.status).toBe(401);
  });

  it("lists only the caller's keys, newest first, with the cap", async () => {
    const { app, db, aliceId, bobId } = createSyncApp();
    seedKey(db, aliceId, "AK-OLD", "2026-10-01T00:00:00.000Z", "laptop");
    seedKey(db, aliceId, "AK-NEW", "2026-10-20T00:00:00.000Z", "desktop");
    seedKey(db, bobId, "AK-BOB");

    const res = await app.request("/api/sync-credentials", {
      headers: { Cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as ListBody).toEqual({
      enabled: true,
      credentials: [
        {
          accessKeyId: "AK-NEW",
          label: "desktop",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
        {
          accessKeyId: "AK-OLD",
          label: "laptop",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      limit: 10,
    });
  });

  it("reports disabled with no credentials when OVH is unconfigured", async () => {
    const { app, db, aliceId } = createSyncApp({
      config: { ...config, ovh: null },
    });
    seedKey(db, aliceId, "AK1");

    const res = await app.request("/api/sync-credentials", {
      headers: { Cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as ListBody).toEqual({
      enabled: false,
      credentials: [],
      limit: 10,
    });
  });
});

describe("POST /api/sync-credentials", () => {
  it("provisions a dedicated OVH user for the key, then issues it", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();

    const res = await createKey(app, aliceCookie, "  My laptop  ");

    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateBody;
    expect(body.credential.accessKeyId).toBe("AK0001");
    expect(body.credential.label).toBe("My laptop");
    expect(Number.isNaN(Date.parse(body.credential.createdAt))).toBe(false);
    expect(body.secretAccessKey).toBe("SECRET1");
    expect(body.endpoint).toBe(config.s3.endpoint);
    expect(body.region).toBe("ca-east-tor");
    expect(body.bucket).toBe(bucket);
    expect(body.prefix).toBe("users/alice/");
    expect(body.rcloneConfig).toContain("access_key_id = AK0001");
    expect(body.rcloneConfig).toContain("secret_access_key = SECRET1");
    expect(body.rcloneConfig).toContain(
      "remote = jivedrive-s3:jivedrive-prod/users/alice/",
    );

    // Create user, wait for ok, set the policy, then mint the key.
    expect(callLines(ovh)).toEqual([
      `POST ${usersPath}`,
      `GET ${usersPath}/100`,
      `POST ${usersPath}/100/policy`,
      `POST ${usersPath}/100/s3Credentials`,
    ]);
    expect(JSON.parse(ovh.calls[0]!.body)).toEqual({
      description: "jivedrive:alice",
      role: "objectstore_operator",
    });
    const policy = JSON.parse(ovh.users.get(100)!.policy!) as {
      Statement: Array<{ Resource: string[] }>;
    };
    expect(policy.Statement[1]!.Resource).toEqual([
      "arn:aws:s3:::jivedrive-prod/users/alice/*",
    ]);

    // The secret is never stored; the row records the key's OVH user.
    expect(getSyncCredential(db, "AK0001")).toEqual({
      accessKeyId: "AK0001",
      userId: aliceId,
      ovhUserId: "100",
      label: "My laptop",
      createdAt: body.credential.createdAt,
    });
  });

  it("gives every key its own OVH user", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    expect((await createKey(app, aliceCookie, "one")).status).toBe(201);
    ovh.calls.length = 0;

    const res = await createKey(app, aliceCookie, "two");

    expect(res.status).toBe(201);
    expect(callLines(ovh)).toEqual([
      `POST ${usersPath}`,
      `GET ${usersPath}/101`,
      `POST ${usersPath}/101/policy`,
      `POST ${usersPath}/101/s3Credentials`,
    ]);
    expect(ovh.users.size).toBe(2);
    expect(
      listSyncCredentials(db, aliceId)
        .map((c) => c.ovhUserId)
        .sort(),
    ).toEqual(["100", "101"]);
  });

  it("validates the label: trimmed, 1-64 characters", async () => {
    const { app, ovh } = createSyncApp();
    for (const label of ["", "   ", "x".repeat(65), 42, null]) {
      const res = await createKey(app, aliceCookie, label);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).code).toBe("invalid_label");
    }
    expect(ovh.calls).toEqual([]);
    expect((await createKey(app, aliceCookie, "x".repeat(64))).status).toBe(
      201,
    );
  });

  it("caps a user at 10 keys", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    for (let i = 0; i < 10; i++) seedKey(db, aliceId, `AK-${i}`);

    const res = await createKey(app, aliceCookie);

    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe("credential_limit");
    expect(ovh.calls).toEqual([]);
  });

  it("holds the cap under concurrent creates", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    for (let i = 0; i < 9; i++) seedKey(db, aliceId, `AK-${i}`);

    const responses = await Promise.all([
      createKey(app, aliceCookie, "one"),
      createKey(app, aliceCookie, "two"),
    ]);

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(listSyncCredentials(db, aliceId)).toHaveLength(10);
    expect(ovh.users.size).toBe(1);
  });

  it("refuses with 503 when OVH is unconfigured", async () => {
    const { app, ovh } = createSyncApp({ config: { ...config, ovh: null } });
    const res = await createKey(app, aliceCookie);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).code).toBe("sync_disabled");
    expect(ovh.calls).toEqual([]);
  });

  it("refuses a prefix with a wildcard character (409 unsupported_prefix)", async () => {
    const { app, ovh } = createSyncApp();
    const res = await createKey(app, wildCookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe("unsupported_prefix");
    expect(ovh.calls).toEqual([]);
  });

  it("returns 502 and deletes the half-made OVH user when the policy fails", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    ovh.failures.push({
      method: "POST",
      path: /\/policy$/,
      status: 500,
      times: 1,
    });

    const res = await createKey(app, aliceCookie);

    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("storage_provider_error");
    expect(body.error.length).toBeGreaterThan(0);
    expect(callLines(ovh)).toContain(`DELETE ${usersPath}/100`);
    expect(ovh.users.size).toBe(0);
    expect(listSyncCredentials(db, aliceId)).toEqual([]);

    // A retry provisions afresh and succeeds.
    expect((await createKey(app, aliceCookie)).status).toBe(201);
    expect(ovh.users.size).toBe(1);
  });

  it("returns 502 and deletes the half-made OVH user when minting the key fails", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    ovh.failures.push({
      method: "POST",
      path: /\/s3Credentials$/,
      status: 500,
      times: 1,
    });

    const res = await createKey(app, aliceCookie);

    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).code).toBe(
      "storage_provider_error",
    );
    expect(callLines(ovh)).toContain(`DELETE ${usersPath}/100`);
    expect(ovh.users.size).toBe(0);
    expect(listSyncCredentials(db, aliceId)).toEqual([]);
  });

  it("returns 502 when creating the OVH user fails", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    ovh.failures.push({ method: "POST", path: /\/user$/, status: 500 });

    const res = await createKey(app, aliceCookie);

    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).code).toBe(
      "storage_provider_error",
    );
    expect(callLines(ovh)).toEqual([`POST ${usersPath}`]);
    expect(listSyncCredentials(db, aliceId)).toEqual([]);
  });
});

describe("DELETE /api/sync-credentials/:accessKeyId", () => {
  /** DELETE a key with the given cookie. */
  function revoke(app: Hono<ServerEnv>, cookie: string, accessKeyId: string) {
    return app.request(`/api/sync-credentials/${accessKeyId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
  }

  it("denies everything, deletes the key, then the OVH user, then the row", async () => {
    const { app, db, ovh } = createSyncApp();
    expect((await createKey(app, aliceCookie)).status).toBe(201);
    ovh.calls.length = 0;

    const res = await revoke(app, aliceCookie, "AK0001");

    expect(res.status).toBe(204);
    expect(callLines(ovh)).toEqual([
      `POST ${usersPath}/100/policy`,
      `DELETE ${usersPath}/100/s3Credentials/AK0001`,
      `DELETE ${usersPath}/100`,
    ]);
    const sent = JSON.parse(ovh.calls[0]!.body) as { policy: string };
    expect(JSON.parse(sent.policy)).toEqual({
      Statement: [
        {
          Sid: "DenyAll",
          Effect: "Deny",
          Action: ["s3:*"],
          Resource: ["*"],
        },
      ],
    });
    expect(ovh.keys.size).toBe(0);
    expect(ovh.users.size).toBe(0);
    expect(getSyncCredential(db, "AK0001")).toBeNull();
  });

  it("revokes only the chosen key, leaving the user's other keys alone", async () => {
    const { app, db, ovh } = createSyncApp();
    expect((await createKey(app, aliceCookie, "one")).status).toBe(201);
    expect((await createKey(app, aliceCookie, "two")).status).toBe(201);

    expect((await revoke(app, aliceCookie, "AK0001")).status).toBe(204);

    expect([...ovh.users.keys()]).toEqual([101]);
    expect(ovh.keys.has("AK0002")).toBe(true);
    expect(ovh.users.get(101)!.policy).toContain("OwnObjects");
    expect(getSyncCredential(db, "AK0002")).not.toBeNull();
  });

  it("returns 404 for another user's key and never touches it", async () => {
    const { app, db, ovh } = createSyncApp();
    expect((await createKey(app, aliceCookie)).status).toBe(201);
    ovh.calls.length = 0;

    for (const id of ["AK0001", "AK-UNKNOWN"]) {
      const res = await revoke(app, bobCookie, id);
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).code).toBe("not_found");
    }
    expect(ovh.calls).toEqual([]);
    expect(getSyncCredential(db, "AK0001")).not.toBeNull();
  });

  it("treats an OVH 404 at every step as already done", async () => {
    const { app, db, aliceId, ovh } = createSyncApp();
    seedKey(db, aliceId, "AK-GONE");

    const res = await revoke(app, aliceCookie, "AK-GONE");

    expect(res.status).toBe(204);
    expect(callLines(ovh)).toEqual([
      `POST ${usersPath}/999/policy`,
      `DELETE ${usersPath}/999/s3Credentials/AK-GONE`,
      `DELETE ${usersPath}/999`,
    ]);
    expect(getSyncCredential(db, "AK-GONE")).toBeNull();
  });

  it("returns 502 and keeps the row when denying fails, with no further calls", async () => {
    const { app, db, ovh } = createSyncApp();
    expect((await createKey(app, aliceCookie)).status).toBe(201);
    ovh.calls.length = 0;
    ovh.failures.push({ method: "POST", path: /\/policy$/, status: 500 });

    const res = await revoke(app, aliceCookie, "AK0001");

    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).code).toBe(
      "storage_provider_error",
    );
    expect(callLines(ovh)).toEqual([`POST ${usersPath}/100/policy`]);
    expect(getSyncCredential(db, "AK0001")).not.toBeNull();
    expect(ovh.keys.has("AK0001")).toBe(true);
  });

  it("returns 502 when deleting the OVH user fails, and a retry finishes the job", async () => {
    const { app, db, ovh } = createSyncApp();
    expect((await createKey(app, aliceCookie)).status).toBe(201);
    ovh.failures.push({
      method: "DELETE",
      path: /\/user\/100$/,
      status: 500,
      times: 1,
    });

    const first = await revoke(app, aliceCookie, "AK0001");

    expect(first.status).toBe(502);
    expect(getSyncCredential(db, "AK0001")).not.toBeNull();
    expect(ovh.keys.has("AK0001")).toBe(false);
    expect(ovh.users.size).toBe(1);

    ovh.calls.length = 0;
    const retry = await revoke(app, aliceCookie, "AK0001");

    expect(retry.status).toBe(204);
    expect(callLines(ovh)).toEqual([
      `POST ${usersPath}/100/policy`,
      `DELETE ${usersPath}/100/s3Credentials/AK0001`,
      `DELETE ${usersPath}/100`,
    ]);
    expect(ovh.users.size).toBe(0);
    expect(getSyncCredential(db, "AK0001")).toBeNull();
  });

  it("refuses with 503 when OVH is unconfigured", async () => {
    const { app, db, aliceId } = createSyncApp({
      config: { ...config, ovh: null },
    });
    seedKey(db, aliceId, "AK1");

    const res = await revoke(app, aliceCookie, "AK1");

    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).code).toBe("sync_disabled");
    expect(getSyncCredential(db, "AK1")).not.toBeNull();
  });
});

describe("DELETE /api/admin/users with sync credentials", () => {
  /** DELETE a user id with the admin cookie. */
  function removeUser(app: Hono<ServerEnv>, id: string) {
    return app.request(`/api/admin/users?id=${id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
  }

  it("revokes every key of the user first, then deletes the user", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    expect((await createKey(app, aliceCookie, "one")).status).toBe(201);
    expect((await createKey(app, aliceCookie, "two")).status).toBe(201);
    ovh.calls.length = 0;

    const res = await removeUser(app, aliceId);

    expect(res.status).toBe(204);
    expect(callLines(ovh).sort()).toEqual(
      [
        `POST ${usersPath}/100/policy`,
        `DELETE ${usersPath}/100/s3Credentials/AK0001`,
        `DELETE ${usersPath}/100`,
        `POST ${usersPath}/101/policy`,
        `DELETE ${usersPath}/101/s3Credentials/AK0002`,
        `DELETE ${usersPath}/101`,
      ].sort(),
    );
    expect(ovh.users.size).toBe(0);
    expect(getUserById(db, aliceId)).toBeNull();
    expect(listSyncCredentials(db, aliceId)).toEqual([]);
  });

  it("aborts with 502 on the first failure, keeping the user and unrevoked keys", async () => {
    const { app, db, ovh, aliceId } = createSyncApp();
    seedKey(db, aliceId, "AK-A", "2026-10-01T00:00:00.000Z", "a", "200");
    seedKey(db, aliceId, "AK-B", "2026-10-02T00:00:00.000Z", "b", "201");
    // Keys are revoked newest first: AK-B (OVH user 201) is fully revoked,
    // then deleting AK-A's OVH user (200) fails.
    ovh.failures.push({ method: "DELETE", path: /\/user\/200$/, status: 500 });

    const res = await removeUser(app, aliceId);

    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).code).toBe(
      "storage_provider_error",
    );
    expect(getUserById(db, aliceId)).not.toBeNull();
    expect(listSyncCredentials(db, aliceId).map((c) => c.accessKeyId)).toEqual([
      "AK-A",
    ]);
  });

  it("makes no OVH call for a user without keys", async () => {
    const { app, db, ovh, bobId } = createSyncApp();

    const res = await removeUser(app, bobId);

    expect(res.status).toBe(204);
    expect(ovh.calls).toEqual([]);
    expect(getUserById(db, bobId)).toBeNull();
  });

  it("refuses with 503 when the user has keys but OVH is unconfigured", async () => {
    const { app, db, aliceId } = createSyncApp({
      config: { ...config, ovh: null },
    });
    seedKey(db, aliceId, "AK1");

    const res = await removeUser(app, aliceId);

    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).code).toBe("sync_disabled");
    expect(getUserById(db, aliceId)).not.toBeNull();
  });
});
