/**
 * E2E test server: serves the built SPA and the API on port 5173 with an
 * in-memory database seeded for the Playwright auth tests.
 *
 * Runs via `bun run ../backend/src/e2eServer.ts` from the e2e directory
 * (see playwright.config.ts). The RP ID is `localhost` so passkey
 * ceremonies work against the virtual authenticator.
 */
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { migrateFromDir, openDatabase } from "./db/migrate";
import { createInvite, createUser } from "./db/repository";
import { createApp } from "./server";

const env: Record<string, string | undefined> = {
  ...process.env,
  NODE_ENV: "test",
  JIVEDRIVE_PORT: "5173",
  JIVEDRIVE_DB_PATH: ":memory:",
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
createUser(db, {
  username: "alice",
  bucket: "jivedrive-prod",
  prefix: "users/alice/",
});

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

const staticDir = resolve(import.meta.dir, "../../frontend/dist");
const app = createApp({ config, db, staticDir });

Bun.serve({ port: config.port, fetch: app.fetch });
console.log(
  `E2E JiveDrive listening on http://localhost:${config.port} (db seeded)`,
);
