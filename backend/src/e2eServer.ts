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
 *
 * A fake OVHcloud API on port 5298 enables rclone sync credentials: it
 * keeps Object Storage users and S3 keys in memory, and fails user
 * creation for the dedicated `syncfail` user so the e2e suite can assert
 * the storage-provider error path.
 */
import { resolve } from "node:path";
import { Hono } from "hono";
import type { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "./config";
import { migrateFromDir, openDatabase } from "./db/migrate";
import { createInvite, createShare, createUser } from "./db/repository";
import { createApp, startSearchIndexer } from "./server";
import { createS3Client } from "./s3/client";
import { createScanStatusRegistry } from "./search/status";
import { createSession } from "./auth/sessions";

/**
 * An object stored in the mock S3. The body is binary-safe: browser
 * uploads are stored as raw bytes, because a UTF-8 round-trip would
 * corrupt PDF/DOCX payloads before the search-index scan extracts them
 * (007-file-search US2, T018).
 */
interface MockObject {
  body: string | Uint8Array<ArrayBuffer>;
  /** Displayed size, which may differ from the body length. */
  size: number;
  /** ISO 8601 timestamp. */
  lastModified: string;
  /** Content-Type from a server-side PutObject, served back on download. */
  contentType?: string;
}

/** In-memory mock object store keyed by full object key. */
const objectStore = new Map<string, MockObject>();

/** Port of the mock S3 HTTP server (downloads). */
const MOCK_S3_PORT = 5299;

/** Port of the fake OVHcloud API (rclone sync credentials). */
const MOCK_OVH_PORT = 5298;

/** Keep a delete in flight so the UI's pending state is observable. */
const DELETE_DELAY_MS = 400;

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
 * List objects under a prefix in the mock store, matching the shape of
 * an S3 ListObjectsV2 response with opaque continuation tokens (offsets).
 * With Delimiter "/" (the folder-listing route) keys under nested
 * prefixes collapse into CommonPrefixes; without a delimiter (the
 * search-index scan's recursive listing) every object under the prefix
 * is returned in Contents — the real S3 semantics the scan relies on to
 * see nested objects.
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
  const delimited = input.Delimiter === "/";

  // gina's space always fails so the listing-error e2e spec can assert the
  // error + retry UI replaces the eternal skeleton. Production analogue:
  // OVHcloud rejected the deployed S3 credentials with a 403
  // InvalidAccessKeyId for the same listing request.
  if (prefix === "users/gina/") {
    const err = new Error(
      "InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records.",
    ) as Error & { name: string };
    err.name = "InvalidAccessKeyId";
    throw err;
  }

  const entries: Array<{ kind: "folder" | "file"; key: string }> = [];
  const seenFolders = new Set<string>();
  for (const key of [...objectStore.keys()]
    .filter((k) => k.startsWith(prefix))
    .sort()) {
    // A key equal to the prefix (a folder's own marker object) is returned
    // in Contents, as real S3 does: folder creation's existence probe
    // relies on it, and the listing route filters it out by name.
    const rest = key.slice(prefix.length);
    if (delimited && rest.includes("/")) {
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
        // Keep deletes in flight long enough for the e2e suite to assert
        // the dialog's pending state (visibility of system status).
        await Bun.sleep(DELETE_DELAY_MS);
        objectStore.delete(input.Key as string);
        return {};
      case "CopyObjectCommand": {
        // CopySource is the URL-encoded `bucket/key`: drop the bucket
        // segment and decode each key segment (the move route's form).
        const [, ...segments] = String(input.CopySource)
          .replace(/^\//, "")
          .split("/");
        const sourceKey = segments.map(decodeURIComponent).join("/");
        const source = objectStore.get(sourceKey);
        if (!source) {
          const err = new Error("NoSuchKey") as Error & { name: string };
          err.name = "NoSuchKey";
          throw err;
        }
        objectStore.set(input.Key as string, {
          ...source,
          lastModified: new Date().toISOString(),
        });
        return {};
      }
      case "PutObjectCommand": {
        // Server-side writes: folder creation's zero-byte marker objects
        // and MCP write_file content. Browser uploads PUT to the mock HTTP
        // server instead.
        const body =
          typeof input.Body === "string"
            ? new TextEncoder().encode(input.Body)
            : input.Body instanceof Uint8Array
              ? new Uint8Array(input.Body)
              : new Uint8Array();
        objectStore.set(input.Key as string, {
          body,
          size: body.byteLength,
          contentType: input.ContentType as string | undefined,
          lastModified: new Date().toISOString(),
        });
        return {};
      }
      case "GetObjectCommand": {
        const object = objectStore.get(input.Key as string);
        if (!object) {
          const err = new Error("NoSuchKey") as Error & { name: string };
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: object.body, ContentType: object.contentType };
      }
      default:
        throw new Error(`Unhandled mock S3 command: ${name}`);
    }
  }) as unknown as S3Client["send"];
  return client;
}

// The server's own base URL: the WebAuthn origin (and the origin short
// share links are displayed against) must equal the address this server
// actually serves, including when verification scripts move it to another
// port via JIVEDRIVE_PORT.
const port = process.env.JIVEDRIVE_PORT ?? "5173";
const env: Record<string, string | undefined> = {
  ...process.env,
  NODE_ENV: "test",
  // Overridable so verification scripts can run this server on another
  // port with a file-backed database to inspect persistence; Playwright
  // leaves both unset and gets the defaults.
  JIVEDRIVE_PORT: port,
  JIVEDRIVE_DB_PATH: process.env.JIVEDRIVE_DB_PATH ?? ":memory:",
  JIVEDRIVE_MIGRATIONS_DIR: resolve(import.meta.dir, "../migrations"),
  // The mock S3 HTTP server on localhost:5299 is where the browser uploads
  // PUT the file body via XHR, so the CSP connect-src (derived from the
  // endpoint origin) must match it — otherwise the CSP blocks uploads.
  // Keep process.env first so verification scripts can override.
  JIVEDRIVE_S3_ENDPOINT:
    process.env.JIVEDRIVE_S3_ENDPOINT ?? `http://localhost:${MOCK_S3_PORT}`,
  JIVEDRIVE_S3_ACCESS_KEY_ID: process.env.JIVEDRIVE_S3_ACCESS_KEY_ID ?? "test",
  JIVEDRIVE_S3_SECRET_ACCESS_KEY:
    process.env.JIVEDRIVE_S3_SECRET_ACCESS_KEY ?? "test",
  JIVEDRIVE_WEBAUTHN_RP_ID: "localhost",
  JIVEDRIVE_WEBAUTHN_ORIGIN:
    process.env.JIVEDRIVE_WEBAUTHN_ORIGIN ?? `http://localhost:${port}`,
  // This test-only server serves every Playwright spec from one client
  // identity (127.0.0.1) in seconds, so the production defaults (auth
  // 20/min) would 429 mid-run. Override with generous values, keeping
  // process.env first so the Polish phase can run the 429 scenario
  // against this server with explicit env overrides (same pattern as
  // JIVEDRIVE_PORT above).
  JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE:
    process.env.JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE ?? "100000",
  JIVEDRIVE_RATE_LIMIT_AUTH_BURST:
    process.env.JIVEDRIVE_RATE_LIMIT_AUTH_BURST ?? "10000",
  JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE:
    process.env.JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE ?? "100000",
  JIVEDRIVE_RATE_LIMIT_FILES_BURST:
    process.env.JIVEDRIVE_RATE_LIMIT_FILES_BURST ?? "10000",
  // A short scan interval so the e2e specs can poll for indexed search
  // results deterministically (T007; R-010). Overridable like the rest.
  JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS:
    process.env.JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS ?? "2",
  // rclone sync is enabled against the fake OVH API below, with dummy
  // credentials (the fake does not verify signatures). Overridable.
  JIVEDRIVE_OVH_ENDPOINT:
    process.env.JIVEDRIVE_OVH_ENDPOINT ??
    `http://localhost:${MOCK_OVH_PORT}/1.0`,
  JIVEDRIVE_OVH_APPLICATION_KEY:
    process.env.JIVEDRIVE_OVH_APPLICATION_KEY ?? "e2e-app-key",
  JIVEDRIVE_OVH_APPLICATION_SECRET:
    process.env.JIVEDRIVE_OVH_APPLICATION_SECRET ?? "e2e-app-secret",
  JIVEDRIVE_OVH_CONSUMER_KEY:
    process.env.JIVEDRIVE_OVH_CONSUMER_KEY ?? "e2e-consumer-key",
  JIVEDRIVE_OVH_PROJECT_ID:
    process.env.JIVEDRIVE_OVH_PROJECT_ID ?? "e2e-project",
};

const config = loadConfig(env);
const db = openDatabase(config.dbPath);
migrateFromDir(db, config.migrationsDir);

// Seed a user with no passkey: the first enrollment goes through a seeded
// invite (invite-alice below) that attaches the first (discoverable)
// passkey to this existing account (US1 attach semantics).
const alice = createUser(db, {
  username: "alice",
  bucket: "jivedrive-prod",
  prefix: "users/alice/",
});

// Pre-seed a session for the browse e2e spec so it can start signed in
// without a WebAuthn ceremony (sign-in flows are covered by auth.spec;
// reusing alice there would race the single-use passkey registration).
createSession(db, alice.id, { token: "browse-session" });
// A second non-admin user for the folder-sharing specs (US2/US3): bob
// receives alice's `projects` share and browses/uploads/deletes inside
// it. Pre-seeded session so the specs can start signed in as bob without
// a WebAuthn ceremony, mirroring the alice pattern.
const bob = createUser(db, {
  username: "bob",
  bucket: "jivedrive-prod",
  prefix: "users/bob/",
});
createSession(db, bob.id, { token: "bob-session" });

// A third non-admin user dedicated to the short-share-link spec
// (share.spec.ts): she receives alice's `projects` share and creates a
// link from inside that shared mount (US1 scenario 3). No spec removes
// her, and the suite runs fullyParallel, so she must not be anyone's
// removal target (unlike bob, whom share-folder.spec US5 deletes).
const erin = createUser(db, {
  username: "erin",
  bucket: "jivedrive-prod",
  prefix: "users/erin/",
});
createSession(db, erin.id, { token: "erin-session" });

// A fourth non-admin user dedicated to search.spec's US3 share tests:
// she receives alice's `docs` and `photos` shares and searches inside
// them. bob is not usable here: share-folder.spec US5 deletes him while
// the suite runs fullyParallel, and removing a user cascades his
// incoming shares away mid-test.
const flo = createUser(db, {
  username: "flo",
  bucket: "jivedrive-prod",
  prefix: "users/flo/",
});
createSession(db, flo.id, { token: "flo-session" });

// Bob's space: a root file and a same-named `projects` folder of his own,
// so the US2 mount ("projects", shared by alice) renders alongside a
// folder bob already owns (US2 collision scenario).
seedObject("users/bob/own-note.txt", "bob's own note", 23);
seedObject("users/bob/projects/bob-local.txt", "bob's local project file", 64);

// Seed an admin who issues invites for the register flow.
const admin = createUser(db, {
  username: "admin",
  bucket: "jivedrive-prod",
  prefix: "users/admin/",
  isAdmin: true,
});

// Pre-seed an admin session so the admin e2e spec (admin.spec.ts) starts
// signed in without a WebAuthn ceremony, mirroring alice's browse-session.
createSession(db, admin.id, { token: "admin-session" });

// A dedicated user the admin e2e spec removes. No other spec depends on
// frank, so his removal is safe in the shared server and database.
const frank = createUser(db, {
  username: "frank",
  bucket: "jivedrive-prod",
  prefix: "users/frank/",
});
createSession(db, frank.id, { token: "frank-session" });

// A dedicated user for the admin passkey-reset e2e flow (US2): the spec
// resets her passkeys from the Admin users page, she enrolls via the
// returned re-enrollment link, and the admin resets her again to re-enroll
// via a fresh link. No session and no invite is seeded: every sign-in in
// that spec goes through the reset-created re-enrollment link, so the flow
// is retry-safe against the shared in-memory database. No other spec
// depends on her, so the reset never affects another flow.
createUser(db, {
  username: "kate",
  bucket: "jivedrive-prod",
  prefix: "users/kate/",
});

// A user whose space listing always fails in the mock S3 (see
// listObjectsV2): the listing-error e2e spec asserts a failed first-page
// load surfaces an error with Retry instead of an eternal skeleton. No
// other spec signs in as gina.
const gina = createUser(db, {
  username: "gina",
  bucket: "jivedrive-prod",
  prefix: "users/gina/",
});
createSession(db, gina.id, { token: "gina-session" });

// Users dedicated to the rclone sync settings spec: sami issues and
// revokes keys; every key syncfail creates fails at the fake OVH API
// (user creation returns 500), so the spec can assert the explicit
// storage-provider error. No other spec signs in as either.
const sami = createUser(db, {
  username: "sami",
  bucket: "jivedrive-prod",
  prefix: "users/sami/",
});
createSession(db, sami.id, { token: "sync-session" });
const syncfail = createUser(db, {
  username: "syncfail",
  bucket: "jivedrive-prod",
  prefix: "users/syncfail/",
});
createSession(db, syncfail.id, { token: "syncfail-session" });

// A user at the 32-character data-model username maximum (see
// validateUsername in db/repository.ts): the responsive e2e spec asserts
// the navbar truncates a long username with an ellipsis at 375px instead
// of overflowing (FR-003, US1 sc.4). He shares one long-named folder with
// rowan, a recipient dedicated to the narrow-width checks of that long
// "Shared by" label (the mount row in responsive.spec, the search result
// in search.spec); no other spec signs in as either.
const longname = createUser(db, {
  username: "this-username-is-really-long",
  bucket: "jivedrive-prod",
  prefix: "users/this-username-is-really-long/",
});
createSession(db, longname.id, { token: "longname-session" });
const rowan = createUser(db, {
  username: "rowan",
  bucket: "jivedrive-prod",
  prefix: "users/rowan/",
});
createSession(db, rowan.id, { token: "rowan-session" });
createShare(db, {
  ownerUserId: longname.id,
  recipientUserId: rowan.id,
  folder: "quarterly-planning-documents",
});
seedObject(
  "users/this-username-is-really-long/quarterly-planning-documents/agenda.txt",
  "agenda",
  6,
);

// Two users dedicated to the move e2e specs (move.spec.ts and the
// responsive move-dialog test): milo owns one folder tree per test, and
// nina receives milo's move-shared folder (the spec creates the share).
// No other spec signs in as them, so their listings never disturb the
// item counts other specs assert on.
const milo = createUser(db, {
  username: "milo",
  bucket: "jivedrive-prod",
  prefix: "users/milo/",
});
createSession(db, milo.id, { token: "milo-session" });
const nina = createUser(db, {
  username: "nina",
  bucket: "jivedrive-prod",
  prefix: "users/nina/",
});
createSession(db, nina.id, { token: "nina-session" });

// Dedicated users for the folder-creation spec (folders.spec.ts): nora
// creates folders in her own space and inside the `team` folder otto
// shares with her; otto then sees what she created. No other spec signs
// in as either, so creating folders never shifts another spec's counts.
const nora = createUser(db, {
  username: "nora",
  bucket: "jivedrive-prod",
  prefix: "users/nora/",
});
createSession(db, nora.id, { token: "nora-session" });
const otto = createUser(db, {
  username: "otto",
  bucket: "jivedrive-prod",
  prefix: "users/otto/",
});
createSession(db, otto.id, { token: "otto-session" });
createShare(db, {
  ownerUserId: otto.id,
  recipientUserId: nora.id,
  folder: "team",
});
seedObject("users/nora/existing/notes.txt", "nora's notes", 12);
seedObject("users/otto/team/plan.txt", "team plan", 9);

// A dedicated user for the MCP connector spec (mcp.spec.ts): mia
// authorizes fake MCP clients, which read and write her notes/ folder
// through /mcp, then revokes them from Settings. No other spec signs in
// as her, so her grants and written files never shift another spec.
const mia = createUser(db, {
  username: "mia",
  bucket: "jivedrive-prod",
  prefix: "users/mia/",
});
createSession(db, mia.id, { token: "mcp-session" });
seedObject("users/mia/notes/hello.txt", "hello from mia");

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
// A second expired invite used only by the admin e2e spec (which re-sends
// it); dave's invite must stay expired because auth.spec asserts its
// refusal, and both specs share one server.
createInvite(db, {
  token: "invite-ina-expired",
  username: "ina",
  bucket: "jivedrive-prod",
  prefix: "users/ina/",
  issuedByUserId: admin.id,
  expiresAt: past,
});
// A valid invite for the register-page width sweep (US4 sc.6): the
// responsive spec renders /register?token=invite-vera at 375/768/1280 and
// never claims it, so it must stay pending. auth.spec claims invite-carol,
// so vera is a separate invite owned by exactly one spec; dave and ina
// stay expired for their specs.
createInvite(db, {
  token: "invite-vera",
  username: "vera",
  bucket: "jivedrive-prod",
  prefix: "users/vera/",
  issuedByUserId: admin.id,
  expiresAt: future,
});
// Invites for the US1 enrollment flow: the sign-in page has no username
// fallback form, so first-passkey enrollment goes through an invite link.
// invite-alice attaches alice's first passkey to her existing account
// (auth.spec); kate's admin-spec enrollment needs no seeded invite — the
// passkey reset returns its own re-enrollment link (US2). The -r1/-r2
// copies exist so CI retries (Playwright retries: 2) still find fresh
// pending invites after a failed attempt claimed the originals: the e2e
// server keeps one in-memory database for the whole run.
for (const suffix of ["", "-r1", "-r2"]) {
  createInvite(db, {
    token: `invite-alice${suffix}`,
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
    issuedByUserId: admin.id,
    expiresAt: future,
  });
}

// An already-expired share link for the dead-link e2e specs (US2): opening
// /s/exp1redshare must render the friendly 410 page. The repository's
// create path computes expiresAt from the current time, so the row is
// inserted directly with a past expiry; migrateFromDir has already run
// above, keeping the post-migration startup order intact. The target
// object lives in bob's space so no other spec's row counts or dedupe
// keys collide.
seedObject("users/bob/expired-share-target.txt", "expired link target", 19);
db.query(
  "INSERT INTO share_links (token, ownerUserId, bucket, objectKey, expiresIn, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run(
  "exp1redshare",
  bob.id,
  "jivedrive-prod",
  "users/bob/expired-share-target.txt",
  "1h",
  past,
  past,
);

// Alice's space: four subfolders (docs, photos, empty, projects) and
// seven root files — 11 root entries, more than two pages of the e2e
// page size (5). projects/ is the folder alice shares with bob in the
// folder-sharing specs.
seedObject("users/alice/archive.zip", "zip-bytes", 1258291);
seedObject("users/alice/budget.xlsx", "spreadsheet-bytes", 831488);
seedObject("users/alice/data.csv", "a,b,c\n1,2,3", 123);
seedObject("users/alice/launch-deck.pptx", "deck-bytes", 18979226);
seedObject("users/alice/readme.md", "# Readme\n", 42);
seedObject("users/alice/report.pdf", "%PDF-1.4 hello report", 2516582);
seedObject("users/alice/todo.txt", "buy milk\n", 7);
seedObject("users/alice/docs/notes.txt", "hello from notes", 64);
seedObject("users/alice/docs/my file #1?.txt", "special file content", 128);
// A deep folder chain under docs/ for the responsive spec's deep-
// breadcrumb edge case (US2): the mock derives each folder level from the
// key, so docs/ gains exactly one new entry (the reports folder) and stays
// within the 5-item page size that upload.spec relies on. The chain is
// five levels deep so the trail exceeds the 375px container on any font
// (the wrap assertion must not depend on renderer font metrics).
seedObject(
  "users/alice/docs/reports/2026/q1/quarterly/summary.txt",
  "quarterly numbers",
  18,
);
seedObject("users/alice/photos/pic.jpg", "jpeg-bytes", 4096);
// A shareable folder for the folder-sharing specs: alice shares
// projects/ with bob (US1-US3). The nested docs/report.pdf exercises a
// subfolder inside the mount (US2).
seedObject("users/alice/projects/plan.txt", "project plan", 512);
seedObject("users/alice/projects/docs/report.pdf", "%PDF-1.4 report", 2516582);
// Dedicated objects for the delete e2e spec: each test targets its own
// object so the tests can run in parallel without racing each other or
// the other specs. They live in photos/ because upload.spec uploads into
// docs/ and browse.spec asserts the root item counts; the e2e page size
// is 5, so adding files to docs would push its listings past one page.
seedObject("users/alice/photos/delete-me-cancel.txt", "keep me", 7);
seedObject("users/alice/photos/delete-me-confirm.txt", "delete me", 9);
seedObject("users/alice/photos/delete-me-missing.txt", "gone soon", 9);
// A dedicated object for the responsive e2e spec's overwrite flow (US4):
// the overwrite test replaces 0-responsive-overwrite.txt and restores its
// "v1" baseline itself, so every attempt starts from a known state. The
// "0-" prefix keeps it on the first page of photos/ (page size 5, no
// count assertions on photos). The US4 delete test uploads its own unique
// target instead of using a seed, so it is retry-safe too.
seedObject("users/alice/photos/0-responsive-overwrite.txt", "v1", 2);
seedObject("users/alice/empty/", "", 0);
// Milo's folder trees for the move specs: one per test, so parallel
// tests never race each other. Folders exist through the keep.txt
// objects inside them; the tests upload their own uniquely named files
// to move. move-collide/ holds a same-named file in Inner/ for the
// refused-collision test (which never moves anything); move-long/ does
// the same with a 50+ char unbroken name for the 375px wrap test.
for (const key of [
  "move-sub/Reports/keep.txt",
  "move-root/deep/keep.txt",
  "move-collide/dup.txt",
  "move-collide/Inner/dup.txt",
  "move-search/Target/keep.txt",
  "move-mobile/Dest/keep.txt",
  "move-responsive/Dest/keep.txt",
  "move-shared/inbox/keep.txt",
  "move-long/IMG_20261024_123456789_HDR_edited_final_version_2.jpg",
  "move-long/Clash/IMG_20261024_123456789_HDR_edited_final_version_2.jpg",
  "move-long/Deep/Nested/keep.txt",
]) {
  seedObject(`users/milo/${key}`, `seeded ${key}`);
}

// Mock S3 HTTP server: serves downloads at path-style presigned URLs and
// accepts browser uploads (PUT) into the in-memory store.
const mockS3 = new Hono();

// The browser uploads cross-origin from the SPA's page (5173, or a
// scratch port for local config overrides), so the mock answers the CORS
// preflight and echoes the requesting origin back.
mockS3.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin) c.header("Access-Control-Allow-Origin", origin);
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
  if (object.contentType) c.header("Content-Type", object.contentType);
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
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  objectStore.set(key, {
    body: bytes,
    size: bytes.byteLength,
    lastModified: new Date().toISOString(),
  });
  return c.body(null, 200);
});
Bun.serve({ port: MOCK_S3_PORT, fetch: mockS3.fetch });

// Fake OVHcloud API (rclone sync credentials): the endpoints the app
// calls, held in memory. A new user reports "creating" until its first
// GET, which moves it to "ok" (the real API takes a few seconds).
const ovhUsers = new Map<number, { description: string; status: string }>();
const ovhKeys = new Map<string, number>();
let nextOvhUserId = 1;
let nextOvhKey = 1;
const ovhNotFound = { class: "Client::NotFound", message: "Not found" };
const mockOvh = new Hono().basePath("/1.0/cloud/project/:projectId/user");
mockOvh.post("/", async (c) => {
  const { description } = await c.req.json<{ description: string }>();
  // Failure injection: the dedicated syncfail user can never be created.
  if (description === "jivedrive:syncfail") {
    return c.json(
      { class: "Server::InternalServerError", message: "injected" },
      500,
    );
  }
  const id = nextOvhUserId++;
  ovhUsers.set(id, { description, status: "creating" });
  return c.json({
    id,
    username: `user-${id}`,
    description,
    status: "creating",
  });
});
mockOvh.get("/:id", (c) => {
  const user = ovhUsers.get(Number(c.req.param("id")));
  if (!user) return c.json(ovhNotFound, 404);
  user.status = "ok";
  return c.json({ id: Number(c.req.param("id")), ...user });
});
mockOvh.delete("/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!ovhUsers.delete(id)) return c.json(ovhNotFound, 404);
  for (const [access, owner] of ovhKeys) {
    if (owner === id) ovhKeys.delete(access);
  }
  return c.body(null, 200);
});
mockOvh.post("/:id/policy", (c) => {
  if (!ovhUsers.has(Number(c.req.param("id")))) {
    return c.json(ovhNotFound, 404);
  }
  return c.body(null, 200);
});
mockOvh.post("/:id/s3Credentials", (c) => {
  const id = Number(c.req.param("id"));
  if (!ovhUsers.has(id)) return c.json(ovhNotFound, 404);
  const serial = nextOvhKey++;
  const access = `E2EACCESS${String(serial).padStart(8, "0")}`;
  ovhKeys.set(access, id);
  return c.json({
    userId: String(id),
    tenantId: "e2e-tenant",
    access,
    secret: `e2e-secret-${serial}`,
  });
});
mockOvh.delete("/:id/s3Credentials/:access", (c) => {
  if (!ovhKeys.delete(c.req.param("access"))) {
    return c.json(ovhNotFound, 404);
  }
  return c.body(null, 200);
});
Bun.serve({ port: MOCK_OVH_PORT, fetch: mockOvh.fetch });

const staticDir = resolve(import.meta.dir, "../../frontend/dist");
// One shared scan-status registry, as production main() wires it: the
// admin scan-status route reads what the scheduler and the reindex
// endpoint record.
const scanStatus = createScanStatusRegistry();
const app = createApp({
  config,
  db,
  staticDir,
  s3Client: createMockS3Client(),
  scanStatus,
  // Small page size so the browse e2e exercises load more without
  // seeding 1000 objects.
  listPageSize: 5,
});

Bun.serve({ port: config.port, fetch: app.fetch });
// T007: run the search-index scan loop against the mock S3 client so
// seeded and uploaded objects become searchable within one interval.
startSearchIndexer(config, db, createMockS3Client(), scanStatus);
console.log(
  `E2E JiveDrive listening on http://localhost:${config.port} (db + mock S3 seeded)`,
);
