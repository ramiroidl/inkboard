# Changelog

## 0.8.5

- Firmware 0.6.0 shows connection problems: when a wake cannot reach Wi-Fi or the
  controller, the display redraws the last screen with a status icon next to the battery
  badge. The firmware now keeps the screen's ETag across deep sleep, so unchanged screens
  no longer trigger a full panel refresh on every wake.
- Firmware 0.6.0 also fixes displays that still slept about 5 seconds after waking.
  Restoring the maintenance mode switch at boot ran its "off" action, which scheduled
  deep sleep before Wi-Fi connected. Keys work from sleep again: the key that woke the
  display requested its screen before Wi-Fi connected, failed, and put the display back
  to sleep. Install the updated `inkboard-og.yaml` from ESPHome Device Builder.

## 0.8.4

- The battery badge no longer hides the "1" of "100%" under the battery icon.
- Microsoft To Do asks Graph for open tasks only, so lists with a long history of
  completed tasks no longer hide newly added tasks.
- The display image accepts an empty or comma-separated `If-None-Match` header, so
  firmware can always send the ETag it remembers.

## 0.8.3

- Firmware 0.5.1 fixes displays that stopped refreshing with maintenance mode off. The
  2-minute awake limit ran within seconds of every wake, so the display went back to sleep
  before connecting. Install the updated `inkboard-og.yaml` from ESPHome Device Builder.

## 0.8.2

- **Hide** any screen to keep it without showing it on displays. Rotation, schedules, and
  buttons skip it; showing it again restores its place. Backups keep hidden screens.
- Japanese Study shows up to five words per screen, each centered in its column.

## 0.8.1

- **Show battery** for each display: the battery level in the lower-right corner of the
  screen, on by default. The display card shows the level next to the voltage.
- Firmware 0.5.0 saves battery: maintenance mode is off after installing and turns itself
  off after 30 minutes, and the display sleeps 5 seconds after a refresh instead of 20.
  Install it from ESPHome Device Builder.

## 0.8.0

- **Japanese Study** widget: curated N5/travel vocabulary, kana readings,
  translations, optional romaji, beginner grammar, and stable daily/hourly lessons.
- Schema-driven CSV upload with validation, preview, and per-instance backup
  persistence. Japanese rendering uses Noto Sans CJK JP in both image targets.
- All content screens use the same editable, self-contained widget system.
  Calendar and To Do selections and display options belong to each instance;
  empty selections no longer inherit page-wide defaults.
- Existing Calendar and To Do screens and inherited selections migrate
  automatically, preserving rotation, schedules, and display assignments.
  Deleting a migrated screen no longer restores a fixed-layout screen.
- Removed duplicate widget selection cards. Connections, device details,
  diagnostics, rotation, schedules, quiet hours, and backups are collapsed by default.
- Portable backups export version 2 per-instance settings and accept older
  version 1 files, including their fixed-layout screens and inherited selections.
- Added a README architecture diagram covering hosting, widgets, and device connections.

## 0.7.3

- **Customize** the built-in Calendar and To Do screens: they become regular screens built
  from widgets, so every part can be configured. Deleting the copy restores the built-in.
- The rotation controls line up.

## 0.7.2

- **Invert colors** option for each display, for panels that show a black background.
  No firmware change is needed.

## 0.7.1

- Month calendar: show the full month name down the left side, or hide it, and choose
  normal, large, or extra large text.
- Heading: choose large, medium, or small.

## 0.7.0

- **Month calendar** widget: the whole month with event names, today marked, past days
  crossed out, and an optional seven-day forecast from Open-Meteo. On its own, it fills
  the whole display.

## 0.6.1

- Export and import screens and display settings from the new **Backup** card.

## 0.6.0

- Microsoft To Do: device-code sign-in, list selection, a To Do screen, and a To Do list
  widget. Tokens are encrypted at rest and tasks stay visible during outages.
- New options: Microsoft app (client) ID and tenant.
- Calendar agenda and To Do list widgets can choose their own calendars and lists.
- To Do list widget options to hide due dates and list names.
- List widgets show as many rows as fit, with "+N MORE", instead of being left out.
- Option to hide the test pattern screen.
- Admin forms show the reason for rejected settings.

## 0.5.0

- First Home Assistant App release.
- Admin UI through Home Assistant ingress; separate LAN port (8100) for the display.
- Home Assistant access through the Supervisor, with no long-lived access token.
- Generated device token, shown on the Inkboard page.
- Entity suggestions in the screen editor.
