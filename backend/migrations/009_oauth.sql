-- OAuth 2.1 authorization server for remote MCP clients (Claude custom
-- connectors). Clients register dynamically (public clients, no secret);
-- a user's consent creates a grant, and every code and token hangs off
-- that grant, so revoking a grant (or deleting the user) cascades every
-- secret it issued. Codes and tokens are stored only as SHA-256 hex
-- hashes, never raw.

CREATE TABLE oauth_clients (
  clientId      TEXT PRIMARY KEY,
  clientName    TEXT NOT NULL,
  -- JSON array of exact redirect URIs.
  redirectUris  TEXT NOT NULL,
  createdAt     TEXT NOT NULL
);

-- Pending consent: created by /oauth/authorize, consumed by approve/deny.
CREATE TABLE oauth_authorization_requests (
  id             TEXT PRIMARY KEY,
  clientId       TEXT NOT NULL REFERENCES oauth_clients(clientId) ON DELETE CASCADE,
  redirectUri    TEXT NOT NULL,
  state          TEXT,
  codeChallenge  TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  expiresAt      TEXT NOT NULL
);

CREATE TABLE oauth_grants (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clientId    TEXT NOT NULL REFERENCES oauth_clients(clientId) ON DELETE CASCADE,
  createdAt   TEXT NOT NULL,
  lastUsedAt  TEXT
);

CREATE INDEX idx_oauth_grants_user_id ON oauth_grants(userId);
CREATE INDEX idx_oauth_grants_client_id ON oauth_grants(clientId);

-- Single-use codes; usedAt is kept until expiry so a replay can revoke
-- the grant it issued.
CREATE TABLE oauth_codes (
  codeHash       TEXT PRIMARY KEY,
  grantId        TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirectUri    TEXT NOT NULL,
  codeChallenge  TEXT NOT NULL,
  resource       TEXT NOT NULL,
  expiresAt      TEXT NOT NULL,
  usedAt         TEXT
);

CREATE INDEX idx_oauth_codes_grant_id ON oauth_codes(grantId);

CREATE TABLE oauth_access_tokens (
  tokenHash  TEXT PRIMARY KEY,
  grantId    TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expiresAt  TEXT NOT NULL
);

CREATE INDEX idx_oauth_access_tokens_grant_id ON oauth_access_tokens(grantId);

-- Rotated on use: usedAt marks a token already exchanged; presenting it
-- again deletes the whole grant.
CREATE TABLE oauth_refresh_tokens (
  tokenHash  TEXT PRIMARY KEY,
  grantId    TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expiresAt  TEXT NOT NULL,
  usedAt     TEXT
);

CREATE INDEX idx_oauth_refresh_tokens_grant_id ON oauth_refresh_tokens(grantId);
