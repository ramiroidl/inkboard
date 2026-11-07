ALTER TABLE devices ADD COLUMN screen_changed_at TEXT;

CREATE TABLE custom_screens (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  widgets_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
