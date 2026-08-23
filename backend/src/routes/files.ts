/**
 * File routes: folder listing and download URLs for the signed-in user's
 * space. Implemented per `contracts/openapi.yaml` (T034).
 *
 * Every operation carries an optional `space` identifier — `own` (default)
 * or `shared:<shareId>` (R1) — resolved through the generic space resolver
 * (`src/scope.ts`) to the effective `{ bucket, prefix }` before any S3
 * call. Every storage operation is scoped to that effective scope; keys
 * outside it are rejected with 400 (constitution IV). Unknown, foreign
 * and revoked shares are refused with 404; malformed space values with
 * 400.
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  deleteObject,
  headObject,
  listObjects,
  presignedGetUrl,
  presignedPutUrl,
} from "../s3/client";
import type { HeadResult } from "../s3/client";
import type { ServerEnv } from "../server";
import type { Database } from "bun:sqlite";
import { parseSpace, resolveSpace } from "../scope";
import type { ResolvedScope, SpaceRef } from "../scope";
import type { User } from "../db/repository";

/** Dependencies for {@link filesRoutes}. */
export interface FileRouteDeps {
  /** S3 client for listing and presigning (injectable for tests). */
  s3Client: S3Client;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
  /** Folder listing page size; defaults to 1000 (the S3 protocol limit). */
  listPageSize?: number;
  /** Database for resolving shared spaces. */
  db: Database;
}

/** Lifetime of a download URL in seconds (15 minutes). */
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Lifetime of an upload (presigned PUT) URL in seconds (15 minutes). */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Share link lifetimes in seconds, keyed by the contract's expiresIn enum. */
const SHARE_EXPIRIES_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  // Nominal contract value is 30 days (2592000s), but SigV4 presigned GET
  // URLs cannot outlive 7 days: the AWS SDK and OVHcloud's S3 gateway both
  // refuse X-Amz-Expires above 604800 ("must be less than 604800 seconds"),
  // so a 30-day link could never be signed or served. The 30d choice is
  // signed at the provider maximum and expiresAt reflects that lifetime.
  "30d": 7 * 24 * 60 * 60,
};

/** Default share expiry per the contract (7 days). */
const SHARE_DEFAULT_EXPIRES_IN = "7d";

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
  status: 400 | 404 | 409,
  message: string,
  code: string,
): Response {
  return c.json({ error: message, code }, status);
}

/**
 * Validate that a relative folder prefix stays inside the user's space.
 * A prefix that escapes upwards (".." segments) or is absolute is refused.
 *
 * @param prefix - relative folder path from the query string
 * @returns true when the prefix is a safe relative path
 */
function isSafeRelativePrefix(prefix: string): boolean {
  if (prefix.startsWith("/")) return false;
  return !prefix.split("/").includes("..");
}

/** The result of resolving a request's space: a scope or an error response. */
type ScopeResolution = ResolvedScope | Response;

/**
 * Parse and resolve the `space` request value for the signed-in user.
 *
 * Malformed values ("", "foo", "shared:", "shared:..") yield a 400
 * `bad_request`; unknown, foreign and revoked shares yield a 404
 * `not_found` (R6/R8: no existence leak). The effective scope returned is
 * the single authority for every S3 call in the handler.
 *
 * @param c - Hono context
 * @param db - database connection
 * @param user - the signed-in user
 * @param raw - raw space value (query param or body field); null when the
 *   body carried a non-string `space`
 * @returns the resolved scope, or a JSON error response
 */
function resolveRequestSpace(
  c: Context<ServerEnv>,
  db: Database,
  user: User,
  raw: string | undefined | null,
): ScopeResolution {
  const ref: SpaceRef | null = raw === null ? null : parseSpace(raw);
  if (ref === null) {
    return jsonError(
      c,
      400,
      'The space must be "own" or "shared:<shareId>"',
      "bad_request",
    );
  }
  const scope = resolveSpace(db, user, ref);
  if (scope === null) {
    return jsonError(
      c,
      404,
      "The shared space does not exist or has been revoked",
      "not_found",
    );
  }
  return scope;
}

/**
 * Create the file route module mounted under /api/files.
 *
 * @param deps - S3 client, auth middleware, database and page size
 * @returns a Hono app with the file routes
 */
export function filesRoutes(deps: FileRouteDeps): Hono<ServerEnv> {
  const { s3Client, requireUser, db } = deps;
  const pageSize = deps.listPageSize ?? 1000;

  const app = new Hono<ServerEnv>();
  app.use("*", requireUser);
  app.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));

  app.get("/", async (c) => {
    const user = c.get("user");
    const scope = resolveRequestSpace(c, db, user, c.req.query("space"));
    if (scope instanceof Response) return scope;
    const prefix = c.req.query("prefix") ?? "";
    const cursor = c.req.query("cursor") ?? undefined;

    if (!isSafeRelativePrefix(prefix)) {
      return jsonError(
        c,
        400,
        "The prefix must stay within your space",
        "invalid_prefix",
      );
    }

    const result = await listObjects(
      s3Client,
      scope.bucket,
      scope.prefix,
      prefix,
      {
        cursor,
        pageSize,
      },
    );
    return c.json(
      {
        folders: result.folders,
        // In a shared space keys are relative to the mount: the sharer's
        // internal prefix must never leak into the SPA (R2).
        files: scope.mountRelative
          ? result.files.map((file) => ({
              ...file,
              key: file.key.slice(scope.prefix.length),
            }))
          : result.files,
        nextCursor: result.nextCursor,
      },
      200,
    );
  });

  app.get("/download-url", async (c) => {
    const user = c.get("user");
    const scope = resolveRequestSpace(c, db, user, c.req.query("space"));
    if (scope instanceof Response) return scope;
    const key = c.req.query("key") ?? "";
    if (key === "") {
      return jsonError(c, 400, "A file key is required", "bad_request");
    }
    // Keys are relative to the mount in a shared space; own-space keys
    // already carry the user's prefix (R2).
    const fullKey = scope.mountRelative ? scope.prefix + key : key;

    try {
      // Scope enforcement lives here: presignedGetUrl rejects keys outside
      // the effective scope prefix, mapped to a 400 below. No head request
      // is made; the storage provider surfaces missing objects.
      const url = await presignedGetUrl(
        s3Client,
        scope.bucket,
        scope.prefix,
        fullKey,
        DOWNLOAD_URL_TTL_SECONDS,
      );
      return c.json({ url }, 200);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonError(
          c,
          400,
          "The key is outside your space",
          "out_of_scope",
        );
      }
      throw error;
    }
  });

  app.post("/upload-url", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "bad_request");
    }
    const {
      space: spaceValue,
      folder,
      fileName,
      overwrite,
    } = (body ?? {}) as {
      space?: unknown;
      folder?: unknown;
      fileName?: unknown;
      overwrite?: unknown;
    };
    const scope = resolveRequestSpace(
      c,
      db,
      user,
      spaceValue === undefined || typeof spaceValue === "string"
        ? spaceValue
        : null,
    );
    if (scope instanceof Response) return scope;
    if (
      typeof folder !== "string" ||
      typeof fileName !== "string" ||
      typeof overwrite !== "boolean"
    ) {
      return jsonError(
        c,
        400,
        "folder, fileName and overwrite are required",
        "bad_request",
      );
    }

    // Scope enforcement (constitution IV): the folder must stay inside the
    // effective scope and the file name must be a single base name, so the
    // derived key can never escape the scope prefix. The existence check
    // below only ever runs against a key validated to be in scope.
    if (!isSafeRelativePrefix(folder)) {
      return jsonError(
        c,
        400,
        "The folder must stay within your space",
        "invalid_folder",
      );
    }
    if (
      fileName === "" ||
      fileName === "." ||
      fileName === ".." ||
      fileName.includes("/")
    ) {
      return jsonError(
        c,
        400,
        "The file name must be a single base name",
        "invalid_file_name",
      );
    }

    // Key = effective scope prefix + normalised folder + verbatim file
    // name, composed uniformly for own and shared spaces. The file name is
    // stored exactly as given (spaces and special characters are
    // preserved; the SDK URL-encodes it in the presigned URL).
    const normalizedFolder =
      folder === "" ? "" : folder.replace(/\/+$/, "") + "/";
    const key = scope.prefix + normalizedFolder + fileName;

    let existing: HeadResult | null;
    try {
      existing = await headObject(s3Client, scope.bucket, scope.prefix, key);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonError(
          c,
          400,
          "The file is outside your space",
          "out_of_scope",
        );
      }
      throw error;
    }
    if (existing !== null && !overwrite) {
      return jsonError(
        c,
        409,
        `A file named "${fileName}" already exists`,
        "already_exists",
      );
    }

    const url = await presignedPutUrl(
      s3Client,
      scope.bucket,
      scope.prefix,
      key,
      UPLOAD_URL_TTL_SECONDS,
    );
    // The key returned to the client is relative to the space: full key in
    // the own space (as before), mount-relative in a shared space so the
    // sharer's internal prefix never leaks into the SPA (R2).
    return c.json(
      { url, key: scope.mountRelative ? key.slice(scope.prefix.length) : key },
      200,
    );
  });

  app.post("/share-url", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "bad_request");
    }
    const {
      space: spaceValue,
      key,
      expiresIn,
    } = (body ?? {}) as {
      space?: unknown;
      key?: unknown;
      expiresIn?: unknown;
    };
    const scope = resolveRequestSpace(
      c,
      db,
      user,
      spaceValue === undefined || typeof spaceValue === "string"
        ? spaceValue
        : null,
    );
    if (scope instanceof Response) return scope;
    if (typeof key !== "string" || key === "") {
      return jsonError(c, 400, "A file key is required", "bad_request");
    }
    const expiry =
      expiresIn === undefined ? SHARE_DEFAULT_EXPIRES_IN : expiresIn;
    const ttlSeconds =
      typeof expiry === "string" ? SHARE_EXPIRIES_SECONDS[expiry] : undefined;
    if (ttlSeconds === undefined) {
      return jsonError(
        c,
        400,
        "expiresIn must be one of 1h, 24h, 7d, 30d",
        "invalid_expiry",
      );
    }

    // Keys are relative to the mount in a shared space (R2).
    const fullKey = scope.mountRelative ? scope.prefix + key : key;

    try {
      // Scope enforcement lives here: presignedGetUrl rejects keys outside
      // the effective scope prefix, mapped to a 400 below. No head request
      // is made; a missing object is refused later by the storage provider
      // (US4 scenario 5). Nothing is written to the database (FR-012): the
      // link is generated, displayed, and expires naturally.
      const url = await presignedGetUrl(
        s3Client,
        scope.bucket,
        scope.prefix,
        fullKey,
        ttlSeconds,
      );
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      return c.json({ url, expiresAt }, 200);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonError(
          c,
          400,
          "The key is outside your space",
          "out_of_scope",
        );
      }
      throw error;
    }
  });

  // Permanently delete one object within the space (US5, T047). Scope
  // enforcement comes first (constitution IV): headObject rejects keys
  // outside the effective scope prefix, mapped to a 400 below. A missing
  // object is reported as 404; only an object that exists is deleted.
  // Deleting an object in storage touches no database records
  // (data-model.md deletion rules). The delete itself is idempotent at
  // S3, so a concurrently removed object still yields a successful 204.
  app.delete("/", async (c) => {
    const user = c.get("user");
    const scope = resolveRequestSpace(c, db, user, c.req.query("space"));
    if (scope instanceof Response) return scope;
    const key = c.req.query("key") ?? "";
    if (key === "") {
      return jsonError(c, 400, "A file key is required", "bad_request");
    }
    // Keys are relative to the mount in a shared space (R2).
    const fullKey = scope.mountRelative ? scope.prefix + key : key;

    let existing: HeadResult | null;
    try {
      existing = await headObject(
        s3Client,
        scope.bucket,
        scope.prefix,
        fullKey,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonError(
          c,
          400,
          "The key is outside your space",
          "out_of_scope",
        );
      }
      throw error;
    }
    if (existing === null) {
      return jsonError(c, 404, "The file does not exist", "not_found");
    }

    await deleteObject(s3Client, scope.bucket, scope.prefix, fullKey);
    return c.body(null, 204);
  });

  return app;
}
