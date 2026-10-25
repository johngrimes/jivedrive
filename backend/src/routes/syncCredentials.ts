/**
 * rclone sync credential routes, mounted under /api/sync-credentials.
 *
 * GET lists the caller's keys (never secrets) and whether the feature is
 * enabled; POST issues a new prefix-scoped S3 key through the OVH API, on
 * an OVH user dedicated to that key (so it can be revoked on its own), and
 * returns the secret exactly once; DELETE revokes one of the caller's
 * keys. Every route is guarded by `requireUser` and shares the
 * files-family rate-limit bucket.
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";
import type { OvhClient } from "../ovh";
import {
  countSyncCredentials,
  createSyncCredential,
  getSyncCredential,
  listSyncCredentials,
} from "../db/repository";
import type { SyncCredential, User } from "../db/repository";
import {
  buildRcloneConfig,
  buildSyncPolicy,
  revokeSyncCredential,
} from "../syncCredentials";
import type { KeyedLock } from "../syncCredentials";

/** Maximum number of sync keys one user may hold. */
const SYNC_CREDENTIAL_LIMIT = 10;

/** Maximum label length, after trimming. */
const LABEL_MAX_LENGTH = 64;

/** Dependencies for {@link syncCredentialsRoutes}. */
export interface SyncCredentialsRouteDeps {
  config: AppConfig;
  db: Database;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
  /** OVH API client, or null when rclone sync is not configured. */
  ovh: OvhClient | null;
  /** Per-user lock shared with admin user deletion. */
  lock: KeyedLock;
}

/** The public shape of a stored key. */
interface CredentialResponse {
  accessKeyId: string;
  label: string;
  createdAt: string;
}

/**
 * Build a JSON error response.
 *
 * @param c - Hono context
 * @param status - HTTP status
 * @param message - human-readable message
 * @param code - machine-readable error code
 * @returns a JSON error response
 */
function jsonError(
  c: Context<ServerEnv>,
  status: 400 | 404 | 409 | 502 | 503,
  message: string,
  code: string,
): Response {
  return c.json({ error: message, code }, status);
}

/** Map a stored key to its public shape (drops userId). */
function toResponse(credential: SyncCredential): CredentialResponse {
  return {
    accessKeyId: credential.accessKeyId,
    label: credential.label,
    createdAt: credential.createdAt,
  };
}

/** The 503 sent when OVH is not configured. */
function syncDisabled(c: Context<ServerEnv>): Response {
  return jsonError(
    c,
    503,
    "rclone sync is not enabled on this server",
    "sync_disabled",
  );
}

/** The 502 sent when an OVH call fails, logging the cause. */
function providerError(
  c: Context<ServerEnv>,
  action: string,
  error: unknown,
): Response {
  console.error(error);
  return jsonError(
    c,
    502,
    `Could not ${action}: the storage provider returned an error. Please try again.`,
    "storage_provider_error",
  );
}

/**
 * Issue a key on its own OVH user: create the user, wait until it is
 * ready, set the prefix-scoped policy, mint the S3 key, then record the
 * row. On any failure the half-made OVH user is deleted (best effort) and
 * the error rethrown.
 *
 * @param ovh - OVH API client
 * @param db - database
 * @param user - the JiveDrive user
 * @param policy - the policy JSON string
 * @param label - the validated key label
 * @returns the recorded key and its secret (shown once, never stored)
 */
async function issueCredential(
  ovh: OvhClient,
  db: Database,
  user: User,
  policy: string,
  label: string,
): Promise<{ credential: SyncCredential; secretAccessKey: string }> {
  const { id } = await ovh.createUser(`jivedrive:${user.username}`);
  try {
    await ovh.waitForUserReady(id);
    await ovh.setUserPolicy(id, policy);
    const key = await ovh.createS3Credential(id);
    const credential = createSyncCredential(db, {
      accessKeyId: key.accessKeyId,
      userId: user.id,
      ovhUserId: id,
      label,
    });
    return { credential, secretAccessKey: key.secretAccessKey };
  } catch (error) {
    await ovh.deleteUser(id).catch((cleanupError: unknown) => {
      console.error(cleanupError);
    });
    throw error;
  }
}

/**
 * Create the sync credential route module mounted under
 * /api/sync-credentials.
 *
 * @param deps - config, database, auth middleware, OVH client and lock
 * @returns a Hono app with the sync credential routes
 */
export function syncCredentialsRoutes(
  deps: SyncCredentialsRouteDeps,
): Hono<ServerEnv> {
  const { config, db, ovh, lock } = deps;

  const app = new Hono<ServerEnv>();
  app.use("*", deps.requireUser);
  app.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));

  app.get("/", (c) => {
    const user = c.get("user");
    return c.json(
      {
        enabled: ovh !== null,
        credentials:
          ovh === null ? [] : listSyncCredentials(db, user.id).map(toResponse),
        limit: SYNC_CREDENTIAL_LIMIT,
      },
      200,
    );
  });

  app.post("/", async (c) => {
    if (ovh === null) return syncDisabled(c);
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "bad_request");
    }
    const rawLabel: unknown =
      typeof body === "object" && body !== null
        ? Reflect.get(body, "label")
        : undefined;
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    if (label.length < 1 || label.length > LABEL_MAX_LENGTH) {
      return jsonError(
        c,
        400,
        `The label must be 1 to ${LABEL_MAX_LENGTH} characters`,
        "invalid_label",
      );
    }
    let policy: string;
    try {
      policy = buildSyncPolicy(user.bucket, user.prefix);
    } catch {
      return jsonError(
        c,
        409,
        "Your storage folder contains a * or ? character, so sync keys cannot be limited to it",
        "unsupported_prefix",
      );
    }

    // Serialised per user so the cap check cannot race the insert.
    return lock.run(user.id, async () => {
      if (countSyncCredentials(db, user.id) >= SYNC_CREDENTIAL_LIMIT) {
        return jsonError(
          c,
          409,
          `You already have ${SYNC_CREDENTIAL_LIMIT} sync keys; revoke one first`,
          "credential_limit",
        );
      }
      let issued: { credential: SyncCredential; secretAccessKey: string };
      try {
        issued = await issueCredential(ovh, db, user, policy, label);
      } catch (error) {
        return providerError(c, "create the sync key", error);
      }
      const { credential, secretAccessKey } = issued;
      return c.json(
        {
          credential: toResponse(credential),
          secretAccessKey,
          rcloneConfig: buildRcloneConfig({
            endpoint: config.s3.endpoint,
            region: config.s3.region,
            accessKeyId: credential.accessKeyId,
            secretAccessKey,
            bucket: user.bucket,
            prefix: user.prefix,
          }),
          endpoint: config.s3.endpoint,
          region: config.s3.region,
          bucket: user.bucket,
          prefix: user.prefix,
        },
        201,
      );
    });
  });

  // Revoke one of the caller's keys (deny-all policy, delete the key,
  // delete its OVH user, delete the row). Another user's key and an
  // unknown key both answer 404 with the same message, so existence never
  // leaks. On failure the row is kept so the user can retry.
  app.delete("/:accessKeyId", async (c) => {
    if (ovh === null) return syncDisabled(c);
    const user = c.get("user");
    const credential = getSyncCredential(db, c.req.param("accessKeyId"));
    if (!credential || credential.userId !== user.id) {
      return jsonError(c, 404, "Sync key not found", "not_found");
    }
    try {
      await revokeSyncCredential(ovh, db, credential);
    } catch (error) {
      return providerError(c, "revoke the sync key", error);
    }
    return c.body(null, 204);
  });

  return app;
}
