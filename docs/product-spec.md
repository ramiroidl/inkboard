# Inkboard Controller product specification

**Status:** Draft for implementation

**Target hardware:** Seeed Studio TRMNL 7.5" (OG) DIY Kit (EE04)

**Display:** 800x480, monochrome e-paper

**Operating model:** Local-first, ESPHome device plus a LAN controller

## 1. Product summary

Inkboard Controller turns the Seeed Studio TRMNL 7.5-inch DIY kit into a
configurable household information display. A browser-based controller lets an
administrator create screens from:

- a page reachable on the local network;
- reusable information widgets;
- Home Assistant calendar data; and
- Microsoft To Do lists.

The controller renders the selected screen to an e-paper-safe image. The
ESPHome device wakes, downloads the latest image, refreshes the panel, reports
basic health, and returns to sleep.

## 2. Goals

1. Operate on the local network without depending on the TRMNL cloud.
2. Support the Seeed kit's 800x480 black-and-white panel, 2000 mAh battery, and
   three programmable user buttons.
3. Display a configured local web page as a full-screen capture.
4. Compose screens from first-party widgets with a consistent e-paper design.
5. Read upcoming events from one or more Home Assistant calendar entities.
6. Read active tasks from selected Microsoft To Do lists.
7. Keep Home Assistant and Microsoft credentials off the display device.
8. Preserve the last successful screen when a data source or controller fails.
9. Make screen previews match device output.

## 3. Non-goals for the first release

- General-purpose browsing or interaction on the e-paper device.
- Touch input, animations, video, or sub-minute live updates.
- Editing Home Assistant events or Microsoft To Do tasks.
- A public cloud service or access from outside the home network.
- Arbitrary user-supplied JavaScript plugins.
- Guaranteed partial refresh. The initial release uses full refreshes for
  predictable output and low ghosting.

## 4. Users and primary workflows

### Administrator

The administrator installs the controller, connects integrations, creates
screens, previews them, assigns a schedule, and monitors the device.

### Viewer

The viewer reads the display without signing in or interacting with it.

### Core workflows

1. **Commission the display:** flash ESPHome over USB, provision Wi-Fi, pair the
   device with the controller, and show a test pattern.
2. **Show a local page:** add an allowlisted URL, choose viewport and crop
   behavior, preview the monochrome result, and publish it.
3. **Create a dashboard:** arrange calendar, task list, date/time, text, and
   status widgets on an 800x480 canvas.
4. **Schedule screens:** rotate screens by time window, duration, or priority.
5. **Recover from failure:** continue showing the last good image and expose a
   stale/error state in the controller without replacing useful content.

## 5. Functional requirements

### 5.1 Device management

- Register a device with a generated identifier and revocable image token.
- Store display dimensions, orientation, refresh interval, time zone, and sleep
  window.
- Report last check-in, firmware version, Wi-Fi RSSI, battery voltage, last
  successful refresh, and current screen revision when available.
- Provide a maintenance mode that keeps the device awake for logs and OTA.
- Support configurable short-press actions for all three user buttons. Initial
  defaults are previous screen, refresh current screen, and next screen.
- Support long-press actions for maintenance/provisioning while preventing an
  accidental press from erasing configuration.
- Expose button presses to Home Assistant and include their wake reason in
  device check-ins.

### 5.2 Screen sources

Each screen has one of these source types:

| Type          | Behavior                                                             |
| ------------- | -------------------------------------------------------------------- |
| Web page      | Capture an allowlisted HTTP/HTTPS page with a fixed 800x480 viewport |
| Widget layout | Compose first-party widgets in a grid                                |
| Static image  | Fit or crop an uploaded image and convert it to monochrome           |
| Message       | Render a simple title, body, and optional timestamp                  |

For web pages, the administrator can configure load timeout, an optional CSS
selector to capture, fit mode, and an optional delay after network idle.
Authentication headers or cookies are stored by the controller and are never
sent to the display.

### 5.3 Widget system

The first widget set is:

- date and time;
- static text;
- Home Assistant calendar agenda;
- Microsoft To Do task list;
- Home Assistant entity value;
- device status; and
- divider/spacer.

Every widget defines a title, data binding, empty state, error state, minimum
size, and e-paper rendering rules. Layouts use an 8-pixel grid and must remain
legible at the physical display size.

### 5.4 Home Assistant calendar

- Connect with a Home Assistant base URL and long-lived access token.
- Discover readable `calendar.*` entities.
- Fetch events for a configurable look-ahead period.
- Merge selected calendars, normalize them to the configured time zone, sort by
  start time, and visibly distinguish all-day events.
- Configure maximum event count and optional calendar-name visibility.
- Cache the last successful result and mark stale data in the preview.

Home Assistant exposes calendar events through
`GET /api/calendars/<entity_id>?start=<timestamp>&end=<timestamp>`.

### 5.5 Microsoft To Do

- Authorize a Microsoft account using delegated OAuth.
- Request read-only task permission for the first release.
- Discover lists through `GET /me/todo/lists`.
- Read tasks through `GET /me/todo/lists/{listId}/tasks`.
- Select lists, hide completed tasks, sort by importance/due date, and limit the
  number shown.
- Refresh tokens server-side and surface reauthorization failures.
- Never place Microsoft tokens in ESPHome secrets or image URLs.

Task completion and editing require a separate, explicit read/write permission
and are deferred.

### 5.6 Rendering and publishing

- Render exactly 800x480 pixels in landscape orientation.
- Produce a deterministic 1-bit output using a configurable threshold or
  ordered dithering preset.
- Default to a 1-bit BMP because the uncompressed payload is predictable and
  inexpensive for the ESP32-S3 to decode.
- Keep the current and previous successful artifacts.
- Publish a new immutable revision only after data collection and rendering
  both succeed.
- Return `ETag` and `Last-Modified` headers so unchanged images are not
  downloaded repeatedly.
- Show preview, source freshness, render duration, image size, and revision in
  the controller.

### 5.7 Scheduling

- Configure a default refresh interval from 5 minutes to 24 hours.
- Configure quiet hours during which the device stays asleep.
- Assign screens to time windows and weekdays.
- Resolve the active screen deterministically by priority, then schedule order.
- Do not generate a new image when neither source data nor screen configuration
  has changed.

## 6. Quality requirements

| Area          | Requirement                                                                            |
| ------------- | -------------------------------------------------------------------------------------- |
| Availability  | The last good screen remains visible through controller, Wi-Fi, and upstream outages   |
| Performance   | Cached image response under 250 ms on the LAN; typical widget render under 5 seconds   |
| Image size    | 1-bit BMP is exactly 48,062 bytes for an 800x480 image                                 |
| Security      | Integration secrets stay server-side and are encrypted at rest                         |
| Network       | No inbound connection to the sleeping display is required                              |
| Accessibility | Core information remains understandable without grayscale or color                     |
| Observability | Structured logs include device, screen, render revision, source, duration, and outcome |
| Portability   | Controller runs as a Docker container; Home Assistant add-on packaging may follow      |

## 7. Failure behavior

- **Source unavailable:** use cached source data within its stale limit; otherwise
  retain the last rendered screen.
- **Render failure:** do not publish a partial or error image over useful content.
- **Image download failure:** device retains the existing e-paper image and
  retries on the next scheduled wake.
- **Invalid image:** reject it before publishing and record the validation error.
- **Expired authorization:** mark the connector as requiring attention; do not
  repeatedly retry an unrecoverable OAuth error.
- **Display timeout:** report the ESPHome component warning and avoid a rapid
  reboot loop.

## 8. Acceptance criteria

The first usable release is complete when:

1. The Seeed EE04 kit can be flashed over USB and join Wi-Fi using ESPHome.
2. A full black/white/checkerboard test confirms correct orientation, polarity,
   dimensions, and refresh behavior.
3. The device downloads a token-protected 800x480 1-bit image from the LAN and
   displays it after a cold boot and timed wake.
4. An unchanged screen does not cause a new artifact or unnecessary panel
   refresh.
5. A configured local page is captured and its preview matches the panel output.
6. A calendar screen displays events from at least one Home Assistant calendar.
7. A task screen displays active tasks from a selected Microsoft To Do list.
8. Disconnecting the controller or either upstream integration leaves the last
   good screen visible.
9. Integration credentials are absent from device configuration, logs, and
   image URLs.

## 9. Delivery plan

### Phase 0: hardware validation spike

- Confirm the board is the Seeed EE04 revision with XIAO ESP32-S3 Plus and the
  jumper is in 24-pin mode.
- Reproduce Seeed's official ESPHome `7.50inv2` test using the documented pin
  map.
- Validate wake behavior for KEY1/KEY2/KEY3, battery ADC calibration, display
  power enable, PSRAM, and a complete display sleep/wake cycle.
- Measure full refresh, partial-refresh feasibility, active current, sleep
  current, and image download memory.

This phase remains a release gate, but panel compatibility is no longer
speculative: Seeed publishes a working ESPHome configuration for this exact kit.

### Phase 1: vertical slice

- Dockerized controller packaged as a Home Assistant App, device registration,
  static test renderer, direct ESPHome image API, preview, health, and last-good
  caching.

### Phase 2: useful local dashboard

- Widget layout editor, Home Assistant calendar/entity connectors, scheduling,
  and local-page capture.

### Phase 3: Microsoft To Do

- Microsoft OAuth, list discovery, task caching, task-list widget, and connector
  health.

### Phase 4: hardening

- Battery tuning, quiet hours, OTA workflow, backup/restore, metrics, and Home
  Assistant add-on packaging.

## 10. Open product decisions

- Whether local-page capture may execute JavaScript by default.
- Whether multiple physical displays are required in the first release.
- Whether later releases should support marking To Do items complete from a
  Home Assistant action or physical button.
