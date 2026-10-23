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

/**
 * A space identifier per the contract: the signed-in user's own space
 * (`own`, the default) or a folder another user shared with them
 * (`shared:<shareId>`), where keys are relative to the shared folder.
 */
export type Space = "own" | `shared:${string}`;

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
  /** Username the passkey will be registered for (invite or bootstrap). */
  username: string;
  /** Storage bucket from the invite or the bootstrap user's account. */
  bucket: string;
  /** Storage prefix from the invite or the bootstrap user's account. */
  prefix: string;
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
 * Start passkey registration for a token: an invite token (new user, or
 * re-enrollment after an admin passkey reset) or the bootstrap enrollment
 * token (provisioned admin with no passkey yet). A username alone is never
 * accepted (FR-001/FR-002).
 *
 * @param token - the invite token or bootstrap enrollment token
 * @returns registration options and the username/bucket/prefix
 */
export function postRegisterOptions(
  token: string,
): Promise<RegisterOptionsResponse> {
  return apiFetch<RegisterOptionsResponse>("/auth/register/options", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/**
 * Verify a passkey registration for a token (invite or bootstrap).
 *
 * @param body - the token plus the registration response from the browser
 * @returns the signed-in user
 */
export function postRegisterVerify(body: {
  token: string;
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
 * List folders and files under a relative prefix within a space.
 *
 * The space defaults to the caller's own space (`own`); in a shared space
 * (`shared:<shareId>`) the prefix and the returned file keys are relative
 * to the shared folder (the mount).
 *
 * @param prefix - relative subfolder within the space ("" for the root)
 * @param space - the space to list; defaults to the caller's own space
 * @param cursor - opaque continuation token from a previous page
 * @returns one page of folders and files
 */
export function listFiles(
  prefix: string,
  space: Space = "own",
  cursor?: string,
): Promise<ListFilesResponse> {
  const params = new URLSearchParams();
  if (prefix !== "") params.set("prefix", prefix);
  if (cursor) params.set("cursor", cursor);
  params.set("space", space);
  const query = params.toString();
  return apiFetch<ListFilesResponse>(`/api/files${query ? `?${query}` : ""}`);
}

/** One search result, per the contract `SearchResult` schema. */
export interface SearchResult {
  /** Base name of the file or folder (its last path segment). */
  name: string;
  /**
   * Human-readable path of the containing folder relative to the space
   * root; "" at the root (the UI breadcrumb).
   */
  path: string;
  /**
   * For a file: the object key in the space's existing key convention —
   * identical to what the listing endpoints return, so existing row
   * actions (download, share, delete) work unchanged with the result's
   * space. For a folder: its prefix relative to the space root, with a
   * trailing "/" ("" for the root of a shared mount) — what the listing
   * navigates to and the folder share dialog takes.
   */
  key: string;
  /** "own" or "shared:<shareId>" (the same identifier listFiles takes). */
  space: Space;
  /** Sharer's username; present only when space is shared. */
  sharedBy?: string;
  /** What matched: a folder's name, a file's name, or a file's content. */
  match: "folder" | "name" | "content";
  /**
   * Snippet of the document around the first content match, with the
   * matching text wrapped in <mark>...</mark>; present only when match
   * is content.
   */
  snippet?: string;
}

/** Response of GET /api/files/search. */
export interface SearchFilesResponse {
  /** Results: folder matches, then file name matches, then content. */
  results: SearchResult[];
  /** True when matches were dropped to enforce the 50-result cap. */
  capped: boolean;
}

/**
 * Search folders by name and files by name and content across the
 * caller's own space and every folder shared with them.
 *
 * @param q - the search query (the server trims it)
 * @returns the matching results and whether the 50-result cap was hit
 */
export function searchFiles(q: string): Promise<SearchFilesResponse> {
  return apiFetch<SearchFilesResponse>(
    `/api/files/search?q=${encodeURIComponent(q)}`,
  );
}

/** Response of POST /api/files/upload-url. */
export interface UploadUrlResponse {
  /** Presigned PUT URL the browser uploads to directly. */
  url: string;
  /** Full object key within the space. */
  key: string;
}

/**
 * Obtain a presigned PUT URL for uploading a file into a folder.
 *
 * @param folder - destination folder relative to the space ("" for root)
 * @param fileName - base file name, stored verbatim
 * @param overwrite - true to replace an existing object with the same key
 * @param space - the space to upload into; defaults to the caller's own
 * @returns the presigned URL and the full object key
 * @throws {ApiClientError} on failure; a 409 carries code "already_exists"
 */
export function postUploadUrl(
  folder: string,
  fileName: string,
  overwrite: boolean,
  space: Space = "own",
): Promise<UploadUrlResponse> {
  return apiFetch<UploadUrlResponse>("/api/files/upload-url", {
    method: "POST",
    body: JSON.stringify({ folder, fileName, overwrite, space }),
  });
}

/**
 * Obtain a short-lived presigned GET URL that downloads a file.
 *
 * @param key - object key within the space (full key in the own space,
 *   relative to the mount in a shared space)
 * @param space - the space the key lives in; defaults to the caller's own
 * @returns the presigned download URL
 */
export function getDownloadUrl(
  key: string,
  space: Space = "own",
): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(
    `/api/files/download-url?key=${encodeURIComponent(key)}&space=${encodeURIComponent(space)}`,
  );
}

/** A share link expiry choice, per the contract's expiresIn enum. */
export type ShareExpiresIn = "1h" | "24h" | "7d" | "30d";

/** Response of POST /api/files/share-url. */
export interface ShareUrlResponse {
  /**
   * Short link of the form `<app origin>/s/<token>`. It reveals nothing
   * about the storage provider, bucket, prefix or object key; opening it
   * redirects to a freshly signed storage URL.
   */
  url: string;
  /** ISO 8601 timestamp of when the link stops working. */
  expiresAt: string;
}

/**
 * Generate a share link for an object in the user's space.
 *
 * The link is stored server-side only until its expiry: it is never
 * listed and cannot be revoked early. The same file and lifetime while
 * still active returns the same link.
 *
 * @param key - object key within the space (full key in the own space,
 *   relative to the mount in a shared space)
 * @param expiresIn - expiry choice, defaults to 7 days
 * @param space - the space the key lives in; defaults to the caller's own
 * @returns the short link and its expiry timestamp
 */
export function postShareUrl(
  key: string,
  expiresIn: ShareExpiresIn = "7d",
  space: Space = "own",
): Promise<ShareUrlResponse> {
  return apiFetch<ShareUrlResponse>("/api/files/share-url", {
    method: "POST",
    body: JSON.stringify({ key, expiresIn, space }),
  });
}

/**
 * Permanently delete an object within a space.
 *
 * Deletion is immediate and irreversible (FR-010); the route touches no
 * database records. The key is validated server-side against the space's
 * scope.
 *
 * @param key - object key within the space (full key in the own space,
 *   relative to the mount in a shared space)
 * @param space - the space the key lives in; defaults to the caller's own
 * @throws {ApiClientError} on failure; a 404 carries code "not_found"
 */
export async function deleteFile(
  key: string,
  space: Space = "own",
): Promise<void> {
  await apiFetch<void>(
    `/api/files?key=${encodeURIComponent(key)}&space=${encodeURIComponent(space)}`,
    { method: "DELETE" },
    { noBody: true },
  );
}

/** Identity-only view of a user, for the share recipient picker (contract UserSummary). */
export interface UserSummary {
  id: string;
  username: string;
}

/** A folder another user shared with the caller (contract ShareIncoming). */
export interface ShareIncoming {
  id: string;
  /** Shared folder relative to the sharer's space. */
  folder: string;
  /** Base name of the shared folder, shown as the mount. */
  folderName: string;
  sharer: UserSummary;
}

/** A folder the caller shares with another user (contract ShareOutgoing). */
export interface ShareOutgoing {
  id: string;
  folder: string;
  folderName: string;
  recipient: UserSummary;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** Response of GET /api/shares. */
export interface ListSharesResponse {
  incoming: ShareIncoming[];
  outgoing: ShareOutgoing[];
}

/**
 * List the signed-in user's shares in both directions: folders shared
 * with them (incoming, feeds the root mounts) and folders they share
 * with others (outgoing, feeds the share dialogs).
 *
 * @returns the incoming and outgoing shares
 */
export function listShares(): Promise<ListSharesResponse> {
  return apiFetch<ListSharesResponse>("/api/shares");
}

/** Response of POST /api/shares. */
export interface CreateShareResponse {
  share: ShareOutgoing;
}

/**
 * Share one of the caller's subfolders with another user. The recipient
 * gains full read/write access (browse, download, upload, overwrite,
 * delete) until the owner revokes.
 *
 * @param folder - relative subfolder of the caller's space
 * @param recipientUsername - username of the recipient, from /api/users
 * @returns the created share
 * @throws {ApiClientError} on failure; a 409 carries code
 *   "already_shared"
 */
export function createShare(
  folder: string,
  recipientUsername: string,
): Promise<CreateShareResponse> {
  return apiFetch<CreateShareResponse>("/api/shares", {
    method: "POST",
    body: JSON.stringify({ folder, recipientUsername }),
  });
}

/**
 * Revoke a share (owner only). The record is deleted; the recipient loses
 * access on their next request.
 *
 * @param id - share id
 * @throws {ApiClientError} on failure; a 404 carries code "not_found"
 */
export async function revokeShare(id: string): Promise<void> {
  await apiFetch<void>(
    `/api/shares/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    { noBody: true },
  );
}

/** Response of GET /api/users. */
export interface SearchUsersResponse {
  users: UserSummary[];
}

/**
 * Search signed-in users by username (case-insensitive substring) to pick
 * a share recipient. Excludes the caller; an empty query returns nothing;
 * at most 20 results.
 *
 * @param q - username substring
 * @returns the matching users
 */
export function searchUsers(q: string): Promise<SearchUsersResponse> {
  return apiFetch<SearchUsersResponse>(`/api/users?q=${encodeURIComponent(q)}`);
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
 * Delete every passkey of a user (admin only, FR-006). The reset revokes
 * ALL of the user's sessions (including the caller's own when resetting
 * self), cancels pending invites for the username, and returns a fresh
 * 48-hour re-enrollment invite and its registration link. The account and
 * its storage objects are untouched.
 *
 * @param id - user id
 * @returns the re-enrollment invite and its link
 * @throws {ApiClientError} on failure; a 404 carries code "not_found" and
 *   a 403 carries code "forbidden"
 */
export function resetUserPasskeys(id: string): Promise<InviteResponse> {
  return apiFetch<InviteResponse>(`/api/admin/users/${id}/passkeys`, {
    method: "DELETE",
  });
}

/**
 * Force an immediate search-index reconciliation of a user's space
 * (admin only, FR-017): the scan runs in the background server-side and
 * the request is accepted immediately, so completion is observed by
 * searching, not by this response. The caller's own space may be
 * reindexed the same way.
 *
 * @param id - user id
 * @returns the acceptance body
 * @throws {ApiClientError} on failure; a 404 carries code "not_found" and
 *   a 403 carries code "forbidden"
 */
export function reindexUser(id: string): Promise<{ started: boolean }> {
  return apiFetch<{ started: boolean }>(`/api/admin/users/${id}/reindex`, {
    method: "POST",
  });
}

/** The per-user outcome counts of one completed scan run. */
export interface ScanCounts {
  indexed: number;
  reindexed: number;
  removed: number;
}

/** One user's latest recorded scan run in the admin scan-status view. */
export interface ScanStatus {
  userId: string;
  username: string;
  /** "idle" until the server has recorded a scan for the user. */
  state: "idle" | "running" | "ok" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  counts: ScanCounts | null;
  error: string | null;
}

/**
 * Read every user's latest scan run (admin only): the latest record per
 * user from the server's in-memory scan registry, "idle" for users the
 * process has not scanned since it started.
 *
 * @returns the scan status list
 * @throws {ApiClientError} on failure; a 403 carries code "forbidden"
 */
export function getScanStatus(): Promise<{ scans: ScanStatus[] }> {
  return apiFetch<{ scans: ScanStatus[] }>("/api/admin/scan-status");
}
