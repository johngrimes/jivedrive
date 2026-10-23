/**
 * Generic space resolver (R1): maps a `space` identifier on every
 * `/api/files` operation to the effective storage scope — the signed-in
 * user's own bucket/prefix for `own`, or the sharer's bucket plus
 * `sharer.prefix + share.folder` for `shared:<shareId>` — and authorises
 * it (the share must exist and the caller must be its recipient).
 *
 * The resolver is the single scope authority (constitution IV): the S3
 * scope assertion in `s3/client.ts` continues to run against the
 * *effective* prefix returned here, unchanged.
 */
import type { Database } from "bun:sqlite";
import { getShareById, getUserById } from "./db/repository";
import type { User } from "./db/repository";

/** A parsed `space` identifier. */
export type SpaceRef = { kind: "own" } | { kind: "shared"; shareId: string };

/** The effective storage scope a space resolves to. */
export interface ResolvedScope {
  /** Bucket containing the objects. */
  bucket: string;
  /** Normalised prefix (trailing "/") of the effective scope. */
  prefix: string;
  /**
   * True when the scope is a folder shared with the caller: keys sent by
   * the client are relative to the mount and must be composed with the
   * prefix before any S3 call. False for the caller's own space, where
   * keys already carry the user's prefix (FileEntry.key semantics
   * unchanged, R2).
   */
  mountRelative: boolean;
  /** Share id for a shared space; undefined for the caller's own space. */
  shareId?: string;
  /**
   * Id of the user whose space the objects belong to: the caller for the
   * own space, the sharer for a shared space. Per-user records keyed by
   * object key (the search index) are stored under this id.
   */
  ownerUserId: string;
}

/**
 * Parse a `space` query/body value into a ref.
 *
 * Absent and `"own"` map to the caller's own space. `"shared:<shareId>"`
 * maps to a shared space. Anything else — empty, `"shared:"` with no id,
 * a `..` or slash-containing id, or a value that is neither — is
 * malformed and maps to null (the route answers 400 `bad_request`).
 *
 * @param space - raw space value from the request, or undefined when absent
 * @returns the parsed ref, or null when malformed
 */
export function parseSpace(space: string | undefined): SpaceRef | null {
  if (space === undefined || space === "own") return { kind: "own" };
  if (space.startsWith("shared:")) {
    const shareId = space.slice("shared:".length);
    if (
      shareId === "" ||
      shareId === ".." ||
      shareId.split("/").includes("..") ||
      shareId.includes("/")
    ) {
      return null;
    }
    return { kind: "shared", shareId };
  }
  return null;
}

/**
 * Resolve a space ref to the effective storage scope for the caller.
 *
 * Own resolves to the caller's bucket and prefix. A shared space resolves
 * to the sharer's bucket and `sharer.prefix + share.folder` only when the
 * share exists and the caller is its recipient; unknown, foreign and
 * revoked shares all resolve to null (the route answers 404 `not_found`,
 * leaking no existence information, R6/R8). Two defensive refusals cover
 * rows a manual edit could create: a share whose owner row is gone, and a
 * share whose folder is the space root.
 *
 * @param db - database connection
 * @param caller - the signed-in user
 * @param ref - parsed space ref
 * @returns the resolved scope, or null when access must be refused
 */
export function resolveSpace(
  db: Database,
  caller: User,
  ref: SpaceRef,
): ResolvedScope | null {
  if (ref.kind === "own") {
    return {
      bucket: caller.bucket,
      prefix: caller.prefix,
      mountRelative: false,
      ownerUserId: caller.id,
    };
  }

  const share = getShareById(db, ref.shareId);
  if (!share) return null;
  // Self-consistency: only the recipient may use the share. The owner
  // resolving their own share is also refused (the share is a grant *to*
  // the recipient).
  if (share.recipientUserId !== caller.id) return null;
  // Defensive: an orphaned share (owner row gone) or one whose folder is
  // the space root must never resolve to a scope.
  if (share.folder === "") return null;
  const owner = getUserById(db, share.ownerUserId);
  if (!owner) return null;

  return {
    bucket: owner.bucket,
    prefix: owner.prefix + share.folder,
    mountRelative: true,
    shareId: share.id,
    ownerUserId: owner.id,
  };
}
