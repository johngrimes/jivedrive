-- User-to-user folder sharing (006-folder-sharing): persistent, revocable
-- grants of full read/write access to one folder in the owner's space,
-- granted to one recipient. Deleting either user removes their shares
-- (ON DELETE CASCADE on both foreign keys).

CREATE TABLE shares (
  id               TEXT PRIMARY KEY,
  ownerUserId      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipientUserId  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder           TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  UNIQUE (ownerUserId, recipientUserId, folder)
);

CREATE INDEX idx_shares_owner_user_id ON shares(ownerUserId);
CREATE INDEX idx_shares_recipient_user_id ON shares(recipientUserId);
