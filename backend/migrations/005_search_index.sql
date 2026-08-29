-- Search index (007-file-search): one bookkeeping row per indexed object
-- plus an FTS5 trigram virtual table for filename/content matching. The
-- FTS row shares the search_index row's implicit rowid, so queries join
-- back through rowid and filter by owner in SQL (data-model.md). Deleting
-- a user cascades the search_index rows (FR-014); the matching FTS rows
-- are removed by the repository before the cascade runs.

CREATE TABLE search_index (
  userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  etag      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  indexedAt TEXT NOT NULL,
  PRIMARY KEY (userId, key)
);

CREATE VIRTUAL TABLE search_docs USING fts5(
  fileName,
  body,
  tokenize='trigram'
);
