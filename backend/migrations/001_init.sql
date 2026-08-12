-- Initial JiveDrive schema: users, passkey credentials, invites and sessions.
-- Schema versioning is managed by the migration runner in src/db/migrate.ts.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  bucket     TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  isAdmin    INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL
);

CREATE TABLE passkey_credentials (
  id           TEXT PRIMARY KEY,
  userId       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  publicKey    TEXT NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '[]',
  createdAt    TEXT NOT NULL,
  lastUsedAt   TEXT
);

CREATE INDEX idx_passkey_credentials_user_id ON passkey_credentials(userId);

CREATE TABLE invites (
  id               TEXT PRIMARY KEY,
  token            TEXT NOT NULL UNIQUE,
  username         TEXT NOT NULL,
  bucket           TEXT NOT NULL,
  prefix           TEXT NOT NULL,
  isAdmin          INTEGER NOT NULL DEFAULT 0,
  issuedByUserId   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiresAt        TEXT NOT NULL,
  claimedByUserId  TEXT REFERENCES users(id) ON DELETE CASCADE,
  claimedAt        TEXT,
  createdAt        TEXT NOT NULL
);

CREATE INDEX idx_invites_issued_by_user_id ON invites(issuedByUserId);
CREATE INDEX idx_invites_claimed_by_user_id ON invites(claimedByUserId);
CREATE INDEX idx_invites_token ON invites(token);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  userId     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt  TEXT NOT NULL,
  expiresAt  TEXT NOT NULL
);

CREATE INDEX idx_sessions_user_id ON sessions(userId);
CREATE INDEX idx_sessions_token ON sessions(token);
