/**
 * Public share-link routes (009-short-share-links, D1): the anonymous
 * download entry point behind `<origin>/s/<token>`.
 *
 * The route is unauthenticated — the recipient has no JiveDrive account.
 * It validates the token against the `share_links` table, mints a fresh
 * short-TTL presigned GET URL for the stored bucket/key, and 302-
 * redirects to it (the storage provider keeps serving the bytes; the
 * URL the recipient was handed reveals nothing about storage). Scope is
 * never re-derived here (D10): rows exist only for keys that passed the
 * creator's scope gate, and the stored location is authoritative. An
 * unknown or expired token answers the identical friendly 410 page (D7),
 * lazily deleting an expired row on lookup (D8).
 */
import { Hono } from "hono";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "bun:sqlite";
import { deleteShareLink, getShareLinkByToken } from "../db/repository";
import { presignedGetUrl } from "../s3/client";
import type { ServerEnv } from "../server";

/**
 * Lifetime of the presigned URL minted at click time, in seconds
 * (5 minutes, D9): long enough for any redirect latency, short enough
 * that the handed-out storage URL is worthless for reuse. The token
 * row, not this TTL, governs the link's lifetime.
 */
const REDIRECT_TTL_SECONDS = 5 * 60;

/** Dependencies for {@link publicShareRoutes}. */
export interface PublicShareRouteDeps {
  /** S3 client for presigning the redirect target (injectable for tests). */
  s3Client: S3Client;
  /** Database holding the share_links rows. */
  db: Database;
}

/**
 * Render the dead-link page (D7): a small standalone HTML document —
 * viewport meta, inline styles, no JavaScript — stating that the link
 * has expired or does not exist. The body is a constant: an expired
 * token and an unknown token render byte-identical pages (FR-005).
 *
 * @returns the full HTML document
 */
function deadLinkPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link unavailable — JiveDrive</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; background: #f8fafc; color: #0f172a;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 24rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { font-size: 1rem; line-height: 1.5; margin: 0; color: #475569; }
</style>
</head>
<body>
<main>
<h1>This link has expired or does not exist</h1>
<p>The link you opened is no longer valid. Ask the person who shared it
with you for a new one.</p>
</main>
</body>
</html>`;
}

/**
 * Create the public share-link route module mounted under /s.
 *
 * A valid, unexpired token answers 302 with a fresh presigned GET URL
 * in the Location header. An unknown or expired token is refused with
 * the identical friendly 410 page (D7): nothing reveals which one
 * occurred, and an expired row found on lookup is deleted eagerly so a
 * long-lived process still clears dead rows between startup sweeps (D8).
 *
 * @param deps - S3 client and database
 * @returns the configured Hono route module
 */
export function publicShareRoutes(deps: PublicShareRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  app.get("/:token", async (c) => {
    const token = c.req.param("token");
    const link = getShareLinkByToken(deps.db, token);
    if (link === null) {
      // Lazy deletion (D8): a miss by token is either an expired row —
      // now removed — or an unknown token, for which the delete is a
      // no-op. Either way the same 410 page answers.
      deleteShareLink(deps.db, token);
      return c.html(deadLinkPage(), 410);
    }
    // The stored key is authoritative (D10): the scope assertion runs
    // against an empty prefix so the route serves the resolved location
    // exactly as the creator's gate approved it, without re-deriving
    // any scope from the anonymous request.
    const url = await presignedGetUrl(
      deps.s3Client,
      link.bucket,
      "",
      link.objectKey,
      REDIRECT_TTL_SECONDS,
    );
    return c.redirect(url, 302);
  });

  return app;
}
