-- Short share links (009-short-share-links): a stored, expiring
-- capability for anonymous download of exactly one file via
-- <origin>/s/<token>. The token is the only public identifier; the
-- storage location never leaves the row. Links are fire-and-forget:
-- stored only until expiry, never listed and never revoked early
-- (FR-007). Deleting a user removes every link they created (FR-008).
-- The unique dedupe index enforces one row per owner, file and chosen
-- lifetime (FR-006, D4).

CREATE TABLE share_links (
  token       TEXT PRIMARY KEY,
  ownerUserId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket      TEXT NOT NULL,
  objectKey   TEXT NOT NULL,
  expiresIn   TEXT NOT NULL CHECK (expiresIn IN ('1h', '24h', '7d', '30d')),
  expiresAt   TEXT NOT NULL,
  createdAt   TEXT NOT NULL
);

CREATE INDEX idx_share_links_owner_user_id ON share_links(ownerUserId);
CREATE INDEX idx_share_links_expires_at ON share_links(expiresAt);
CREATE UNIQUE INDEX uq_share_links_active_dedupe
  ON share_links(ownerUserId, bucket, objectKey, expiresIn);
