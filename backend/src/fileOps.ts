/**
 * File operations shared by the REST file routes (`routes/files.ts`) and
 * the MCP tools (`mcp/tools.ts`): space resolution, folder listing,
 * search, folder creation and moves. Each operation is a plain function
 * over an already-resolved scope that returns a {@link FileOpResult}, so
 * both transports apply exactly the same rules and report the same
 * failures (the REST layer maps them to `{ error, code }` responses, the
 * MCP layer to tool errors).
 *
 * Scope containment (constitution IV): every key handed to S3 is composed
 * from the effective scope prefix returned by `resolveSpace`, and every
 * S3 helper asserts it again with `assertKeyInScope`.
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "bun:sqlite";
import {
  assertKeyInScope,
  copyObject,
  createFolderMarker,
  deleteObject,
  folderExists,
  headObject,
  listObjects,
} from "./s3/client";
import type { ListResult } from "./s3/client";
import {
  getUserById,
  listSharesByRecipient,
  moveObjectRecords,
  searchContent,
  searchFileNames,
  searchFolderNames,
} from "./db/repository";
import type {
  ContentSearchHit,
  FileNameSearchHit,
  FolderSearchHit,
  User,
} from "./db/repository";
import { parseSpace, resolveSpace } from "./scope";
import type { ResolvedScope } from "./scope";

/** A failed file operation, carrying the REST status and error code. */
export interface FileOpError {
  ok: false;
  /** HTTP status the REST layer answers with. */
  status: 400 | 404 | 409;
  /** Machine-readable error code. */
  code: string;
  /** Human-readable message. */
  message: string;
}

/** The outcome of a file operation: a value, or a {@link FileOpError}. */
export type FileOpResult<T> = { ok: true; value: T } | FileOpError;

/** Maximum number of search results returned per query (contract cap). */
export const SEARCH_RESULT_CAP = 50;

/** Maximum search query length in characters (contract `q` parameter). */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/** Maximum folder name length in characters (code points), after trimming. */
export const FOLDER_NAME_MAX_LENGTH = 255;

/**
 * Build a failed result.
 *
 * @param status - HTTP status for the REST layer
 * @param message - human-readable message
 * @param code - machine-readable code
 * @returns the failure
 */
function fail(
  status: 400 | 404 | 409,
  message: string,
  code: string,
): FileOpError {
  return { ok: false, status, code, message };
}

/**
 * Validate that a relative folder prefix stays inside the user's space.
 * A prefix that escapes upwards (".." segments) or is absolute is refused.
 *
 * @param prefix - relative folder path
 * @returns true when the prefix is a safe relative path
 */
export function isSafeRelativePrefix(prefix: string): boolean {
  if (prefix.startsWith("/")) return false;
  return !prefix.split("/").includes("..");
}

/**
 * Normalise a relative folder path to "" (root) or "<path>/".
 *
 * @param folder - relative folder path, with or without trailing "/"
 * @returns the folder prefix relative to the scope
 */
export function normalizeFolder(folder: string): string {
  return folder === "" ? "" : folder.replace(/\/+$/, "") + "/";
}

/**
 * Parse and resolve a `space` value for the signed-in user.
 *
 * Malformed values ("", "foo", "shared:", "shared:..") — and null, used
 * for a non-string body field — fail with 400 `bad_request`; unknown,
 * foreign and revoked shares with 404 `not_found` (R6/R8: no existence
 * leak). The returned scope is the single authority for every S3 call.
 *
 * @param db - database connection
 * @param user - the signed-in user
 * @param raw - raw space value; undefined when absent
 * @returns the resolved scope, or a failure
 */
export function resolveSpaceValue(
  db: Database,
  user: User,
  raw: string | undefined | null,
): FileOpResult<ResolvedScope> {
  const ref = raw === null ? null : parseSpace(raw);
  if (ref === null) {
    return fail(
      400,
      'The space must be "own" or "shared:<shareId>"',
      "bad_request",
    );
  }
  const scope = resolveSpace(db, user, ref);
  if (scope === null) {
    return fail(
      404,
      "The shared space does not exist or has been revoked",
      "not_found",
    );
  }
  return { ok: true, value: scope };
}

/**
 * List one page of a folder within a scope. Keys in the result are full
 * object keys (including the scope prefix); callers present them in
 * their own key form.
 *
 * @param client - S3 client
 * @param scope - effective scope
 * @param prefix - folder relative to the scope root ("" for the root)
 * @param options - continuation cursor and page size
 * @returns one page of folders and files, or `invalid_prefix`
 */
export async function listFolder(
  client: S3Client,
  scope: ResolvedScope,
  prefix: string,
  options: { cursor?: string; pageSize: number },
): Promise<FileOpResult<ListResult>> {
  if (!isSafeRelativePrefix(prefix)) {
    return fail(
      400,
      "The prefix must stay within your space",
      "invalid_prefix",
    );
  }
  const value = await listObjects(client, scope.bucket, scope.prefix, prefix, {
    cursor: options.cursor,
    pageSize: options.pageSize,
  });
  return { ok: true, value };
}

/**
 * One entry of the search result list, per the contract's `SearchResult`
 * schema. `snippet` is present only on content matches; `sharedBy` only
 * on results from a shared mount (US3). A folder result (`match:
 * "folder"`, #13) carries the folder's space-relative prefix as `key`
 * ("" for a shared mount's root) and its parent folder as `path`. File
 * keys are full keys in the own space and mount-relative in a shared one.
 */
export interface SearchResult {
  name: string;
  path: string;
  key: string;
  space: string;
  sharedBy?: string;
  match: "folder" | "name" | "content";
  snippet?: string;
}

/** The search response: results and whether the cap cut them short. */
export interface SearchResponse {
  results: SearchResult[];
  capped: boolean;
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

/**
 * Build the search-result fields for a file in the caller's own space
 * (007-file-search): the path is relative to the space root — the
 * storage prefix and base name stripped — and a root file has no folder.
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
 * the listing endpoints return in a shared space — plus the
 * `shared:<shareId>` space and the sharer's username.
 *
 * @param scope - the resolved shared scope
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
 * space: `key` is the folder's prefix relative to the space root — ""
 * for a shared mount's root — and `path` is its parent folder.
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

/**
 * Search the caller's effective scopes — their own space plus every live
 * incoming share (FR-010) — for folder names, file names and extracted
 * content. Folder matches rank first, then file name matches above
 * content matches (R-008), name order for folders and relevance order
 * inside each file group; the cap spans all scopes. Shared scopes are
 * filtered to the mount prefix and reported mount-relative. Resolution
 * happens per call, so a revoked share drops out immediately (FR-011,
 * constitution IV). Content matching needs at least 3 characters
 * (trigram index, FR-016). The query is trimmed; an empty or over-long
 * query fails with 400 `bad_request`.
 *
 * @param db - database connection
 * @param user - the signed-in user
 * @param rawQuery - the query as received; undefined when absent
 * @returns the capped, ordered results, or a failure
 */
export function searchFiles(
  db: Database,
  user: User,
  rawQuery: string | undefined,
): FileOpResult<SearchResponse> {
  const q = rawQuery?.trim() ?? "";
  if (q === "") {
    return fail(400, "A search query is required", "bad_request");
  }
  if (q.length > SEARCH_QUERY_MAX_LENGTH) {
    return fail(400, "The search query is too long", "bad_request");
  }

  // Own space first, then every live incoming share (oldest first).
  // resolveSpace is the single scope authority: it refuses shares that
  // no longer resolve (orphaned owner, root folder).
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

  // Folder pass (#13): hits are restricted to each scope's prefix so
  // every folder key maps to a space-relative prefix. One extra hit per
  // scope decides whether folders alone exhaust the cap.
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
  const results: SearchResult[] = folderHits
    .slice(0, SEARCH_RESULT_CAP)
    .map(({ entry, hit }) => ({
      ...folderResult(entry, hit),
      match: "folder" as const,
    }));

  // Name pass: one extra hit per scope decides whether the name group
  // exhausts what is left of the cap, in which case content is skipped.
  if (!capped) {
    const nameHits: Array<{ entry: SearchScope; hit: FileNameSearchHit }> = [];
    for (const entry of scopes) {
      const hits = searchFileNames(
        db,
        entry.ownerId,
        q,
        SEARCH_RESULT_CAP + 1,
        entry.scope.mountRelative ? entry.scope.prefix : undefined,
      );
      for (const hit of hits) {
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
    const contentHits: Array<{ entry: SearchScope; hit: ContentSearchHit }> =
      [];
    for (const entry of scopes) {
      const hits = searchContent(
        db,
        entry.ownerId,
        q,
        SEARCH_RESULT_CAP + 1,
        entry.scope.mountRelative ? entry.scope.prefix : undefined,
      );
      for (const hit of hits) {
        // A file matching both name and content ranks as a name match;
        // the duplicate is dropped, not counted against the cap.
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
  return { ok: true, value: { results, capped } };
}

/**
 * Create a folder (issue #11) by writing a zero-byte "<folder>/" marker
 * object, so an empty folder persists. The name is trimmed and otherwise
 * stored verbatim; it must be a single path segment of at most 255
 * characters. Any object under the folder key (a marker or nested files)
 * means the folder exists: 409 `already_exists`. A file named like the
 * folder does not conflict: S3 keeps "X" and "X/" distinct.
 *
 * @param client - S3 client
 * @param scope - effective scope
 * @param folder - parent folder relative to the scope root ("" = root)
 * @param rawName - requested folder name (trimmed here)
 * @returns the trimmed name and the new folder's scope-relative prefix
 */
export async function createFolder(
  client: S3Client,
  scope: ResolvedScope,
  folder: string,
  rawName: string,
): Promise<FileOpResult<{ name: string; prefix: string }>> {
  if (!isSafeRelativePrefix(folder)) {
    return fail(
      400,
      "The folder must stay within your space",
      "invalid_folder",
    );
  }
  const name = rawName.trim();
  if (name === "" || name === "." || name === ".." || name.includes("/")) {
    return fail(
      400,
      'The folder name must not be empty, "." or "..", or contain "/"',
      "invalid_folder_name",
    );
  }
  if ([...name].length > FOLDER_NAME_MAX_LENGTH) {
    return fail(
      400,
      `The folder name must be at most ${FOLDER_NAME_MAX_LENGTH} characters`,
      "invalid_folder_name",
    );
  }

  // The parent folder is validated above and the name is a single
  // segment, so the key stays inside the effective scope; the S3 helpers
  // assert it again before any call.
  const relativePrefix = normalizeFolder(folder) + name + "/";
  const folderKey = scope.prefix + relativePrefix;
  try {
    if (await folderExists(client, scope.bucket, scope.prefix, folderKey)) {
      return fail(
        409,
        `A folder named "${name}" already exists`,
        "already_exists",
      );
    }
    await createFolderMarker(client, scope.bucket, scope.prefix, folderKey);
  } catch (error) {
    if (error instanceof RangeError) {
      return fail(400, "The folder is outside your space", "out_of_scope");
    }
    throw error;
  }
  return { ok: true, value: { name, prefix: relativePrefix } };
}

/**
 * Delete a moved file's source after it was copied to its destination.
 *
 * A failed delete may still have taken effect (e.g. the response was
 * lost), so the source is checked before rolling back: deleting the copy
 * while the source is already gone would destroy the file. If the source
 * is gone the move is complete and nothing is thrown. If it still exists
 * the copy is deleted and the delete error is rethrown. If its state
 * cannot be determined, the copy is kept (the file may sit in both places
 * but is never lost) and the delete error is rethrown.
 *
 * @param client - S3 client
 * @param scope - effective scope holding both keys
 * @param fromKey - full key of the source object
 * @param toKey - full key of the copy
 * @throws the source delete error when the move did not complete
 */
async function removeMovedSource(
  client: S3Client,
  scope: ResolvedScope,
  fromKey: string,
  toKey: string,
): Promise<void> {
  try {
    await deleteObject(client, scope.bucket, scope.prefix, fromKey);
    return;
  } catch (deleteError) {
    let sourceRemains: boolean;
    try {
      sourceRemains =
        (await headObject(client, scope.bucket, scope.prefix, fromKey)) !==
        null;
    } catch (headError) {
      console.error(
        "Move: source state unknown; copy kept at",
        toKey,
        headError,
      );
      throw deleteError;
    }
    if (!sourceRemains) return;
    try {
      await deleteObject(client, scope.bucket, scope.prefix, toKey);
    } catch (rollbackError) {
      console.error("Move rollback failed; copy left at", toKey, rollbackError);
    }
    throw deleteError;
  }
}

/**
 * Move one file to another folder of the same scope (#14). Storage has
 * no rename, so the move is a server-side copy followed by a delete of
 * the source; moves never cross scopes. The destination key keeps the
 * source's base name. A file already at the destination is never
 * overwritten (409 `already_exists`). If deleting the source fails after
 * the copy, the copy is removed only when the source is confirmed to
 * still exist, so a failed move never loses the file. Once storage
 * reflects the move, the records keyed by the object (share links,
 * search index) are carried over to the new key.
 *
 * @param client - S3 client
 * @param db - database connection (share links and search index)
 * @param scope - effective scope holding source and destination
 * @param fromKey - full key of the source file (including scope prefix)
 * @param folder - destination folder relative to the scope root
 * @returns the destination's full key, or a failure
 */
export async function moveFile(
  client: S3Client,
  db: Database,
  scope: ResolvedScope,
  fromKey: string,
  folder: string,
): Promise<FileOpResult<{ toKey: string }>> {
  if (!isSafeRelativePrefix(folder)) {
    return fail(
      400,
      "The folder must stay within your space",
      "invalid_folder",
    );
  }
  try {
    assertKeyInScope(scope.prefix, fromKey);
  } catch (error) {
    if (error instanceof RangeError) {
      return fail(400, "The key is outside your space", "out_of_scope");
    }
    throw error;
  }
  const fileName = fromKey.slice(fromKey.lastIndexOf("/") + 1);
  const toKey = scope.prefix + normalizeFolder(folder) + fileName;
  if (toKey === fromKey) {
    return fail(400, "The file is already in that folder", "same_folder");
  }

  const source = await headObject(client, scope.bucket, scope.prefix, fromKey);
  if (source === null) {
    return fail(404, "The file does not exist", "not_found");
  }
  const existing = await headObject(client, scope.bucket, scope.prefix, toKey);
  if (existing !== null) {
    return fail(
      409,
      `A file named "${fileName}" already exists in that folder`,
      "already_exists",
    );
  }

  await copyObject(client, scope.bucket, scope.prefix, fromKey, toKey);
  await removeMovedSource(client, scope, fromKey, toKey);

  moveObjectRecords(db, {
    bucket: scope.bucket,
    ownerUserId: scope.ownerUserId,
    fromKey,
    toKey,
  });
  return { ok: true, value: { toKey } };
}
