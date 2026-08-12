import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import { createS3Client } from "../src/s3/client";
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
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
  },
  bootstrapAdmin: { username: null, bucket: null, prefix: "", isAdmin: true },
  webauthn: { rpId: "localhost", origin: "http://localhost:5173" },
};

const userPrefix = "users/alice/";
const bucket = "jivedrive-prod";

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

/** The session cookie for a signed-in alice. */
const aliceCookie = "jivedrive_session=session-token-alice";

/** A stub recording what commands were sent to S3. */
interface CallRecord {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Create an app over a fresh in-memory database with a seeded user and a
 * recording S3 stub.
 *
 * @param handler - optional handler; defaults to an empty listing
 * @returns app, db and the recorded S3 calls
 */
function createFilesApp(
  handler?: (commandName: string, input: Record<string, unknown>) => unknown,
): { app: ReturnType<typeof createApp>; db: Database; calls: CallRecord[] } {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket,
    prefix: userPrefix,
  });
  createSession(db, alice.id, { token: "session-token-alice" });
  const calls: CallRecord[] = [];
  const client = stubS3Client((name, input) => {
    calls.push({ name, input });
    if (handler) return handler(name, input);
    return { Contents: [], CommonPrefixes: [], IsTruncated: false };
  });
  const app = createApp({ config, db, s3Client: client });
  return { app, db, calls };
}

describe("GET /api/files", () => {
  it("returns folders and files with mapped names, sizes and timestamps", async () => {
    const { app } = createFilesApp((name) => {
      expect(name).toBe("ListObjectsV2Command");
      return {
        Contents: [
          {
            Key: "users/alice/a.txt",
            Size: 10,
            LastModified: new Date("2026-08-12T00:00:00Z"),
          },
          {
            Key: "users/alice/c.txt",
            Size: 20,
            LastModified: new Date("2026-08-13T00:00:00Z"),
          },
        ],
        CommonPrefixes: [{ Prefix: "users/alice/docs/" }],
        IsTruncated: false,
      };
    });

    const res = await app.request("/api/files", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: string[];
      files: Array<{
        key: string;
        name: string;
        size: number;
        lastModified: string;
      }>;
      nextCursor: string | null;
    };
    expect(body.folders).toEqual(["docs"]);
    expect(body.files).toEqual([
      {
        key: "users/alice/a.txt",
        name: "a.txt",
        size: 10,
        lastModified: "2026-08-12T00:00:00.000Z",
      },
      {
        key: "users/alice/c.txt",
        name: "c.txt",
        size: 20,
        lastModified: "2026-08-13T00:00:00.000Z",
      },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("lists a subfolder by joining the relative prefix to the user's prefix", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request("/api/files?prefix=docs/reports", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/docs/reports/",
      Delimiter: "/",
      MaxKeys: 1000,
    });
  });

  it("lists the user's space root when no prefix is given", async () => {
    const { app, calls } = createFilesApp();

    await app.request("/api/files", { headers: { cookie: aliceCookie } });

    expect(calls[0]?.input).toMatchObject({
      Prefix: "users/alice/",
      Delimiter: "/",
    });
  });

  it("passes the cursor through and reports the next cursor", async () => {
    const { app } = createFilesApp((name, input) => {
      expect(name).toBe("ListObjectsV2Command");
      expect(input.ContinuationToken).toBe("token-1");
      return {
        Contents: [],
        CommonPrefixes: [],
        IsTruncated: true,
        NextContinuationToken: "token-2",
      };
    });

    const res = await app.request("/api/files?cursor=token-1", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBe("token-2");
  });

  it("returns an empty listing for an empty folder", async () => {
    const { app } = createFilesApp();

    const res = await app.request("/api/files?prefix=empty", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [],
      files: [],
      nextCursor: null,
    });
  });

  it("rejects a prefix that escapes the user's space", async () => {
    const { app, calls } = createFilesApp();

    for (const bad of ["../bob", "/etc", "a/../../bob"]) {
      const res = await app.request(
        `/api/files?prefix=${encodeURIComponent(bad)}`,
        { headers: { cookie: aliceCookie } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_prefix" });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("returns a JSON error for unknown file routes", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files/unknown", {
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });
});

describe("GET /api/files/download-url", () => {
  it("returns a short-lived presigned GET URL without contacting storage", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request(
      "/api/files/download-url?key=users%2Falice%2Fa.txt",
      { headers: { cookie: aliceCookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/a.txt",
    );
    // Short-lived: 15 minutes per the phase contract.
    expect(body.url).toContain("X-Amz-Expires=900");
    expect(body.url).toContain("X-Amz-Signature");
    // The URL is generated without a head request or any storage call.
    expect(calls).toHaveLength(0);
  });

  it("URL-encodes special characters in the key", async () => {
    const { app } = createFilesApp();

    const res = await app.request(
      `/api/files/download-url?key=${encodeURIComponent(
        "users/alice/my file #1?.txt",
      )}`,
      { headers: { cookie: aliceCookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain(encodeURIComponent("my file #1?.txt"));
  });

  it("rejects a key outside the user's prefix", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request(
      "/api/files/download-url?key=users%2Fbob%2Fa.txt",
      { headers: { cookie: aliceCookie } },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing key", async () => {
    const { app } = createFilesApp();

    const res = await app.request("/api/files/download-url", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request(
      "/api/files/download-url?key=users%2Falice%2Fa.txt",
    );
    expect(res.status).toBe(401);
  });
});
