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
  assertKeyInScope,
  deleteObject,
  headObject,
  presignedGetUrl,
  presignedPutUrl,
} from "../s3/client";
import type { HeadResult } from "../s3/client";
import type { ServerEnv } from "../server";
import type { AppConfig } from "../config";
import { createShareLink } from "../db/repository";
import type { ShareLinkLifetime, User } from "../db/repository";
import type { Database } from "bun:sqlite";
import type { ResolvedScope } from "../scope";
import {
  createFolder,
  isSafeRelativePrefix,
  listFolder,
  moveFile,
  resolveSpaceValue,
  searchFiles,
} from "../fileOps";
import type { FileOpError } from "../fileOps";

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
  /** App configuration; the WebAuthn origin is the short link's origin. */
  config: AppConfig;
}

/** Lifetime of a download URL in seconds (15 minutes). */
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Lifetime of an upload (presigned PUT) URL in seconds (15 minutes). */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Accepted share-link lifetimes (seconds), keyed by the contract's
 * expiresIn enum. The values document each lifetime's duration; the
 * stored row's expiresAt is computed by {@link createShareLink}, so a
 * 30-day link is genuinely 30 days — there is no presigned-URL cap. */
const SHARE_EXPIRIES_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
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
 * Answer a failed file operation with its JSON error response.
 *
 * @param c - Hono context
 * @param failure - the failed operation's status, message and code
 * @returns a JSON error response
 */
function opError(c: Context<ServerEnv>, failure: FileOpError): Response {
  return jsonError(c, failure.status, failure.message, failure.code);
}

/** The result of resolving a request's space: a scope or an error response. */
type ScopeResolution = ResolvedScope | Response;

/**
 * Parse and resolve the `space` request value for the signed-in user
 * (see {@link resolveSpaceValue}): 400 `bad_request` on malformed values,
 * 404 `not_found` on unknown, foreign and revoked shares. The effective
 * scope returned is the single authority for every S3 call in the
 * handler.
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
  const resolved = resolveSpaceValue(db, user, raw);
  return resolved.ok ? resolved.value : opError(c, resolved);
}

/**
 * Create the file route module mounted under /api/files.
 *
 * @param deps - S3 client, auth middleware, database and page size
 * @returns a Hono app with the file routes
 */
export function filesRoutes(deps: FileRouteDeps): Hono<ServerEnv> {
  const { s3Client, requireUser, db, config } = deps;
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

    const listed = await listFolder(s3Client, scope, prefix, {
      cursor,
      pageSize,
    });
    if (!listed.ok) return opError(c, listed);
    const result = listed.value;
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

  // Search (007-file-search; folders #13): one flat result list over the
  // caller's effective scopes, implemented by searchFiles (fileOps.ts).
  // Rate limiting needs no registration here: the /api/files/* family
  // middleware covers this route.
  app.get("/search", (c) => {
    const searched = searchFiles(db, c.get("user"), c.req.query("q"));
    if (!searched.ok) return opError(c, searched);
    return c.json(searched.value, 200);
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

  // Create a folder (issue #11) anywhere the caller can upload, including
  // a shared folder; the rules live in createFolder (fileOps.ts).
  app.post("/folders", async (c) => {
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
      name: rawName,
    } = (body ?? {}) as { space?: unknown; folder?: unknown; name?: unknown };
    const scope = resolveRequestSpace(
      c,
      db,
      user,
      spaceValue === undefined || typeof spaceValue === "string"
        ? spaceValue
        : null,
    );
    if (scope instanceof Response) return scope;
    if (typeof folder !== "string" || typeof rawName !== "string") {
      return jsonError(c, 400, "folder and name are required", "bad_request");
    }
    const created = await createFolder(s3Client, scope, folder, rawName);
    if (!created.ok) return opError(c, created);
    // The prefix is relative to the space (mount-relative in a shared
    // space), the same shape the listing's `prefix` parameter takes.
    return c.json(created.value, 201);
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
      // Scope enforcement lives here (constitution IV): the key must sit
      // inside the effective scope prefix and carry no ".." segment,
      // mapped to a 400 below. No storage request is made; a missing
      // object is refused later by the storage provider (US4 scenario 5).
      assertKeyInScope(scope.prefix, fullKey);
      // The row is stored with the resolved bucket/key (D10) so the
      // anonymous /s route can serve it without re-deriving scope, and
      // with the creator as its owner (FR-010: the creator's gate has
      // already passed).
      const link = createShareLink(db, {
        ownerUserId: user.id,
        bucket: scope.bucket,
        objectKey: fullKey,
        expiresIn: expiry as ShareLinkLifetime,
      });
      // The displayed link points at the app's own origin (D5) and
      // reveals nothing about storage (FR-003).
      return c.json(
        {
          url: `${config.webauthn.origin}/s/${link.token}`,
          expiresAt: link.expiresAt,
        },
        200,
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

  // Move one file to another folder of the same space (#14); the copy,
  // safe source removal and record carry-over live in moveFile
  // (fileOps.ts).
  app.post("/move", async (c) => {
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
      folder,
    } = (body ?? {}) as { space?: unknown; key?: unknown; folder?: unknown };
    const scope = resolveRequestSpace(
      c,
      db,
      user,
      spaceValue === undefined || typeof spaceValue === "string"
        ? spaceValue
        : null,
    );
    if (scope instanceof Response) return scope;
    // A key ending in "/" names a folder marker, not a file.
    if (
      typeof key !== "string" ||
      key === "" ||
      key.endsWith("/") ||
      typeof folder !== "string"
    ) {
      return jsonError(
        c,
        400,
        "A file key and a destination folder are required",
        "bad_request",
      );
    }

    // Keys are relative to the mount in a shared space (R2).
    const fromKey = scope.mountRelative ? scope.prefix + key : key;
    const moved = await moveFile(s3Client, db, scope, fromKey, folder);
    if (!moved.ok) return opError(c, moved);
    const { toKey } = moved.value;
    // Same key form as the request: mount-relative in a shared space so
    // the sharer's internal prefix never leaks into the SPA (R2).
    return c.json(
      {
        key: scope.mountRelative ? toKey.slice(scope.prefix.length) : toKey,
      },
      200,
    );
  });

  return app;
}
