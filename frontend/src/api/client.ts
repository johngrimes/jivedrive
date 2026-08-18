import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/** A JiveDrive user as returned by the API. */
export interface User {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
}

/** A file (object) in a listing, per the contract `FileEntry` schema. */
export interface FileEntry {
  /** Full object key within the user's space. */
  key: string;
  /** Base name of the object. */
  name: string;
  /** Object size in bytes. */
  size: number;
  /** ISO 8601 timestamp. */
  lastModified: string;
}

/** One page of a folder listing, per the contract. */
export interface ListFilesResponse {
  /** Base names of subfolders (single path segment, no trailing slash). */
  folders: string[];
  files: FileEntry[];
  /** Opaque continuation token for the next page, or null. */
  nextCursor: string | null;
}

/** Error body returned by the API for failed requests. */
export interface ApiErrorBody {
  error: string;
  code: string;
}

/** Error thrown by {@link apiFetch} for non-OK responses. */
export interface ApiClientError extends Error {
  /** Machine-readable error code from the server. */
  code: string;
  /** HTTP status of the failed response. */
  status: number;
}

/** Options for {@link apiFetch}. */
export interface ApiFetchOptions {
  /** Do not parse the response body as JSON (e.g. 204 responses). */
  noBody?: boolean;
}

/**
 * Fetch a JSON API endpoint with cookie credentials.
 *
 * Sessions travel in an httpOnly cookie, so every request must include
 * credentials. Non-OK responses are turned into {@link ApiClientError}s
 * carrying the server's error message and code.
 *
 * @param path - absolute path on the same origin, e.g. "/auth/me"
 * @param init - additional fetch options
 * @param options - whether to skip JSON parsing
 * @returns the parsed JSON body
 * @throws {ApiClientError} when the response is not OK
 * @example
 * ```ts
 * const user = await apiFetch<{ user: User | null }>("/auth/me");
 * ```
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: ApiFetchOptions,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    let code = "unknown";
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>;
      if (body.error) message = body.error;
      if (body.code) code = body.code;
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    const error = new Error(message) as ApiClientError;
    error.code = code;
    error.status = res.status;
    throw error;
  }
  if (options?.noBody) return undefined as T;
  return (await res.json()) as T;
}

/**
 * @returns the healthcheck body
 */
export function getHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/healthcheck");
}

/**
 * @returns the signed-in user, or null when signed out
 */
export function getMe(): Promise<{ user: User | null }> {
  return apiFetch<{ user: User | null }>("/auth/me");
}

/** Response of POST /auth/login/options. */
export interface LoginOptionsResponse {
  /** Opaque single-use id required by login/verify. */
  requestId: string;
  /** Assertion options (no allowCredentials: discoverable-credential flow). */
  options: PublicKeyCredentialRequestOptionsJSON;
}

/** Response of POST /auth/register/options. */
export interface RegisterOptionsResponse {
  options: PublicKeyCredentialCreationOptionsJSON;
  /** Username from the invite or the fallback form. */
  username: string;
  /** Invite flow only. */
  bucket?: string;
  /** Invite flow only. */
  prefix?: string;
}

/** Response of the verify endpoints. */
export interface AuthResponse {
  user: User;
}

/**
 * Start a username-less passkey sign-in.
 *
 * No request body: the server returns assertion options with no
 * allowCredentials so the authenticator only surfaces its discoverable
 * credentials, plus an opaque single-use requestId for the verify step.
 *
 * @returns the requestId and assertion options
 */
export function postLoginOptions(): Promise<LoginOptionsResponse> {
  return apiFetch<LoginOptionsResponse>("/auth/login/options", {
    method: "POST",
  });
}

/**
 * Verify a passkey assertion and create a session.
 *
 * The server resolves the signed-in user from the asserted credential; no
 * username is sent anywhere in the flow.
 *
 * @param requestId - the opaque id returned by postLoginOptions
 * @param credential - the assertion response from the browser
 * @returns the signed-in user
 */
export function postLoginVerify(
  requestId: string,
  credential: AuthenticationResponseJSON,
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/login/verify", {
    method: "POST",
    body: JSON.stringify({ requestId, credential }),
  });
}

/**
 * Start passkey registration for an invite token or an existing username.
 *
 * The username variant bootstraps the first passkey for an account with no
 * usable passkey; the response then carries no bucket/prefix (invite flow
 * only).
 *
 * @param body - either the invite token or the account username
 * @returns registration options and the username (plus bucket/prefix for
 *   the invite flow)
 */
export function postRegisterOptions(
  body: { token: string } | { username: string },
): Promise<RegisterOptionsResponse> {
  return apiFetch<RegisterOptionsResponse>("/auth/register/options", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Verify a passkey registration. Accepts either an invite token or a
 * username (for first-passkey registration of an existing user).
 *
 * @param body - token or username plus the registration response
 * @returns the signed-in user
 */
export function postRegisterVerify(body: {
  token?: string;
  username?: string;
  credential: RegistrationResponseJSON;
}): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/register/verify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * End the current session.
 */
export async function postLogout(): Promise<void> {
  await apiFetch<void>("/auth/logout", { method: "POST" }, { noBody: true });
}

/**
 * List folders and files under a relative prefix within the user's space.
 *
 * @param prefix - relative subfolder within the user's prefix ("" for root)
 * @param cursor - opaque continuation token from a previous page
 * @returns one page of folders and files
 */
export function listFiles(
  prefix: string,
  cursor?: string,
): Promise<ListFilesResponse> {
  const params = new URLSearchParams();
  if (prefix !== "") params.set("prefix", prefix);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return apiFetch<ListFilesResponse>(`/api/files${query ? `?${query}` : ""}`);
}

/** Response of POST /api/files/upload-url. */
export interface UploadUrlResponse {
  /** Presigned PUT URL the browser uploads to directly. */
  url: string;
  /** Full object key within the user's space. */
  key: string;
}

/**
 * Obtain a presigned PUT URL for uploading a file into a folder.
 *
 * @param folder - destination folder relative to the user's prefix ("" for root)
 * @param fileName - base file name, stored verbatim
 * @param overwrite - true to replace an existing object with the same key
 * @returns the presigned URL and the full object key
 * @throws {ApiClientError} on failure; a 409 carries code "already_exists"
 */
export function postUploadUrl(
  folder: string,
  fileName: string,
  overwrite: boolean,
): Promise<UploadUrlResponse> {
  return apiFetch<UploadUrlResponse>("/api/files/upload-url", {
    method: "POST",
    body: JSON.stringify({ folder, fileName, overwrite }),
  });
}

/**
 * Obtain a short-lived presigned GET URL that downloads a file.
 *
 * @param key - full object key within the user's space
 * @returns the presigned download URL
 */
export function getDownloadUrl(key: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(
    `/api/files/download-url?key=${encodeURIComponent(key)}`,
  );
}

/** A share link expiry choice, per the contract's expiresIn enum. */
export type ShareExpiresIn = "1h" | "24h" | "7d" | "30d";

/** Response of POST /api/files/share-url. */
export interface ShareUrlResponse {
  /** Presigned GET URL served directly by the storage provider. */
  url: string;
  /** ISO 8601 timestamp of when the provider will refuse the link. */
  expiresAt: string;
}

/**
 * Generate a fire-and-forget share link for an object in the user's space.
 *
 * The link is served directly by the storage provider to anyone holding
 * it; JiveDrive never stores it (FR-012).
 *
 * @param key - full object key within the user's space
 * @param expiresIn - expiry choice, defaults to 7 days
 * @returns the presigned URL and its expiry timestamp
 */
export function postShareUrl(
  key: string,
  expiresIn: ShareExpiresIn = "7d",
): Promise<ShareUrlResponse> {
  return apiFetch<ShareUrlResponse>("/api/files/share-url", {
    method: "POST",
    body: JSON.stringify({ key, expiresIn }),
  });
}

/**
 * Permanently delete an object within the user's space.
 *
 * Deletion is immediate and irreversible (FR-010); the route touches no
 * database records. The key is validated server-side against the user's
 * prefix.
 *
 * @param key - full object key within the user's space
 * @throws {ApiClientError} on failure; a 404 carries code "not_found"
 */
export async function deleteFile(key: string): Promise<void> {
  await apiFetch<void>(
    `/api/files?key=${encodeURIComponent(key)}`,
    { method: "DELETE" },
    { noBody: true },
  );
}

/** An invite as returned by the admin API, per the contract `Invite` schema. */
export interface Invite {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
  /** ISO 8601 expiry timestamp (creation + 48 hours). */
  expiresAt: string;
  status: "pending" | "claimed" | "expired";
}

/** A user in the admin user list: the contract `User` shape plus createdAt. */
export interface AdminUser extends User {
  /** ISO 8601 timestamp; an admin extension beyond the contract schema. */
  createdAt: string;
}

/** Response of the create and resend invite endpoints. */
export interface InviteResponse {
  invite: Invite;
  /** Full registration URL containing the invite token. */
  link: string;
}

/**
 * List all users (admin only).
 *
 * @returns the user list
 * @throws {ApiClientError} on failure; a 403 carries code "forbidden"
 */
export function listAdminUsers(): Promise<{ users: AdminUser[] }> {
  return apiFetch<{ users: AdminUser[] }>("/api/admin/users");
}

/**
 * List pending, claimed and expired invites (admin only).
 *
 * @returns the invite list with derived statuses
 * @throws {ApiClientError} on failure; a 403 carries code "forbidden"
 */
export function listAdminInvites(): Promise<{ invites: Invite[] }> {
  return apiFetch<{ invites: Invite[] }>("/api/admin/invites");
}

/**
 * Create an invite with a 48-hour expiry (admin only).
 *
 * @param body - username, bucket, prefix and optional admin flag
 * @returns the created invite and its full registration link
 * @throws {ApiClientError} on failure; a 409 carries code "username_taken"
 *   or "invite_pending"
 */
export function createAdminInvite(body: {
  username: string;
  bucket: string;
  prefix: string;
  isAdmin?: boolean;
}): Promise<InviteResponse> {
  return apiFetch<InviteResponse>("/api/admin/invites", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Re-send an invite: a fresh token and a new 48-hour expiry (admin only).
 *
 * @param id - invite id
 * @returns the refreshed invite and its new registration link
 * @throws {ApiClientError} on failure; a 404 carries code "not_found" or
 *   "invite_claimed"
 */
export function resendAdminInvite(id: string): Promise<InviteResponse> {
  return apiFetch<InviteResponse>(`/api/admin/invites/${id}/resend`, {
    method: "POST",
  });
}

/**
 * Cancel a pending or expired invite (admin only).
 *
 * @param id - invite id
 * @throws {ApiClientError} on failure; a 404 carries code "not_found" or
 *   "invite_claimed"
 */
export async function cancelAdminInvite(id: string): Promise<void> {
  await apiFetch<void>(
    `/api/admin/invites/${id}`,
    { method: "DELETE" },
    { noBody: true },
  );
}

/**
 * Remove a user account; their storage objects are left untouched (admin
 * only, FR-014).
 *
 * @param id - user id
 * @throws {ApiClientError} on failure; a 400 carries code "remove_self" or
 *   "last_admin"
 */
export async function removeAdminUser(id: string): Promise<void> {
  await apiFetch<void>(
    `/api/admin/users?id=${encodeURIComponent(id)}`,
    { method: "DELETE" },
    { noBody: true },
  );
}

/**
 * Delete every passkey of a user (admin only, FR-008). The account,
 * storage objects and active sessions are untouched; the user can register
 * a fresh passkey via the sign-in fallback form afterwards (FR-009).
 *
 * @param id - user id
 * @throws {ApiClientError} on failure; a 404 carries code "not_found" and
 *   a 403 carries code "forbidden"
 */
export async function resetUserPasskeys(id: string): Promise<void> {
  await apiFetch<void>(
    `/api/admin/users/${id}/passkeys`,
    { method: "DELETE" },
    { noBody: true },
  );
}
