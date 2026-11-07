CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  content_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bits_per_pixel INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX artifacts_kind_created_at_idx
  ON artifacts (kind, created_at DESC);
