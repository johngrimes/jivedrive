import { generateShareToken } from "../shareLinks";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

/** A registered JiveDrive account, scoped to one bucket and prefix. */
export interface User {
  id: string;
  username: string;
  bucket: string;
  /** Normalised to end with "/"; empty for the bucket root. */
  prefix: string;
  isAdmin: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** A WebAuthn credential (public key) registered to a user. */
export interface PasskeyCredential {
  /** WebAuthn credential id (base64url). */
  id: string;
  userId: string;
  /** COSE/JSON-encoded public key. */
  publicKey: string;
  /** Signature counter from the authenticator. */
  counter: number;
  /** JSON array of transports. */
  transports: string[];
  /**
   * True when created with `residentKey: "required"` (usable username-less);
   * false for legacy credentials (never offered, deleted on re-enrollment).
   */
  discoverable: boolean;
  createdAt: string;
  /** ISO 8601 timestamp or null when never used. */
  lastUsedAt: string | null;
}

/** A pending or claimed account invitation. */
export interface Invite {
  id: string;
  /** Cryptographic random token used in the invite link. */
  token: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
  /** Admin who created the invite. */
  issuedByUserId: string;
  /** Creation time + 48 hours. */
  expiresAt: string;
  /** Set on successful registration. */
  claimedByUserId: string | null;
  claimedAt: string | null;
  createdAt: string;
}

/** An opaque server-side session. */
export interface Session {
  id: string;
  /** Cryptographic random token held in the session cookie. */
  token: string;
  userId: string;
  createdAt: string;
  /** Absolute TTL. */
  expiresAt: string;
  /** ISO 8601 timestamp of last activity (rolling idle clock). */
  lastUsedAt: string;
}

/** A persistent grant of full read/write access to one folder. */
export interface Share {
  id: string;
  /** User whose folder is shared. */
  ownerUserId: string;
  /** User who receives access. */
  recipientUserId: string;
  /** Relative to the owner's prefix, normalised with a trailing "/". */
  folder: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** The lifetime choices offered when generating a share link. */
export type ShareLinkLifetime = "1h" | "24h" | "7d" | "30d";

/** A stored short share link for exactly one file (009-short-share-links). */
export interface ShareLink {
  /** 12-char base62 public identifier used in `<origin>/s/<token>`. */
  token: string;
  /** User who created the link; deletion of the user cascades the row. */
  ownerUserId: string;
  /** Resolved storage bucket at creation (D10). */
  bucket: string;
  /** Resolved full object key at creation (D10). */
  objectKey: string;
  /** The chosen lifetime; part of the dedupe key (D4). */
  expiresIn: ShareLinkLifetime;
  /** ISO 8601; creation time + lifetime. */
  expiresAt: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/** Input for {@link createShareLink}. */
export interface CreateShareLinkInput {
  ownerUserId: string;
  bucket: string;
  objectKey: string;
  expiresIn: ShareLinkLifetime;
  /** ISO 8601 timestamp; defaults to now. */
  createdAt?: string;
}

/** Injection seams for {@link createShareLink} (tests). */
export interface CreateShareLinkOptions {
  /** Token source; defaults to the real generator. */
  tokenFactory?: () => string;
}

/** Input for {@link createUser}. */
export interface CreateUserInput {
  id?: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin?: boolean;
  createdAt?: string;
}

/** Input for {@link createCredential}. */
export interface CreateCredentialInput {
  /** WebAuthn credential id (base64url). */
  id: string;
  userId: string;
  /** COSE/JSON-encoded public key. */
  publicKey: string;
  counter?: number;
  transports?: string[];
  /** Defaults to false (legacy credential). */
  discoverable?: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
}

/** Input for {@link createInvite}. */
export interface CreateInviteInput {
  id?: string;
  token: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin?: boolean;
  issuedByUserId: string;
  /** Creation time + 48 hours. */
  expiresAt: string;
  createdAt?: string;
}

/** Input for {@link createSession}. */
export interface CreateSessionInput {
  id?: string;
  token: string;
  userId: string;
  createdAt?: string;
  /** ISO 8601 timestamp; defaults to createdAt (full idle allowance). */
  lastUsedAt?: string;
  expiresAt: string;
}

/** Input for {@link createShare}. */
export interface CreateShareInput {
  id?: string;
  ownerUserId: string;
  recipientUserId: string;
  /** Relative subfolder; must not be the space root or contain "..". */
  folder: string;
  createdAt?: string;
}

interface UserRow {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: number;
  createdAt: string;
}

interface CredentialRow {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string;
  discoverable: number;
  createdAt: string;
  lastUsedAt: string | null;
}

interface InviteRow {
  id: string;
  token: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: number;
  issuedByUserId: string;
  expiresAt: string;
  claimedByUserId: string | null;
  claimedAt: string | null;
  createdAt: string;
}

interface SessionRow {
  id: string;
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  /** Null only for rows written before migration 003 backfilled them. */
  lastUsedAt: string | null;
}

interface ShareLinkRow {
  token: string;
  ownerUserId: string;
  bucket: string;
  objectKey: string;
  expiresIn: ShareLinkLifetime;
  expiresAt: string;
  createdAt: string;
}

function mapShareLinkRow(row: ShareLinkRow): ShareLink {
  return { ...row };
}

interface ShareRow {
  id: string;
  ownerUserId: string;
  recipientUserId: string;
  folder: string;
  createdAt: string;
}

function mapUserRow(row: UserRow): User {
  return { ...row, isAdmin: row.isAdmin === 1 };
}

function mapCredentialRow(row: CredentialRow): PasskeyCredential {
  return {
    ...row,
    transports: JSON.parse(row.transports) as string[],
    discoverable: row.discoverable === 1,
  };
}

function mapInviteRow(row: InviteRow): Invite {
  return { ...row, isAdmin: row.isAdmin === 1 };
}

function mapSessionRow(row: SessionRow): Session {
  return {
    ...row,
    // A SQL NULL (row written before migration 003) starts with a full idle
    // allowance: treat it as createdAt.
    lastUsedAt: row.lastUsedAt ?? row.createdAt,
  };
}

function mapShareRow(row: ShareRow): Share {
  return { ...row };
}

/**
 * Validate a username against the data-model pattern.
 *
 * @param username - username to validate
 * @throws {Error} when the username does not match [a-z0-9][a-z0-9._-]{0,31}
 */
export function validateUsername(username: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username)) {
    throw new Error(
      `Invalid username "${username}": must match [a-z0-9][a-z0-9._-]{0,31}`,
    );
  }
}

/**
 * Validate an S3 bucket name.
 *
 * @param bucket - bucket name to validate
 * @throws {Error} when the name is not a valid S3 bucket name
 */
export function validateBucket(bucket: string): void {
  if (!/^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`Invalid bucket name "${bucket}"`);
  }
}

/**
 * Normalise a storage prefix: no leading slash, no ".." segment, exactly
 * one trailing slash, empty string for the bucket root.
 *
 * @param prefix - raw prefix
 * @returns the normalised prefix
 * @throws {Error} when the prefix starts with "/" or contains a ".." segment
 */
export function normalizePrefix(prefix: string | null | undefined): string {
  const value = prefix ?? "";
  if (value === "") return "";
  if (value.startsWith("/")) {
    throw new Error(`Invalid prefix "${value}": must not have a leading "/"`);
  }
  if (value.split("/").includes("..")) {
    throw new Error(
      `Invalid prefix "${value}": must not contain ".." segments`,
    );
  }
  return value.replace(/\/+$/, "") + "/";
}

/**
 * Create a user, validating username, bucket and prefix.
 *
 * @param db - database connection
 * @param input - user fields (id and createdAt default to generated values)
 * @returns the stored user
 * @throws {Error} on invalid username, bucket, prefix, or duplicate username
 */
export function createUser(db: Database, input: CreateUserInput): User {
  validateUsername(input.username);
  validateBucket(input.bucket);
  const prefix = normalizePrefix(input.prefix);
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.query(
    "INSERT INTO users (id, username, bucket, prefix, isAdmin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.username,
    input.bucket,
    prefix,
    input.isAdmin ? 1 : 0,
    createdAt,
  );
  return {
    id,
    username: input.username,
    bucket: input.bucket,
    prefix,
    isAdmin: input.isAdmin ?? false,
    createdAt,
  };
}

/**
 * @param db - database connection
 * @param id - user id
 * @returns the user or null
 */
export function getUserById(db: Database, id: string): User | null {
  const row = db.query("SELECT * FROM users WHERE id = ?").get(id) as
    UserRow | undefined;
  return row ? mapUserRow(row) : null;
}

/**
 * @param db - database connection
 * @param username - exact username
 * @returns the user or null
 */
export function getUserByUsername(db: Database, username: string): User | null {
  const row = db
    .query("SELECT * FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
  return row ? mapUserRow(row) : null;
}

/**
 * @param db - database connection
 * @returns all users ordered by creation time
 */
export function listUsers(db: Database): User[] {
  const rows = db
    .query("SELECT * FROM users ORDER BY createdAt ASC, rowid ASC")
    .all() as UserRow[];
  return rows.map(mapUserRow);
}

/**
 * @param db - database connection
 * @returns the number of users
 */
export function countUsers(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM users").get() as
    { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * @param db - database connection
 * @returns the number of admin users
 */
export function countAdmins(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM users WHERE isAdmin = 1")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Delete a user; credentials, sessions and invites referencing them cascade.
 *
 * @param db - database connection
 * @param id - user id
 */
export function deleteUser(db: Database, id: string): void {
  // FR-014: the FTS table has no userId column or foreign key, so its
  // rows must be removed by a rowid join before the cascade deletes the
  // search_index rows they pair with.
  deleteSearchIndexByUser(db, id);
  db.query("DELETE FROM users WHERE id = ?").run(id);
}

/**
 * Create a passkey credential for a user.
 *
 * @param db - database connection
 * @param input - credential fields
 * @returns the stored credential
 */
export function createCredential(
  db: Database,
  input: CreateCredentialInput,
): PasskeyCredential {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const discoverable = input.discoverable ?? false;
  db.query(
    "INSERT INTO passkey_credentials (id, userId, publicKey, counter, transports, createdAt, lastUsedAt, discoverable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.userId,
    input.publicKey,
    input.counter ?? 0,
    JSON.stringify(input.transports ?? []),
    createdAt,
    input.lastUsedAt ?? null,
    discoverable ? 1 : 0,
  );
  return {
    id: input.id,
    userId: input.userId,
    publicKey: input.publicKey,
    counter: input.counter ?? 0,
    transports: input.transports ?? [],
    discoverable,
    createdAt,
    lastUsedAt: input.lastUsedAt ?? null,
  };
}

/**
 * @param db - database connection
 * @param id - credential id
 * @returns the credential or null
 */
export function getCredentialById(
  db: Database,
  id: string,
): PasskeyCredential | null {
  const row = db
    .query("SELECT * FROM passkey_credentials WHERE id = ?")
    .get(id) as CredentialRow | undefined;
  return row ? mapCredentialRow(row) : null;
}

/**
 * @param db - database connection
 * @param userId - user id
 * @returns all credentials for the user
 */
export function listCredentialsByUser(
  db: Database,
  userId: string,
): PasskeyCredential[] {
  const rows = db
    .query(
      "SELECT * FROM passkey_credentials WHERE userId = ? ORDER BY rowid ASC",
    )
    .all(userId) as CredentialRow[];
  return rows.map(mapCredentialRow);
}

/**
 * @param db - database connection
 * @param userId - user id
 * @returns the user's discoverable credentials (usable username-less)
 */
export function listDiscoverableCredentialsByUser(
  db: Database,
  userId: string,
): PasskeyCredential[] {
  const rows = db
    .query(
      "SELECT * FROM passkey_credentials WHERE userId = ? AND discoverable = 1 ORDER BY rowid ASC",
    )
    .all(userId) as CredentialRow[];
  return rows.map(mapCredentialRow);
}

/**
 * Delete every credential row for a user (admin passkey reset).
 *
 * @param db - database connection
 * @param userId - user id
 */
export function deleteCredentialsByUser(db: Database, userId: string): void {
  db.query("DELETE FROM passkey_credentials WHERE userId = ?").run(userId);
}

/**
 * Delete only the legacy (non-discoverable) credential rows for a user,
 * keeping discoverable ones (fallback re-enrollment cleanup, FR-006).
 *
 * @param db - database connection
 * @param userId - user id
 */
export function deleteLegacyCredentialsByUser(
  db: Database,
  userId: string,
): void {
  db.query(
    "DELETE FROM passkey_credentials WHERE userId = ? AND discoverable = 0",
  ).run(userId);
}

/**
 * Update the signature counter (and optional last-used time) of a credential.
 *
 * @param db - database connection
 * @param id - credential id
 * @param counter - new counter value
 * @param lastUsedAt - optional ISO 8601 timestamp
 */
export function updateCredentialCounter(
  db: Database,
  id: string,
  counter: number,
  lastUsedAt?: string,
): void {
  db.query(
    "UPDATE passkey_credentials SET counter = ?, lastUsedAt = ? WHERE id = ?",
  ).run(counter, lastUsedAt ?? null, id);
}

/**
 * Create an invite, validating username, bucket and prefix.
 *
 * @param db - database connection
 * @param input - invite fields
 * @returns the stored invite
 * @throws {Error} on invalid username, bucket, prefix
 */
export function createInvite(db: Database, input: CreateInviteInput): Invite {
  validateUsername(input.username);
  validateBucket(input.bucket);
  const prefix = normalizePrefix(input.prefix);
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.query(
    "INSERT INTO invites (id, token, username, bucket, prefix, isAdmin, issuedByUserId, expiresAt, claimedByUserId, claimedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
  ).run(
    id,
    input.token,
    input.username,
    input.bucket,
    prefix,
    input.isAdmin ? 1 : 0,
    input.issuedByUserId,
    input.expiresAt,
    createdAt,
  );
  return {
    id,
    token: input.token,
    username: input.username,
    bucket: input.bucket,
    prefix,
    isAdmin: input.isAdmin ?? false,
    issuedByUserId: input.issuedByUserId,
    expiresAt: input.expiresAt,
    claimedByUserId: null,
    claimedAt: null,
    createdAt,
  };
}

/**
 * @param db - database connection
 * @param id - invite id
 * @returns the invite or null
 */
export function getInviteById(db: Database, id: string): Invite | null {
  const row = db.query("SELECT * FROM invites WHERE id = ?").get(id) as
    InviteRow | undefined;
  return row ? mapInviteRow(row) : null;
}

/**
 * @param db - database connection
 * @param token - invite token
 * @returns the invite or null
 */
export function getInviteByToken(db: Database, token: string): Invite | null {
  const row = db.query("SELECT * FROM invites WHERE token = ?").get(token) as
    InviteRow | undefined;
  return row ? mapInviteRow(row) : null;
}

/**
 * @param db - database connection
 * @returns all invites ordered by creation time
 */
export function listInvites(db: Database): Invite[] {
  const rows = db
    .query("SELECT * FROM invites ORDER BY createdAt ASC, rowid ASC")
    .all() as InviteRow[];
  return rows.map(mapInviteRow);
}

/**
 * Mark an invite as claimed by a user.
 *
 * @param db - database connection
 * @param id - invite id
 * @param claimedByUserId - id of the user who claimed it
 * @param claimedAt - optional ISO 8601 timestamp, defaults to now
 */
export function markInviteClaimed(
  db: Database,
  id: string,
  claimedByUserId: string,
  claimedAt?: string,
): void {
  db.query(
    "UPDATE invites SET claimedByUserId = ?, claimedAt = ? WHERE id = ?",
  ).run(claimedByUserId, claimedAt ?? new Date().toISOString(), id);
}

/**
 * Delete an invite (admin cancellation).
 *
 * @param db - database connection
 * @param id - invite id
 */
export function deleteInvite(db: Database, id: string): void {
  db.query("DELETE FROM invites WHERE id = ?").run(id);
}

/**
 * Delete every unclaimed invite for a username (admin passkey reset).
 *
 * Expired-but-unclaimed invites are included: they are dead weight and
 * would otherwise make the next invite creation 409-refuse (the create
 * route refuses when a pending or expired invite exists), violating
 * "exactly one live invite". Claimed invites survive for audit.
 *
 * @param db - database connection
 * @param username - target username
 */
export function cancelPendingInvitesByUsername(
  db: Database,
  username: string,
): void {
  db.query(
    "DELETE FROM invites WHERE username = ? AND claimedByUserId IS NULL",
  ).run(username);
}

/**
 * Replace an invite's token and expiry (admin re-send). Everything else
 * about the invite is untouched.
 *
 * @param db - database connection
 * @param id - invite id
 * @param token - the fresh cryptographic token
 * @param expiresAt - the new expiry timestamp (creation + 48 hours)
 */
export function refreshInvite(
  db: Database,
  id: string,
  token: string,
  expiresAt: string,
): void {
  db.query("UPDATE invites SET token = ?, expiresAt = ? WHERE id = ?").run(
    token,
    expiresAt,
    id,
  );
}

/**
 * Create a session record.
 *
 * @param db - database connection
 * @param input - session fields
 * @returns the stored session
 */
export function createSession(
  db: Database,
  input: CreateSessionInput,
): Session {
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const lastUsedAt = input.lastUsedAt ?? createdAt;
  db.query(
    "INSERT INTO sessions (id, token, userId, createdAt, expiresAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.token, input.userId, createdAt, input.expiresAt, lastUsedAt);
  return {
    id,
    token: input.token,
    userId: input.userId,
    createdAt,
    expiresAt: input.expiresAt,
    lastUsedAt,
  };
}

/**
 * @param db - database connection
 * @param token - session token
 * @returns the session or null
 */
export function getSessionByToken(db: Database, token: string): Session | null {
  const row = db.query("SELECT * FROM sessions WHERE token = ?").get(token) as
    SessionRow | undefined;
  return row ? mapSessionRow(row) : null;
}

/**
 * @param db - database connection
 * @param id - session id
 */
export function deleteSessionById(db: Database, id: string): void {
  db.query("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * Update the last-used time of one session (rolling idle clock).
 *
 * @param db - database connection
 * @param id - session id
 * @param lastUsedAt - ISO 8601 timestamp
 */
export function updateSessionLastUsed(
  db: Database,
  id: string,
  lastUsedAt: string,
): void {
  db.query("UPDATE sessions SET lastUsedAt = ? WHERE id = ?").run(
    lastUsedAt,
    id,
  );
}

/**
 * Delete every session row for one user (passkey reset revocation).
 * Sessions of other users are untouched.
 *
 * @param db - database connection
 * @param userId - user id
 */
export function deleteSessionsByUser(db: Database, userId: string): void {
  db.query("DELETE FROM sessions WHERE userId = ?").run(userId);
}
/**
 * Create a share, normalising and validating the folder.
 *
 * @param db - database connection
 * @param input - share fields (id and createdAt default to generated values)
 * @returns the stored share
 * @throws {Error} when the folder is the space root or contains a ".."
 *   segment, or when the (owner, recipient, folder) triple already exists
 *   (SQLite UNIQUE constraint error, mapped to 409 by the route)
 */
export function createShare(db: Database, input: CreateShareInput): Share {
  const folder = normalizePrefix(input.folder);
  if (folder === "") {
    throw new Error("Cannot share the space root: folder must be a subfolder");
  }
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.query(
    "INSERT INTO shares (id, ownerUserId, recipientUserId, folder, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.ownerUserId, input.recipientUserId, folder, createdAt);
  return {
    id,
    ownerUserId: input.ownerUserId,
    recipientUserId: input.recipientUserId,
    folder,
    createdAt,
  };
}

/**
 * @param db - database connection
 * @param recipientUserId - id of the receiving user
 * @returns all shares granted to the recipient, oldest first
 */
export function listSharesByRecipient(
  db: Database,
  recipientUserId: string,
): Share[] {
  const rows = db
    .query(
      "SELECT * FROM shares WHERE recipientUserId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(recipientUserId) as ShareRow[];
  return rows.map(mapShareRow);
}

/**
 * @param db - database connection
 * @param ownerUserId - id of the sharing user
 * @returns all shares granted by the owner, oldest first
 */
export function listSharesByOwner(db: Database, ownerUserId: string): Share[] {
  const rows = db
    .query(
      "SELECT * FROM shares WHERE ownerUserId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(ownerUserId) as ShareRow[];
  return rows.map(mapShareRow);
}

/**
 * @param db - database connection
 * @param id - share id
 * @returns the share or null
 */
export function getShareById(db: Database, id: string): Share | null {
  const row = db.query("SELECT * FROM shares WHERE id = ?").get(id) as
    ShareRow | undefined;
  return row ? mapShareRow(row) : null;
}

/**
 * Delete a share (owner-only revocation).
 *
 * @param db - database connection
 * @param id - share id
 */
export function deleteShare(db: Database, id: string): void {
  db.query("DELETE FROM shares WHERE id = ?").run(id);
}

/** An S3 key issued for rclone sync; the secret is never stored. */
export interface SyncCredential {
  /** S3 access key id, unique at OVH. */
  accessKeyId: string;
  userId: string;
  /**
   * The OVH Public Cloud user dedicated to this key (numeric at OVH,
   * stored as text); revoking the key denies and deletes this user.
   */
  ovhUserId: string;
  /** User-chosen label, trimmed, 1-64 characters. */
  label: string;
  createdAt: string;
}

/** Input for {@link createSyncCredential}. */
export interface CreateSyncCredentialInput {
  accessKeyId: string;
  userId: string;
  ovhUserId: string;
  label: string;
  createdAt?: string;
}

/**
 * Record an issued sync key and its dedicated OVH user (without the
 * secret).
 *
 * @param db - database connection
 * @param input - credential fields (createdAt defaults to now)
 * @returns the stored credential
 */
export function createSyncCredential(
  db: Database,
  input: CreateSyncCredentialInput,
): SyncCredential {
  const credential: SyncCredential = {
    accessKeyId: input.accessKeyId,
    userId: input.userId,
    ovhUserId: input.ovhUserId,
    label: input.label,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  db.query(
    "INSERT INTO sync_credentials (accessKeyId, userId, ovhUserId, label, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(
    credential.accessKeyId,
    credential.userId,
    credential.ovhUserId,
    credential.label,
    credential.createdAt,
  );
  return credential;
}

/**
 * @param db - database connection
 * @param userId - JiveDrive user id
 * @returns the user's sync keys, newest first
 */
export function listSyncCredentials(
  db: Database,
  userId: string,
): SyncCredential[] {
  const rows = db
    .query(
      "SELECT * FROM sync_credentials WHERE userId = ? ORDER BY createdAt DESC, rowid DESC",
    )
    .all(userId) as SyncCredential[];
  return rows.map((row) => ({ ...row }));
}

/**
 * @param db - database connection
 * @param userId - JiveDrive user id
 * @returns how many sync keys the user holds
 */
export function countSyncCredentials(db: Database, userId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM sync_credentials WHERE userId = ?")
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * @param db - database connection
 * @param accessKeyId - S3 access key id
 * @returns the sync key, or null
 */
export function getSyncCredential(
  db: Database,
  accessKeyId: string,
): SyncCredential | null {
  const row = db
    .query("SELECT * FROM sync_credentials WHERE accessKeyId = ?")
    .get(accessKeyId) as SyncCredential | undefined;
  return row ? { ...row } : null;
}

/**
 * Delete a sync key's row (after it was revoked at OVH).
 *
 * @param db - database connection
 * @param accessKeyId - S3 access key id
 */
export function deleteSyncCredential(db: Database, accessKeyId: string): void {
  db.query("DELETE FROM sync_credentials WHERE accessKeyId = ?").run(
    accessKeyId,
  );
}

/** Lifetime → expiry offset in seconds; 30d is a full 30 days (FR-004). */
const SHARE_LINK_LIFETIME_SECONDS: Record<ShareLinkLifetime, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

/** Maximum create attempts before a colliding token draw gives up (D3). */
const SHARE_LINK_CREATE_ATTEMPTS = 3;

/**
 * Find the active (unexpired) share link for a dedupe key (D4).
 *
 * The key is owner + resolved storage location + chosen lifetime; a row
 * whose `expiresAt` has passed is a miss, exactly as in
 * {@link getShareLinkByToken} (FR-005).
 *
 * @param db - database connection
 * @param key - the dedupe-key fields of {@link CreateShareLinkInput}
 * @param now - reference time, defaults to now
 * @returns the active link, or null
 */
export function findActiveShareLink(
  db: Database,
  key: Pick<
    CreateShareLinkInput,
    "ownerUserId" | "bucket" | "objectKey" | "expiresIn"
  >,
  now: Date = new Date(),
): ShareLink | null {
  const row = db
    .query(
      "SELECT * FROM share_links WHERE ownerUserId = ? AND bucket = ? AND objectKey = ? AND expiresIn = ?",
    )
    .get(key.ownerUserId, key.bucket, key.objectKey, key.expiresIn) as
    ShareLinkRow | undefined;
  if (!row || row.expiresAt <= now.toISOString()) return null;
  return mapShareLinkRow(row);
}

/**
 * Create a share link, computing `expiresAt` from the chosen lifetime.
 *
 * The dedupe key (D4) makes this idempotent per owner + file + lifetime:
 * the active row for the key is looked up first and returned unchanged
 * (FR-006, with its remaining lifetime); only on a miss is a row
 * inserted, replacing any expired row still holding the key.
 *
 * @param db - database connection
 * @param input - link fields (createdAt defaults to now and also decides
 *   whether an existing row is still active; the token is generated and
 *   NOT caller-supplied, so the storage location can never be chosen by
 *   the client)
 * @param options - test injection (tokenFactory)
 * @returns the stored link (pre-existing when still active)
 * @throws {Error} when the token draw collides on every attempt (D3) or
 *   when any other constraint is violated (unknown owner)
 */
export function createShareLink(
  db: Database,
  input: CreateShareLinkInput,
  options: CreateShareLinkOptions = {},
): ShareLink {
  const lifetime = SHARE_LINK_LIFETIME_SECONDS[input.expiresIn];
  if (lifetime === undefined) {
    throw new Error(`Unknown share-link lifetime: "${input.expiresIn}"`);
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  // FR-006 (D4): insert only on a miss. Activity is judged at generation
  // time (createdAt), consistent with the row's own expiresAt clock.
  const active = findActiveShareLink(db, input, new Date(createdAt));
  if (active) return active;
  const expiresAt = new Date(
    Date.parse(createdAt) + lifetime * 1000,
  ).toISOString();
  // A miss means any row still holding the dedupe key is expired; it is
  // deleted so the unique index accepts the fresh draw. Requests run on
  // a single event loop over one synchronous SQLite connection, so no
  // concurrent creator can slip in between the lookup and this delete.
  db.query(
    "DELETE FROM share_links WHERE ownerUserId = ? AND bucket = ? AND objectKey = ? AND expiresIn = ?",
  ).run(input.ownerUserId, input.bucket, input.objectKey, input.expiresIn);
  const draw = options.tokenFactory ?? generateShareToken;
  let collision: unknown;
  for (let attempt = 0; attempt < SHARE_LINK_CREATE_ATTEMPTS; attempt++) {
    const token = draw();
    try {
      db.query(
        "INSERT INTO share_links (token, ownerUserId, bucket, objectKey, expiresIn, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        token,
        input.ownerUserId,
        input.bucket,
        input.objectKey,
        input.expiresIn,
        expiresAt,
        createdAt,
      );
      return {
        token,
        ownerUserId: input.ownerUserId,
        bucket: input.bucket,
        objectKey: input.objectKey,
        expiresIn: input.expiresIn,
        expiresAt,
        createdAt,
      };
    } catch (error) {
      // Only a token primary-key collision is redrawn (D3); anything
      // else (an unknown owner, say) propagates.
      if (
        !(error instanceof Error) ||
        !error.message.includes("share_links.token")
      ) {
        throw error;
      }
      collision = error;
    }
  }
  throw collision;
}

/**
 * Read one unexpired share link by its token.
 *
 * An expired row is treated as a miss (identical to an unknown token,
 * FR-005); it is left in place for the sweep or the route's lazy delete.
 *
 * @param db - database connection
 * @param token - the 12-char token from the public URL
 * @param now - reference time, defaults to now
 * @returns the link, or null when unknown or expired
 */
export function getShareLinkByToken(
  db: Database,
  token: string,
  now: Date = new Date(),
): ShareLink | null {
  const row = db
    .query("SELECT * FROM share_links WHERE token = ?")
    .get(token) as ShareLinkRow | undefined;
  if (!row) return null;
  if (row.expiresAt <= now.toISOString()) return null;
  return mapShareLinkRow(row);
}

/**
 * Delete one share link by token (lazy expiry sweep on lookup, D8).
 *
 * @param db - database connection
 * @param token - the link's token
 */
export function deleteShareLink(db: Database, token: string): void {
  db.query("DELETE FROM share_links WHERE token = ?").run(token);
}

/**
 * Delete every share link whose `expiresAt` has passed (startup sweep,
 * D8). Timestamps are ISO 8601 UTC so string comparison is correct.
 *
 * @param db - database connection
 * @param now - reference time, defaults to now
 * @returns the number of deleted rows
 */
export function sweepExpiredShareLinks(
  db: Database,
  now: Date = new Date(),
): number {
  const result = db
    .query("DELETE FROM share_links WHERE expiresAt <= ?")
    .run(now.toISOString());
  return result.changes;
}

/** Identity-only view of a user, for the share recipient picker (FR-006). */
export interface UserSummary {
  id: string;
  username: string;
}

interface UserSummaryRow {
  id: string;
  username: string;
}

/**
 * Search users by case-insensitive username substring, excluding the
 * caller, ordered by username and capped at `limit` results (R4).
 *
 * `instr(lower(username), lower(?)) > 0` is a plain substring test that
 * avoids LIKE wildcard escaping entirely; usernames are restricted to
 * `[a-z0-9._-]` by {@link validateUsername}, so SQLite's ASCII `lower()`
 * is exact.
 *
 * @param db - database connection
 * @param query - the username substring to match
 * @param excludeUserId - the caller's id; never returned
 * @param limit - maximum results, defaults to 20
 * @returns matching users as identity-only summaries
 */
export function searchUsers(
  db: Database,
  query: string,
  excludeUserId: string,
  limit = 20,
): UserSummary[] {
  const rows = db
    .query(
      "SELECT id, username FROM users WHERE id != ? AND instr(lower(username), lower(?)) > 0 ORDER BY username ASC LIMIT ?",
    )
    .all(excludeUserId, query, limit) as UserSummaryRow[];
  return rows.map((row) => ({ id: row.id, username: row.username }));
}

/** One indexed object's bookkeeping row plus its FTS rowid. */
export interface SearchIndexEntry {
  userId: string;
  key: string;
  etag: string;
  size: number;
  /** ISO 8601 timestamp of the last successful extraction pass. */
  indexedAt: string;
  /** Implicit rowid shared with the search_docs FTS row. */
  rowid: number;
}

/** Input for {@link upsertSearchDoc}. */
export interface UpsertSearchDocInput {
  userId: string;
  key: string;
  etag: string;
  size: number;
  /** Base name of the object (after the last "/"). */
  fileName: string;
  /** Extracted text; empty string for name-only files. */
  body: string;
}

/** The extracted document of one indexed object. */
export interface SearchDoc {
  fileName: string;
  body: string;
}

interface SearchIndexRow {
  rowid: number;
  userId: string;
  key: string;
  etag: string;
  size: number;
  indexedAt: string;
}

function mapSearchIndexRow(row: SearchIndexRow): SearchIndexEntry {
  return {
    userId: row.userId,
    key: row.key,
    etag: row.etag,
    size: row.size,
    indexedAt: row.indexedAt,
    rowid: row.rowid,
  };
}

/**
 * Insert or replace both rows of one indexed object (007-file-search):
 * the search_index bookkeeping row and the search_docs FTS row sharing
 * its rowid. Re-upserting the same (userId, key) replaces the stored
 * fingerprint (etag, size) and the extracted text together, so a changed
 * object never leaves stale text behind (FR-007).
 *
 * @param db - database connection
 * @param input - the object's fingerprint and extracted document
 * @returns the stored index entry including the FTS rowid
 */
export function upsertSearchDoc(
  db: Database,
  input: UpsertSearchDocInput,
): SearchIndexEntry {
  const upsert = db.transaction((): SearchIndexEntry => {
    removeSearchDoc(db, input.userId, input.key);
    const indexedAt = new Date().toISOString();
    const changes = db
      .query(
        "INSERT INTO search_index (userId, key, etag, size, indexedAt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.userId, input.key, input.etag, input.size, indexedAt);
    const rowid = Number(changes.lastInsertRowid);
    db.query(
      "INSERT INTO search_docs (rowid, fileName, body) VALUES (?, ?, ?)",
    ).run(rowid, input.fileName, input.body);
    return {
      userId: input.userId,
      key: input.key,
      etag: input.etag,
      size: input.size,
      indexedAt,
      rowid,
    };
  });
  return upsert();
}

/**
 * Delete both rows of one indexed object: the FTS row (via the shared
 * rowid) and the search_index bookkeeping row. Removing an absent key is
 * a no-op.
 *
 * @param db - database connection
 * @param userId - owner of the space the object lives in
 * @param key - full object key including the user's storage prefix
 */
export function removeSearchDoc(
  db: Database,
  userId: string,
  key: string,
): void {
  const remove = db.transaction(() => {
    const row = db
      .query("SELECT rowid FROM search_index WHERE userId = ? AND key = ?")
      .get(userId, key) as { rowid: number } | null;
    if (row) {
      db.query("DELETE FROM search_docs WHERE rowid = ?").run(row.rowid);
      db.query("DELETE FROM search_index WHERE rowid = ?").run(row.rowid);
    }
  });
  remove();
}

/** Input for {@link moveObjectRecords}. */
export interface MoveObjectRecordsInput {
  /** Bucket holding the object before and after the move. */
  bucket: string;
  /** Owner of the space the object lives in (keys their search index). */
  ownerUserId: string;
  /** Full object key before the move. */
  fromKey: string;
  /** Full object key after the move; same base name as fromKey. */
  toKey: string;
}

/**
 * Carry the database records keyed by an object's key over to its new
 * key after the object was moved in storage, atomically:
 *
 * - Anonymous share links of the object (from any creator) follow it:
 *   their tokens are kept and their stored key is rewritten. Links that
 *   already point at the destination key belonged to a since-removed
 *   object; they are dropped so they can never serve the moved file.
 * - The owner's search entry is rekeyed in place, keeping its extracted
 *   text (a move keeps the base name, so the FTS row is unchanged). A
 *   stale entry at the destination key is removed first.
 *
 * @param db - database connection
 * @param input - bucket, space owner and the old and new full keys
 */
export function moveObjectRecords(
  db: Database,
  input: MoveObjectRecordsInput,
): void {
  const move = db.transaction(() => {
    db.query("DELETE FROM share_links WHERE bucket = ? AND objectKey = ?").run(
      input.bucket,
      input.toKey,
    );
    db.query(
      "UPDATE share_links SET objectKey = ? WHERE bucket = ? AND objectKey = ?",
    ).run(input.toKey, input.bucket, input.fromKey);
    removeSearchDoc(db, input.ownerUserId, input.toKey);
    db.query(
      "UPDATE search_index SET key = ? WHERE userId = ? AND key = ?",
    ).run(input.toKey, input.ownerUserId, input.fromKey);
  });
  move();
}

/**
 * Delete every index and FTS row for one user (FR-014). The FTS rows
 * must be removed by a rowid join *before* the user (or their
 * search_index rows) disappears, because the FTS table has no userId
 * column and no foreign key — {@link deleteUser} calls this ahead of the
 * cascade.
 *
 * @param db - database connection
 * @param userId - id of the user whose index rows are removed
 */
export function deleteSearchIndexByUser(db: Database, userId: string): void {
  const remove = db.transaction(() => {
    db.query(
      "DELETE FROM search_docs WHERE rowid IN (SELECT rowid FROM search_index WHERE userId = ?)",
    ).run(userId);
    db.query("DELETE FROM search_index WHERE userId = ?").run(userId);
  });
  remove();
}

/**
 * List every index row of one user's space (the scan's diff input):
 * key → etag/size fingerprints for change detection (R-004).
 *
 * @param db - database connection
 * @param userId - owner of the space
 * @returns all index entries for the user, unordered
 */
export function listSearchIndex(
  db: Database,
  userId: string,
): SearchIndexEntry[] {
  const rows = db
    .query(
      "SELECT rowid, userId, key, etag, size, indexedAt FROM search_index WHERE userId = ?",
    )
    .all(userId) as SearchIndexRow[];
  return rows.map(mapSearchIndexRow);
}

/**
 * Read the extracted document of one indexed object (joined back through
 * the shared rowid). Null when the object is not indexed.
 *
 * @param db - database connection
 * @param userId - owner of the space the object lives in
 * @param key - full object key including the user's storage prefix
 * @returns the document, or null when absent
 */
export function getSearchDoc(
  db: Database,
  userId: string,
  key: string,
): SearchDoc | null {
  const row = db
    .query(
      "SELECT d.fileName AS fileName, d.body AS body FROM search_docs d JOIN search_index i ON i.rowid = d.rowid WHERE i.userId = ? AND i.key = ?",
    )
    .get(userId, key) as SearchDoc | null;
  return row ?? null;
}

/** One filename match of a search query. */
export interface FileNameSearchHit {
  /** Full object key including the owning user's storage prefix. */
  key: string;
  /** Base name of the object (after the last "/"). */
  fileName: string;
}
/**
 * Find one user's indexed objects whose file name contains the query,
 * case-insensitively (007-file-search, FR-002). Queries of 3+ characters
 * use the trigram FTS index — the query is phrase-quoted and restricted
 * to the `fileName` column, so FTS operators stay literal and body text
 * never produces a filename hit; shorter queries cannot produce trigrams
 * and fall back to a LIKE scan over the same column. Rows outside the
 * owner's space are never returned (constitution IV).
 *
 * @param db - database connection
 * @param userId - owner of the space to search
 * @param query - the (already trimmed, non-empty) search query
 * @param limit - maximum number of hits to return
 * @param keyPrefix - when given, only keys under this prefix match
 *   (shared-scope search, US3): the prefix is the sharer's effective
 *   mount prefix, compared case-exactly
 * @returns hits in relevance order (FTS rank; name order for LIKE)
 */
export function searchFileNames(
  db: Database,
  userId: string,
  query: string,
  limit = 50,
  keyPrefix?: string,
): FileNameSearchHit[] {
  // Shared scopes (US3) constrain hits to the mount prefix.
  const prefix = keyPrefixFilter("i.key", keyPrefix);
  if (query.length < 3) {
    // Trigram MATCH sees nothing for 1-2 character queries: fall back to
    // a case-insensitive LIKE (ASCII), with wildcards kept literal.
    const pattern = `%${query.replace(/([\\%_])/g, "\\$1")}%`;
    return db
      .query(
        `SELECT i.key AS key, d.fileName AS fileName FROM search_docs d JOIN search_index i ON i.rowid = d.rowid WHERE i.userId = ?${prefix.clause} AND d.fileName LIKE ? ESCAPE '\\' ORDER BY d.fileName LIMIT ?`,
      )
      .all(userId, ...prefix.args, pattern, limit) as FileNameSearchHit[];
  }
  const phrase = `fileName : "${query.replace(/"/g, '""')}"`;
  return db
    .query(
      `SELECT i.key AS key, d.fileName AS fileName FROM search_docs d JOIN search_index i ON i.rowid = d.rowid WHERE i.userId = ?${prefix.clause} AND search_docs MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(userId, ...prefix.args, phrase, limit) as FileNameSearchHit[];
}

/** One content match of a search query. */
export interface ContentSearchHit {
  /** Full object key including the owning user's storage prefix. */
  key: string;
  /** Base name of the object (after the last "/"). */
  fileName: string;
  /**
   * Snippet of the document around the first match, with the matched
   * text wrapped in literal <mark>...</mark> markers.
   */
  snippet: string;
}

/**
 * Find one user's indexed documents whose extracted body contains the
 * query, case-insensitively (007-file-search, FR-004). The query is
 * phrase-quoted and restricted to the `body` column, so FTS operators
 * and quotes stay literal and filename text never produces a content
 * hit; the returned snippet quotes the document around the match with
 * `<mark>`/`</mark>` markers (FR-005). Queries under 3 characters cannot
 * produce trigrams and match nothing (FR-016). Rows outside the owner's
 * space are never returned (constitution IV).
 *
 * @param db - database connection
 * @param userId - owner of the space to search
 * @param query - the (already trimmed, non-empty) search query
 * @param limit - maximum number of hits to return
 * @param keyPrefix - when given, only keys under this prefix match
 *   (shared-scope search, US3), compared case-exactly
 * @returns hits in relevance order (FTS rank)
 */
export function searchContent(
  db: Database,
  userId: string,
  query: string,
  limit = 50,
  keyPrefix?: string,
): ContentSearchHit[] {
  if (query.length < 3) {
    return [];
  }
  const prefix = keyPrefixFilter("i.key", keyPrefix);
  const phrase = `body : "${query.replace(/"/g, '""')}"`;
  return db
    .query(
      `SELECT i.key AS key, d.fileName AS fileName, snippet(search_docs, 1, '<mark>', '</mark>', '…', 64) AS snippet FROM search_docs d JOIN search_index i ON i.rowid = d.rowid WHERE i.userId = ?${prefix.clause} AND search_docs MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(userId, ...prefix.args, phrase, limit) as ContentSearchHit[];
}

/** One folder-name match of a search query. */
export interface FolderSearchHit {
  /** Full folder key including the owner's storage prefix and trailing "/". */
  key: string;
  /** Base name of the folder (its last path segment). */
  name: string;
}

/**
 * Replace the stored folder set of one user's space with `keys` (folder
 * search, #13): folders absent from `keys` are deleted, new ones are
 * inserted, and unchanged rows are left alone, so a stable space causes
 * no writes. Runs in one transaction.
 *
 * @param db - database connection
 * @param userId - owner of the space
 * @param keys - every folder key in the space: full keys including the
 *   storage prefix, each ending in "/"
 */
export function syncSearchFolders(
  db: Database,
  userId: string,
  keys: Iterable<string>,
): void {
  const wanted = new Set(keys);
  const sync = db.transaction(() => {
    const stored = db
      .query("SELECT key FROM search_folders WHERE userId = ?")
      .all(userId) as Array<{ key: string }>;
    const remove = db.query(
      "DELETE FROM search_folders WHERE userId = ? AND key = ?",
    );
    for (const { key } of stored) {
      if (!wanted.delete(key)) remove.run(userId, key);
    }
    // `wanted` now holds only the keys not yet stored.
    const insert = db.query(
      "INSERT INTO search_folders (userId, key, name, nameFolded) VALUES (?, ?, ?, ?)",
    );
    for (const key of wanted) {
      const trimmed = key.slice(0, -1);
      const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
      insert.run(userId, key, name, name.toLowerCase());
    }
  });
  sync();
}

/**
 * Find one user's folders whose base name contains the query (folder
 * search, #13): a case-insensitive substring match on the name only,
 * never on parent segments. Case is folded with Unicode rules (the
 * stored `nameFolded` against the lower-cased query), like the trigram
 * filename index, so "übersicht" finds "Übersicht". Rows outside the
 * owner's space are never returned (constitution IV).
 *
 * @param db - database connection
 * @param userId - owner of the space to search
 * @param query - the (already trimmed, non-empty) search query
 * @param limit - maximum number of hits to return
 * @param keyPrefix - when given, only folders at or under this prefix
 *   match, compared case-exactly: the route passes each scope's prefix
 *   (the caller's own storage prefix, or a share's mount prefix — so
 *   the mount root itself is a candidate)
 * @returns hits ordered by folded name, then key
 */
export function searchFolderNames(
  db: Database,
  userId: string,
  query: string,
  limit = 50,
  keyPrefix?: string,
): FolderSearchHit[] {
  const prefix = keyPrefixFilter("key", keyPrefix);
  return db
    .query(
      `SELECT key, name FROM search_folders WHERE userId = ?${prefix.clause} AND instr(nameFolded, ?) > 0 ORDER BY nameFolded, key LIMIT ?`,
    )
    .all(
      userId,
      ...prefix.args,
      query.toLowerCase(),
      limit,
    ) as FolderSearchHit[];
}

/**
 * Build the SQL restricting `column` to keys that start with
 * `keyPrefix`, compared case-exactly. LIKE must not be used for this:
 * it folds ASCII case, so a mount prefix "projects/" would also admit a
 * sibling "Projects/" folder outside the share (constitution IV).
 *
 * @param column - the key column to restrict
 * @param keyPrefix - the required key prefix; absent or "" restricts
 *   nothing
 * @returns a clause to append after the WHERE conditions, and its
 *   positional arguments
 */
function keyPrefixFilter(
  column: string,
  keyPrefix: string | undefined,
): { clause: string; args: string[] } {
  return keyPrefix
    ? {
        clause: ` AND substr(${column}, 1, length(?)) = ?`,
        args: [keyPrefix, keyPrefix],
      }
    : { clause: "", args: [] };
}
