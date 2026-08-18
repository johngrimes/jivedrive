-- Track discoverable (resident-key) credentials for username-less sign-in.
-- 1 = created with residentKey: "required" (usable username-less);
-- 0 = legacy (never offered, deleted on re-enrollment).
-- Existing rows default to 0 and read as legacy.

ALTER TABLE passkey_credentials ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0;
