# Changelog

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
