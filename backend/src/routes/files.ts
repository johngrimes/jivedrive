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
  listObjects,
  presignedGetUrl,
  presignedPutUrl,
} from "../s3/client";
import type { HeadResult } from "../s3/client";
import type { ServerEnv } from "../server";
import type { AppConfig } from "../config";
import {
  createShareLink,
  getUserById,
  listSharesByRecipient,
  searchContent,
  searchFileNames,
  searchFolderNames,
} from "../db/repository";
import type {
  ContentSearchHit,
  FileNameSearchHit,
  FolderSearchHit,
  ShareLinkLifetime,
} from "../db/repository";
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
  /** App configuration; the WebAuthn origin is the short link's origin. */
  config: AppConfig;
}

/** Lifetime of a download URL in seconds (15 minutes). */
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Maximum number of search results returned per query (contract cap). */
const SEARCH_RESULT_CAP = 50;

/** Maximum search query length in characters (contract `q` parameter). */
const SEARCH_QUERY_MAX_LENGTH = 200;

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

/**
 * One entry of the search result list, per the contract's `SearchResult`
 * schema. `snippet` is present only on content matches; `sharedBy` only
 * on results from a shared mount (US3). A folder result (`match:
 * "folder"`, #13) carries the folder's space-relative prefix as `key`
 * ("" for a shared mount's root) and its parent folder as `path`.
 */
interface SearchRouteResult {
  name: string;
  path: string;
  key: string;
  space: string;
  sharedBy?: string;
  match: "folder" | "name" | "content";
  snippet?: string;
}

/**
 * Build the search-result fields shared by both match types for a file
 * in the caller's own space (007-file-search): the path is relative to
 * the space root — the storage prefix and base name stripped — and a
 * root file has no folder.
 *
 * @param user - the signed-in user (storage prefix owner)
 * @param key - full object key including the user's storage prefix
 * @param fileName - base name of the object
 * @returns name, path, key and space per the contract
 */
function ownSpaceResult(user: User, key: string, fileName: string) {
  const relative = key.startsWith(user.prefix)
    ? key.slice(user.prefix.length)
    : key;
  const lastSlash = relative.lastIndexOf("/");
  return {
    name: fileName,
    path: lastSlash === -1 ? "" : relative.slice(0, lastSlash),
    key,
    space: "own" as const,
  };
}

/**
 * Build the search-result fields for a file in a shared scope (US3,
 * FR-010): key and path are relative to the mount — identical to what
 * the listing endpoints return in a shared space, so row actions work
 * with the result's space and key — plus the `shared:<shareId>` space
 * and the sharer's username.
 *
 * @param scope - the resolved shared scope (mount prefix carries the
 *   sharer's storage prefix plus the shared folder)
 * @param sharedBy - the sharer's username
 * @param key - full object key in the sharer's space
 * @param fileName - base name of the object
 * @returns name, mount-relative path and key, space and sharedBy
 */
function sharedSpaceResult(
  scope: ResolvedScope,
  sharedBy: string,
  key: string,
  fileName: string,
) {
  const relative = key.slice(scope.prefix.length);
  const lastSlash = relative.lastIndexOf("/");
  return {
    name: fileName,
    path: lastSlash === -1 ? "" : relative.slice(0, lastSlash),
    key: relative,
    space: `shared:${scope.shareId}`,
    sharedBy,
  };
}

/**
 * Build the search-result fields for a folder match (#13) in either
 * space: `key` is the folder's prefix relative to the space root —
 * exactly what the listing navigates to, "" for a shared mount's root —
 * and `path` is its parent folder ("" at the space root).
 *
 * @param entry - the scope the folder was found in
 * @param hit - the folder hit (full key including the scope prefix)
 * @returns name, path, key, space and (in a shared scope) sharedBy
 */
function folderResult(entry: SearchScope, hit: FolderSearchHit) {
  const key = hit.key.slice(entry.scope.prefix.length);
  const parent = key.slice(0, -1);
  const lastSlash = parent.lastIndexOf("/");
  return {
    name: hit.name,
    path: lastSlash === -1 ? "" : parent.slice(0, lastSlash),
    key,
    ...(entry.scope.mountRelative
      ? { space: `shared:${entry.scope.shareId}`, sharedBy: entry.sharedBy }
      : { space: "own" }),
  };
}

/** One searchable scope for the caller, with the identity search needs. */
interface SearchScope {
  /** Owner of the indexed space (the caller, or the sharer). */
  ownerId: string;
  /** Resolved storage scope; mountRelative marks a shared mount. */
  scope: ResolvedScope;
  /** Sharer's username; absent for the caller's own space. */
  sharedBy?: string;
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

  // Search (007-file-search US1 T010, US2 T016, US3 T021; folders #13):
  // one flat result list over the caller's effective scopes — their own
  // space plus every live incoming share (FR-010). Folder name matches
  // rank first, then file name matches above content matches (R-008),
  // name order for folders and relevance order inside each file group; the
  // cap spans all scopes. Shared scopes are filtered to the mount
  // prefix and their keys are reported mount-relative, exactly as the
  // listing endpoints return them. Resolution happens per request, so
  // a revoked share drops out of search immediately, without a scan
  // (FR-011, constitution IV). Content matching needs at least 3
  // characters of query (trigram index, FR-016). The query is trimmed;
  // an empty-after-trim or over-long query is a 400. Rate limiting
  // needs no registration here: the /api/files/* family middleware
  // covers this route.
  app.get("/search", (c) => {
    const user = c.get("user");
    const q = c.req.query("q")?.trim() ?? "";
    if (q === "") {
      return jsonError(c, 400, "A search query is required", "bad_request");
    }
    if (q.length > SEARCH_QUERY_MAX_LENGTH) {
      return jsonError(c, 400, "The search query is too long", "bad_request");
    }

    // The caller's effective scopes: own space first, then every live
    // incoming share (oldest first). resolveSpace is the single scope
    // authority: it refuses shares that no longer resolve (defensive
    // rows: orphaned owner, root folder).
    const scopes: SearchScope[] = [];
    const own = resolveSpace(db, user, { kind: "own" });
    if (own !== null) scopes.push({ ownerId: user.id, scope: own });
    for (const share of listSharesByRecipient(db, user.id)) {
      const scope = resolveSpace(db, user, {
        kind: "shared",
        shareId: share.id,
      });
      if (scope === null) continue;
      const owner = getUserById(db, share.ownerUserId);
      if (owner === null) continue;
      scopes.push({ ownerId: owner.id, scope, sharedBy: owner.username });
    }
    const resultOf = (entry: SearchScope, hit: FileNameSearchHit) =>
      entry.scope.mountRelative
        ? sharedSpaceResult(
            entry.scope,
            entry.sharedBy ?? "",
            hit.key,
            hit.fileName,
          )
        : ownSpaceResult(user, hit.key, hit.fileName);

    // Folder pass (#13): folders whose base name matches, ordered by
    // name. Hits are restricted to each scope's prefix — the shared
    // mount (whose root itself is a candidate) or the caller's own
    // prefix — so every folder key maps to a space-relative prefix.
    // One extra hit per scope decides whether folders alone exhaust
    // the cap, in which case no file pass runs.
    const folderHits: Array<{ entry: SearchScope; hit: FolderSearchHit }> = [];
    // Folder keys end in "/" and file keys never do, so one set dedupes
    // all three passes.
    const seenKeys = new Set<string>();
    for (const entry of scopes) {
      const hits = searchFolderNames(
        db,
        entry.ownerId,
        q,
        SEARCH_RESULT_CAP + 1,
        entry.scope.prefix,
      );
      for (const hit of hits) {
        // Nested shares of the same folder would surface it twice; the
        // first (oldest) share wins.
        if (seenKeys.has(hit.key)) continue;
        seenKeys.add(hit.key);
        folderHits.push({ entry, hit });
      }
    }
    let capped = folderHits.length > SEARCH_RESULT_CAP;
    const results: SearchRouteResult[] = folderHits
      .slice(0, SEARCH_RESULT_CAP)
      .map(({ entry, hit }) => ({
        ...folderResult(entry, hit),
        match: "folder" as const,
      }));

    // Name pass: one extra hit per scope decides whether the name group
    // exhausts what is left of the cap, in which case content is not
    // queried.
    if (!capped) {
      const nameHits: Array<{ entry: SearchScope; hit: FileNameSearchHit }> =
        [];
      for (const entry of scopes) {
        const hits = searchFileNames(
          db,
          entry.ownerId,
          q,
          SEARCH_RESULT_CAP + 1,
          entry.scope.mountRelative ? entry.scope.prefix : undefined,
        );
        for (const hit of hits) {
          // Nested shares of the same folder would surface one file
          // twice; the first (oldest) share wins.
          if (seenKeys.has(hit.key)) continue;
          seenKeys.add(hit.key);
          nameHits.push({ entry, hit });
        }
      }
      const room = SEARCH_RESULT_CAP - results.length;
      if (nameHits.length > room) capped = true;
      for (const { entry, hit } of nameHits.slice(0, room)) {
        results.push({ ...resultOf(entry, hit), match: "name" as const });
      }
    }

    if (!capped && q.length >= 3) {
      // One extra hit per scope decides the capped flag without a
      // second query.
      const contentHits: Array<{
        entry: SearchScope;
        hit: ContentSearchHit;
      }> = [];
      for (const entry of scopes) {
        const hits = searchContent(
          db,
          entry.ownerId,
          q,
          SEARCH_RESULT_CAP + 1,
          entry.scope.mountRelative ? entry.scope.prefix : undefined,
        );
        for (const hit of hits) {
          // A file matching both name and content ranks as a name
          // match; the duplicate is dropped, not counted against the
          // cap.
          if (seenKeys.has(hit.key)) continue;
          seenKeys.add(hit.key);
          contentHits.push({ entry, hit });
        }
      }
      if (contentHits.length > SEARCH_RESULT_CAP - results.length) {
        capped = true;
      }
      for (const { entry, hit } of contentHits.slice(
        0,
        SEARCH_RESULT_CAP - results.length,
      )) {
        results.push({
          ...resultOf(entry, hit),
          match: "content" as const,
          snippet: hit.snippet,
        });
      }
    }
    return c.json({ results, capped }, 200);
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

  return app;
}
