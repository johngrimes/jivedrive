/**
 * Share routes: create and list persistent user-to-user folder grants
 * (FR-001..FR-007), implemented per `contracts/openapi.yaml` (T017).
 *
 * POST /api/shares records a grant of one of the caller's subfolders to
 * another user (R8 error codes: 400 `invalid_folder` /
 * `cannot_share_with_self`, 404 `user_not_found`, 409 `already_shared`);
 * GET /api/shares lists the caller's shares in both directions (R5) —
 * incoming feeds the recipient's root mounts, outgoing feeds the owner's
 * share dialogs; DELETE /api/shares/:id revokes one (owner only, R6).
 * Every route is guarded by `requireUser` and shares the files-family
 * rate-limit bucket (R7).
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "bun:sqlite";
import type { ServerEnv } from "../server";
import {
  createShare,
  deleteShare,
  getShareById,
  getUserById,
  getUserByUsername,
  listSharesByOwner,
  listSharesByRecipient,
  normalizePrefix,
} from "../db/repository";
import type { Share, User } from "../db/repository";

/** Dependencies for {@link sharesRoutes}. */
export interface SharesRouteDeps {
  /** Database for share and user lookups. */
  db: Database;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
}

/** A share the caller granted, per the contract `ShareOutgoing` schema. */
interface ShareOutgoingResponse {
  id: string;
  folder: string;
  folderName: string;
  recipient: { id: string; username: string };
  createdAt: string;
}

/** A share granted to the caller, per the contract `ShareIncoming` schema. */
interface ShareIncomingResponse {
  id: string;
  folder: string;
  folderName: string;
  sharer: { id: string; username: string };
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
  status: 400 | 404 | 409,
  message: string,
  code: string,
): Response {
  return c.json({ error: message, code }, status);
}

/**
 * The base name of a stored folder: the last path segment without the
 * trailing slash ("projects/" -> "projects", "projects/docs/" -> "docs").
 * Shown as the mount name and in the share dialogs (R5).
 *
 * @param folder - stored folder (normalised, trailing "/")
 * @returns the base name
 */
function baseFolderName(folder: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? "";
}

/**
 * Map a stored share to the contract `ShareOutgoing` shape.
 *
 * @param share - stored share
 * @param recipient - the receiving user
 * @returns the outgoing share response
 */
function toOutgoing(share: Share, recipient: User): ShareOutgoingResponse {
  return {
    id: share.id,
    folder: share.folder,
    folderName: baseFolderName(share.folder),
    recipient: { id: recipient.id, username: recipient.username },
    createdAt: share.createdAt,
  };
}

/**
 * Create the share route module mounted under /api/shares.
 *
 * @param deps - database and auth middleware
 * @returns a Hono app with the share routes
 */
export function sharesRoutes(deps: SharesRouteDeps): Hono<ServerEnv> {
  const { db } = deps;

  const app = new Hono<ServerEnv>();
  app.use("*", deps.requireUser);
  app.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));

  // List the caller's shares in both directions (R5). Incoming feeds the
  // recipient's root mounts; outgoing feeds the owner's share dialogs.
  // Defensive: a share whose counterpart user row is gone (a manual DB
  // edit bypassing the FK cascade) is skipped rather than surfaced with a
  // null identity.
  app.get("/", (c) => {
    const user = c.get("user");
    const incoming = listSharesByRecipient(db, user.id).flatMap((share) => {
      const sharer = getUserById(db, share.ownerUserId);
      if (!sharer) return [];
      const entry: ShareIncomingResponse = {
        id: share.id,
        folder: share.folder,
        folderName: baseFolderName(share.folder),
        sharer: { id: sharer.id, username: sharer.username },
      };
      return [entry];
    });
    const outgoing = listSharesByOwner(db, user.id).flatMap((share) => {
      const recipient = getUserById(db, share.recipientUserId);
      return recipient ? [toOutgoing(share, recipient)] : [];
    });
    return c.json({ incoming, outgoing }, 200);
  });

  // Share one of the caller's subfolders with another user (R8). The
  // folder is validated with the repository normaliser; the unique index
  // on (owner, recipient, folder) is the authoritative duplicate guard
  // (R3), mapped to 409. The recipient is resolved by username because
  // the search contract is identity-only (FR-006); the client never
  // sends a user id.
  app.post("/", async (c) => {
    const user = c.get("user");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "bad_request");
    }
    const { folder, recipientUsername } = (body ?? {}) as {
      folder?: unknown;
      recipientUsername?: unknown;
    };
    if (typeof folder !== "string" || typeof recipientUsername !== "string") {
      return jsonError(
        c,
        400,
        "folder and recipientUsername are required",
        "bad_request",
      );
    }
    // The space root is not shareable (FR-004): the normaliser maps the
    // empty string to the bucket root, so the route refuses it outright
    // before creating a row.
    if (folder === "") {
      return jsonError(
        c,
        400,
        "The space root cannot be shared; share a subfolder",
        "invalid_folder",
      );
    }
    let normalizedFolder: string;
    try {
      normalizedFolder = normalizePrefix(folder);
    } catch {
      return jsonError(
        c,
        400,
        "The folder must be a relative subfolder without '..' segments",
        "invalid_folder",
      );
    }
    const recipient = getUserByUsername(db, recipientUsername);
    if (!recipient) {
      return jsonError(
        c,
        404,
        `User "${recipientUsername}" not found`,
        "user_not_found",
      );
    }
    if (recipient.id === user.id) {
      return jsonError(
        c,
        400,
        "You cannot share a folder with yourself",
        "cannot_share_with_self",
      );
    }
    let share: Share;
    try {
      share = createShare(db, {
        ownerUserId: user.id,
        recipientUserId: recipient.id,
        folder: normalizedFolder,
      });
    } catch (error) {
      // The unique index (owner, recipient, folder) is the authoritative
      // duplicate guard (R3): a repeated or concurrent create surfaces
      // here as a UNIQUE constraint violation, mapped to 409. The
      // existing share is untouched.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        return jsonError(
          c,
          409,
          `This folder is already shared with "${recipientUsername}"`,
          "already_shared",
        );
      }
      throw error;
    }
    return c.json({ share: toOutgoing(share, recipient) }, 201);
  });

  // Revoke one of the caller's shares (US4, R6): owner only. Unknown id
  // and non-owner both resolve to 404 `not_found` with the same message,
  // so existence never leaks. The row is hard-deleted; the space
  // resolver (`src/scope.ts`) turns every subsequent `shared:<id>`
  // /api/files request into a 404 (R6), and a fresh share of the same
  // folder to the same recipient succeeds because the unique
  // (owner, recipient, folder) row is gone (US4 sc.5).
  app.delete("/:id", (c) => {
    const user = c.get("user");
    const share = getShareById(db, c.req.param("id"));
    if (!share || share.ownerUserId !== user.id) {
      return jsonError(c, 404, "Share not found", "not_found");
    }
    deleteShare(db, share.id);
    return c.body(null, 204);
  });

  return app;
}
