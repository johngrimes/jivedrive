/**
 * E2E test server: serves the built SPA and the API on port 5173 with an
 * in-memory database and an in-memory mock S3 object store.
 *
 * Runs via `bun run ../backend/src/e2eServer.ts` from the e2e directory
 * (see playwright.config.ts). The RP ID is `localhost` so passkey
 * ceremonies work against the virtual authenticator.
 *
 * The mock S3 layer has two parts: a fake S3 client injected into the app
 * (serves listings and presigned URLs from an in-memory map) and a mock
 * S3 HTTP server on port 5299 (serves downloads at presigned URLs).
 */
import { resolve } from "node:path";
import { Hono } from "hono";
import type { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "./config";
import { migrateFromDir, openDatabase } from "./db/migrate";
import { createInvite, createUser } from "./db/repository";
import { createApp } from "./server";
import { createS3Client } from "./s3/client";
import { createSession } from "./auth/sessions";

/** An object stored in the mock S3. */
interface MockObject {
  body: string;
  /** Displayed size, which may differ from the body length. */
  size: number;
  /** ISO 8601 timestamp. */
  lastModified: string;
}

/** In-memory mock object store keyed by full object key. */
const objectStore = new Map<string, MockObject>();

/** Port of the mock S3 HTTP server (downloads). */
const MOCK_S3_PORT = 5299;

/**
 * Seed an object into the mock store.
 *
 * @param key - full object key
 * @param body - file content served on download
 * @param size - displayed size, defaults to the body length
 * @param lastModified - ISO timestamp, defaults to a fixed date
 */
function seedObject(
  key: string,
  body: string,
  size?: number,
  lastModified?: string,
): void {
  objectStore.set(key, {
    body,
    size: size ?? Buffer.byteLength(body),
    lastModified:
      lastModified ?? new Date("2026-08-10T12:00:00Z").toISOString(),
  });
}

/**
 * List the direct children of a prefix in the mock store, matching the
 * shape of an S3 ListObjectsV2 response with delimiter "/" and opaque
 * continuation tokens (offsets).
 *
 * @param input - the ListObjectsV2 command input
 * @returns a mock S3 listing response
 */
function listObjectsV2(input: {
  Prefix?: string;
  Delimiter?: string;
  MaxKeys?: number;
  ContinuationToken?: string;
}) {
  const prefix = input.Prefix ?? "";
  const maxKeys = input.MaxKeys ?? 1000;

  const entries: Array<{ kind: "folder" | "file"; key: string }> = [];
  const seenFolders = new Set<string>();
  for (const key of [...objectStore.keys()]
    .filter((k) => k.startsWith(prefix))
    .sort()) {
    const rest = key.slice(prefix.length);
    if (rest === "") continue;
    if (rest.includes("/")) {
      const folder = prefix + rest.slice(0, rest.indexOf("/") + 1);
      if (!seenFolders.has(folder)) {
        seenFolders.add(folder);
        entries.push({ kind: "folder", key: folder });
      }
    } else {
      entries.push({ kind: "file", key });
    }
  }

  let start = 0;
  if (input.ContinuationToken) {
    const offset = Number(
      Buffer.from(input.ContinuationToken, "base64url").toString(),
    );
    if (Number.isInteger(offset) && offset > 0) start = offset;
  }
  const page = entries.slice(start, start + maxKeys);
  const nextStart = start + page.length;
  const isTruncated = nextStart < entries.length;

  return {
    Contents: page
      .filter((entry) => entry.kind === "file")
      .map((entry) => {
        const object = objectStore.get(entry.key);
        return {
          Key: entry.key,
          Size: object?.size ?? 0,
          LastModified: object ? new Date(object.lastModified) : new Date(0),
        };
      }),
    CommonPrefixes: page
      .filter((entry) => entry.kind === "folder")
      .map((entry) => ({ Prefix: entry.key })),
    IsTruncated: isTruncated,
    ...(isTruncated
      ? {
          NextContinuationToken: Buffer.from(String(nextStart)).toString(
            "base64url",
          ),
        }
      : {}),
  };
}

/** The fake S3 client injected into the app for e2e runs. */
function createMockS3Client(): S3Client {
  const client = createS3Client({
    endpoint: `http://localhost:${MOCK_S3_PORT}`,
    region: "gra",
    accessKeyId: "e2e-access-key",
    secretAccessKey: "e2e-secret-key",
  });
  client.send = (async (command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor
      .name;
    const input = (command as { input: Record<string, unknown> }).input ?? {};
    switch (name) {
      case "ListObjectsV2Command":
        return listObjectsV2(input as never);
      case "HeadObjectCommand": {
        const object = objectStore.get(input.Key as string);
        if (!object) {
          const err = new Error("Not Found") as Error & { name: string };
          err.name = "NotFound";
          throw err;
        }
        return {
          ContentLength: object.size,
          LastModified: new Date(object.lastModified),
        };
      }
      case "DeleteObjectCommand":
        objectStore.delete(input.Key as string);
        return {};
      case "GetObjectCommand": {
        const object = objectStore.get(input.Key as string);
        if (!object) {
          const err = new Error("NoSuchKey") as Error & { name: string };
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: object.body };
      }
      default:
        throw new Error(`Unhandled mock S3 command: ${name}`);
    }
  }) as unknown as S3Client["send"];
  return client;
}

const env: Record<string, string | undefined> = {
  ...process.env,
  NODE_ENV: "test",
  // Overridable so verification scripts can run this server on another
  // port with a file-backed database to inspect persistence; Playwright
  // leaves both unset and gets the defaults.
  JIVEDRIVE_PORT: process.env.JIVEDRIVE_PORT ?? "5173",
  JIVEDRIVE_DB_PATH: process.env.JIVEDRIVE_DB_PATH ?? ":memory:",
  JIVEDRIVE_MIGRATIONS_DIR: resolve(import.meta.dir, "../migrations"),
  JIVEDRIVE_S3_ENDPOINT:
    process.env.JIVEDRIVE_S3_ENDPOINT ?? "https://s3.gra.io.cloud.ovh.net",
  JIVEDRIVE_S3_ACCESS_KEY_ID: process.env.JIVEDRIVE_S3_ACCESS_KEY_ID ?? "test",
  JIVEDRIVE_S3_SECRET_ACCESS_KEY:
    process.env.JIVEDRIVE_S3_SECRET_ACCESS_KEY ?? "test",
  JIVEDRIVE_WEBAUTHN_RP_ID: "localhost",
  JIVEDRIVE_WEBAUTHN_ORIGIN: "http://localhost:5173",
};

const config = loadConfig(env);
const db = openDatabase(config.dbPath);
migrateFromDir(db, config.migrationsDir);

// Seed a user with no passkey: the first sign-in registers one.
const alice = createUser(db, {
  username: "alice",
  bucket: "jivedrive-prod",
  prefix: "users/alice/",
});

// Pre-seed a session for the browse e2e spec so it can start signed in
// without a WebAuthn ceremony (sign-in flows are covered by auth.spec;
// reusing alice there would race the single-use passkey registration).
createSession(db, alice.id, { token: "browse-session" });

// Seed an admin who issues invites for the register flow.
const admin = createUser(db, {
  username: "admin",
  bucket: "jivedrive-prod",
  prefix: "users/admin/",
  isAdmin: true,
});

const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

// A valid invite for carol and an expired one for dave.
createInvite(db, {
  token: "invite-carol",
  username: "carol",
  bucket: "jivedrive-prod",
  prefix: "users/carol/",
  issuedByUserId: admin.id,
  expiresAt: future,
});
createInvite(db, {
  token: "invite-dave-expired",
  username: "dave",
  bucket: "jivedrive-prod",
  prefix: "users/dave/",
  issuedByUserId: admin.id,
  expiresAt: past,
});

// Alice's space: three subfolders (docs, photos, empty) and seven root
// files, more than one page of the e2e page size (5).
seedObject("users/alice/archive.zip", "zip-bytes", 1258291);
seedObject("users/alice/budget.xlsx", "spreadsheet-bytes", 831488);
seedObject("users/alice/data.csv", "a,b,c\n1,2,3", 123);
seedObject("users/alice/launch-deck.pptx", "deck-bytes", 18979226);
seedObject("users/alice/readme.md", "# Readme\n", 42);
seedObject("users/alice/report.pdf", "%PDF-1.4 hello report", 2516582);
seedObject("users/alice/todo.txt", "buy milk\n", 7);
seedObject("users/alice/docs/notes.txt", "hello from notes", 64);
seedObject("users/alice/docs/my file #1?.txt", "special file content", 128);
seedObject("users/alice/photos/pic.jpg", "jpeg-bytes", 4096);
seedObject("users/alice/empty/", "", 0);

// Mock S3 HTTP server: serves downloads at path-style presigned URLs and
// accepts browser uploads (PUT) into the in-memory store.
const mockS3 = new Hono();

// The browser uploads cross-origin from localhost:5173, so the mock must
// answer the CORS preflight and tag responses with the page origin.
mockS3.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "http://localhost:5173");
  c.header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

mockS3.get("/:bucket/*", (c) => {
  const path = c.req.path;
  const slash = path.indexOf("/", 1);
  const key = decodeURIComponent(slash === -1 ? "" : path.slice(slash + 1));
  const object = objectStore.get(key);
  if (!object) return c.json({ error: "NoSuchKey" }, 404);
  const fileName = encodeURIComponent(key.split("/").pop() ?? "download");
  c.header("Content-Disposition", `attachment; filename="${fileName}"`);
  return c.body(object.body);
});

// Keep uploads in flight long enough for the e2e suite to assert on the
// progress indicator (visibility of system status).
const UPLOAD_DELAY_MS = 600;

mockS3.put("/:bucket/*", async (c) => {
  const path = c.req.path;
  const slash = path.indexOf("/", 1);
  const key = decodeURIComponent(slash === -1 ? "" : path.slice(slash + 1));
  // A specific name the mock refuses, so the e2e suite can exercise the
  // failed-upload path deterministically.
  if (key.endsWith("broken.txt")) {
    return c.json({ error: "mock rejection" }, 500);
  }
  await Bun.sleep(UPLOAD_DELAY_MS);
  const body = new TextDecoder().decode(await c.req.arrayBuffer());
  objectStore.set(key, {
    body,
    size: Buffer.byteLength(body),
    lastModified: new Date().toISOString(),
  });
  return c.body(null, 200);
});
Bun.serve({ port: MOCK_S3_PORT, fetch: mockS3.fetch });

const staticDir = resolve(import.meta.dir, "../../frontend/dist");
const app = createApp({
  config,
  db,
  staticDir,
  s3Client: createMockS3Client(),
  // Small page size so the browse e2e exercises load more without
  // seeding 1000 objects.
  listPageSize: 5,
});

Bun.serve({ port: config.port, fetch: app.fetch });
console.log(
  `E2E JiveDrive listening on http://localhost:${config.port} (db + mock S3 seeded)`,
);
