CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  model TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_screen_revision TEXT,
  last_wake_reason TEXT NOT NULL,
  last_wifi_rssi REAL,
  last_battery_voltage REAL,
  last_button_event TEXT NOT NULL,
  last_display_result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX devices_last_seen_at_idx
  ON devices (last_seen_at DESC);

CREATE TABLE device_check_ins (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  screen_revision TEXT,
  wake_reason TEXT NOT NULL,
  wifi_rssi REAL,
  battery_voltage REAL,
  button_event TEXT NOT NULL,
  display_result TEXT NOT NULL
);

CREATE INDEX device_check_ins_device_received_at_idx
  ON device_check_ins (device_id, received_at DESC);
