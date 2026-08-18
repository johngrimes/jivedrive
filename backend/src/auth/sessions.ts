import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  createSession as createSessionRecord,
  deleteSessionById,
  getSessionByToken,
  updateSessionLastUsed,
} from "../db/repository";
import type { Session } from "../db/repository";

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE_NAME = "jivedrive_session";

/** Length of a session token in bytes (256 bits). */
export const SESSION_TOKEN_BYTES = 32;

/** Options for {@link createSession}. */
export interface CreateSessionOptions {
  /** Session lifetime in days, defaults to 30. */
  ttlDays?: number;
  /** Reference time for createdAt/expiresAt, defaults to now. */
  now?: Date;
  /** Override the generated token (tests). */
  token?: string;
  /** Override the generated id (tests). */
  id?: string;
}

/** Options for {@link sessionCookie}. */
export interface SessionCookieOptions {
  /** Include the Secure attribute (production only). */
  secure: boolean;
  /** Cookie path, defaults to "/". */
  path?: string;
  /** Cookie lifetime in seconds. */
  maxAgeSeconds: number;
}

/** Options for {@link clearSessionCookie}. */
export interface ClearCookieOptions {
  /** Include the Secure attribute (production only). */
  secure: boolean;
  /** Cookie path, defaults to "/". */
  path?: string;
}

/**
 * Create a session for a user and return its opaque token and record.
 *
 * The token is 256 bits of randomness, base64url-encoded, and is only ever
 * held in the httpOnly session cookie.
 *
 * @param db - database connection
 * @param userId - id of the signed-in user
 * @param options - TTL and time overrides
 * @returns the token (for the cookie) and the stored session
 */
export function createSession(
  db: Database,
  userId: string,
  options?: CreateSessionOptions,
): { token: string; session: Session } {
  const now = options?.now ?? new Date();
  const ttlDays = options?.ttlDays ?? 30;
  const expiresAt = new Date(
    now.getTime() + ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const token =
    options?.token ?? randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const session = createSessionRecord(db, {
    id: options?.id,
    token,
    userId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { token, session };
}

/**
 * Validate a session token: it must exist, not be absolute-expired and not
 * be idle-expired (FR-011). A session is idle-expired when its last use is
 * more than {@link idleDays} days before the reference time, regardless of
 * the absolute TTL. Invalid sessions are deleted lazily. Valid validation
 * rolls the idle clock by touching `lastUsedAt` (rolling window).
 *
 * @param db - database connection
 * @param token - session token from the cookie
 * @param now - reference time, defaults to now
 * @param idleDays - idle timeout in days, defaults to 7
 * @returns the session when valid, otherwise null
 */
export function validateSession(
  db: Database,
  token: string,
  now?: Date,
  idleDays = 7,
): Session | null {
  const session = getSessionByToken(db, token);
  if (!session) return null;
  const reference = (now ?? new Date()).getTime();
  if (Date.parse(session.expiresAt) <= reference) {
    deleteSessionById(db, session.id);
    return null;
  }
  const idleMs = idleDays * 24 * 60 * 60 * 1000;
  if (Date.parse(session.lastUsedAt) + idleMs <= reference) {
    deleteSessionById(db, session.id);
    return null;
  }
  // Rolling idle clock: valid validation resets the inactivity window.
  updateSessionLastUsed(db, session.id, new Date(reference).toISOString());
  return session;
}

/**
 * Delete every session that is absolute-expired (past `expiresAt`) or
 * idle-expired (last used more than {@link idleDays} days before the
 * reference time). Runs at startup to bound the sessions table (FR-011);
 * timestamps are ISO 8601 UTC so string comparison is correct.
 *
 * @param db - database connection
 * @param now - reference time, defaults to now
 * @param idleDays - idle timeout in days, defaults to 7
 * @returns the number of deleted session rows
 */
export function sweepExpiredSessions(
  db: Database,
  now?: Date,
  idleDays = 7,
): number {
  const reference = (now ?? new Date()).getTime();
  const result = db
    .query("DELETE FROM sessions WHERE expiresAt <= ? OR lastUsedAt <= ?")
    .run(
      new Date(reference).toISOString(),
      new Date(reference - idleDays * 24 * 60 * 60 * 1000).toISOString(),
    );
  return result.changes;
}

/**
 * End a session by deleting its record.
 *
 * @param db - database connection
 * @param token - session token
 */
export function destroySession(db: Database, token: string): void {
  const session = getSessionByToken(db, token);
  if (session) deleteSessionById(db, session.id);
}

/**
 * Build the Set-Cookie header value for a session token.
 *
 * @param token - session token
 * @param options - cookie attributes
 * @returns a Set-Cookie header value
 */
export function sessionCookie(
  token: string,
  options: SessionCookieOptions,
): string {
  const path = options.path ?? "/";
  const secure = options.secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=${path}; HttpOnly${secure}; SameSite=Lax; Max-Age=${options.maxAgeSeconds}`;
}

/**
 * Build a Set-Cookie header value that clears the session cookie.
 *
 * @param options - cookie attributes
 * @returns a Set-Cookie header value
 */
export function clearSessionCookie(options: ClearCookieOptions): string {
  const path = options.path ?? "/";
  const secure = options.secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=${path}; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}
