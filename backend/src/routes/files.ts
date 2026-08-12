/**
 * File routes: folder listing and download URLs for the signed-in user's
 * space. Implemented per `contracts/openapi.yaml` (T034).
 *
 * Every operation is scoped to the signed-in user's configured bucket and
 * prefix; keys outside that scope are rejected with 400 (constitution IV).
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { S3Client } from "@aws-sdk/client-s3";
import { listObjects, presignedGetUrl } from "../s3/client";
import type { ServerEnv } from "../server";

/** Dependencies for {@link filesRoutes}. */
export interface FileRouteDeps {
  /** S3 client for listing and presigning (injectable for tests). */
  s3Client: S3Client;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
  /** Folder listing page size; defaults to 1000 (the S3 protocol limit). */
  listPageSize?: number;
}

/** Lifetime of a download URL in seconds (15 minutes). */
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

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
  status: 400,
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
 * Create the file route module mounted under /api/files.
 *
 * @param deps - S3 client, auth middleware and page size
 * @returns a Hono app with the file routes
 */
export function filesRoutes(deps: FileRouteDeps): Hono<ServerEnv> {
  const { s3Client, requireUser } = deps;
  const pageSize = deps.listPageSize ?? 1000;

  const app = new Hono<ServerEnv>();
  app.use("*", requireUser);
  app.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));

  app.get("/", async (c) => {
    const user = c.get("user");
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
      user.bucket,
      user.prefix,
      prefix,
      {
        cursor,
        pageSize,
      },
    );
    return c.json(
      {
        folders: result.folders,
        files: result.files,
        nextCursor: result.nextCursor,
      },
      200,
    );
  });

  app.get("/download-url", async (c) => {
    const user = c.get("user");
    const key = c.req.query("key") ?? "";
    if (key === "") {
      return jsonError(c, 400, "A file key is required", "bad_request");
    }

    try {
      // Scope enforcement lives here: presignedGetUrl rejects keys outside
      // the user's prefix, mapped to a 400 below. No head request is made;
      // the storage provider surfaces missing objects.
      const url = await presignedGetUrl(
        s3Client,
        user.bucket,
        user.prefix,
        key,
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

  return app;
}
