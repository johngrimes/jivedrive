-- Rolling idle clock for sessions: lastUsedAt is touched on validation and
-- drives the idle timeout (JIVEDRIVE_SESSION_IDLE_DAYS), capped by the
-- absolute expiresAt TTL.

ALTER TABLE sessions ADD COLUMN lastUsedAt TEXT;

-- Backfill: pre-existing sessions start with a full idle allowance.
UPDATE sessions SET lastUsedAt = createdAt WHERE lastUsedAt IS NULL;
