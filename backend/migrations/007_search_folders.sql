-- Folder search (#13): one row per folder in a user's space, rebuilt by
-- the search scan from every listed key — the ancestors of each file
-- plus folder placeholder objects (keys ending in "/"), so empty folders
-- are searchable too. `key` is the full folder key including the user's
-- storage prefix and the trailing "/"; `name` is its base name, the only
-- text a folder query matches, and `nameFolded` its Unicode lower-case
-- form, which queries match against (SQLite's own case folding is ASCII
-- only). Deleting a user cascades their rows.

CREATE TABLE search_folders (
  userId     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  nameFolded TEXT NOT NULL,
  PRIMARY KEY (userId, key)
);
