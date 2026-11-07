import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    contentKey: text("content_key").notNull().unique(),
    checksum: text("checksum").notNull().unique(),
    filePath: text("file_path").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bitsPerPixel: integer("bits_per_pixel").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("artifacts_kind_created_at_idx").on(table.kind, table.createdAt)],
);

export type ArtifactRecord = typeof artifacts.$inferSelect;

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    model: text("model").notNull(),
    firmwareVersion: text("firmware_version").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastScreenRevision: text("last_screen_revision"),
    lastWakeReason: text("last_wake_reason").notNull(),
    lastWifiRssi: real("last_wifi_rssi"),
    lastBatteryVoltage: real("last_battery_voltage"),
    lastButtonEvent: text("last_button_event").notNull(),
    lastDisplayResult: text("last_display_result").notNull(),
    currentScreenId: text("current_screen_id"),
    screenChangedAt: text("screen_changed_at"),
    manualHoldUntil: text("manual_hold_until"),
    manualRequestAt: text("manual_request_at"),
    scheduleRuleId: text("schedule_rule_id"),
    preScheduleScreenId: text("pre_schedule_screen_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("devices_last_seen_at_idx").on(table.lastSeenAt)],
);

export const deviceCheckIns = sqliteTable(
  "device_check_ins",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    receivedAt: text("received_at").notNull(),
    firmwareVersion: text("firmware_version").notNull(),
    screenRevision: text("screen_revision"),
    wakeReason: text("wake_reason").notNull(),
    wifiRssi: real("wifi_rssi"),
    batteryVoltage: real("battery_voltage"),
    buttonEvent: text("button_event").notNull(),
    displayResult: text("display_result").notNull(),
  },
  (table) => [
    index("device_check_ins_device_received_at_idx").on(table.deviceId, table.receivedAt),
  ],
);

export type DeviceRecord = typeof devices.$inferSelect;
export type DeviceCheckInRecord = typeof deviceCheckIns.$inferSelect;

export const customScreens = sqliteTable("custom_screens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  widgetsJson: text("widgets_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
