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
  expiresAt: string;
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
  expiresAt: string;
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
}

function mapUserRow(row: UserRow): User {
  return { ...row, isAdmin: row.isAdmin === 1 };
}

function mapCredentialRow(row: CredentialRow): PasskeyCredential {
  return { ...row, transports: JSON.parse(row.transports) as string[] };
}

function mapInviteRow(row: InviteRow): Invite {
  return { ...row, isAdmin: row.isAdmin === 1 };
}

function mapSessionRow(row: SessionRow): Session {
  return { ...row };
}

/**
 * Validate a username against the data-model pattern.
 *
 * @param username - username to validate
 * @throws {Error} when the username does not match [a-z0-9][a-z0-9._-]{0,31}
 */
function validateUsername(username: string): void {
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
function validateBucket(bucket: string): void {
  if (!/^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`Invalid bucket name "${bucket}"`);
  }
}

/**
 * Normalise a storage prefix: no leading slash, exactly one trailing slash,
 * empty string for the bucket root.
 *
 * @param prefix - raw prefix
 * @returns the normalised prefix
 * @throws {Error} when the prefix starts with "/"
 */
export function normalizePrefix(prefix: string | null | undefined): string {
  const value = prefix ?? "";
  if (value === "") return "";
  if (value.startsWith("/")) {
    throw new Error(`Invalid prefix "${value}": must not have a leading "/"`);
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
  db.query(
    "INSERT INTO passkey_credentials (id, userId, publicKey, counter, transports, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.userId,
    input.publicKey,
    input.counter ?? 0,
    JSON.stringify(input.transports ?? []),
    createdAt,
    input.lastUsedAt ?? null,
  );
  return {
    id: input.id,
    userId: input.userId,
    publicKey: input.publicKey,
    counter: input.counter ?? 0,
    transports: input.transports ?? [],
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
 * @param id - credential id
 */
export function deleteCredential(db: Database, id: string): void {
  db.query("DELETE FROM passkey_credentials WHERE id = ?").run(id);
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
  db.query(
    "INSERT INTO sessions (id, token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.token, input.userId, createdAt, input.expiresAt);
  return {
    id,
    token: input.token,
    userId: input.userId,
    createdAt,
    expiresAt: input.expiresAt,
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
