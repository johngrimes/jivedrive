-- rclone sync credentials: every S3 key a user issues gets its own OVH
-- Object Storage user (ovhUserId) carrying a prefix-scoped policy. One
-- user per key is what makes per-key revocation work: OVH only stops a
-- used key promptly once its user's policy is replaced with deny-all,
-- and a policy applies to all of a user's keys. Secrets are shown once at
-- creation and never stored. Deleting the JiveDrive user cascades the rows
-- (the route revokes every key at OVH first).

CREATE TABLE sync_credentials (
  accessKeyId  TEXT PRIMARY KEY,
  userId       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ovhUserId    TEXT NOT NULL,
  label        TEXT NOT NULL,
  createdAt    TEXT NOT NULL
);

CREATE INDEX idx_sync_credentials_user_id ON sync_credentials(userId);
