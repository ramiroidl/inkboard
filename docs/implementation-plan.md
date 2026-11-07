# Inkboard Controller implementation plan

**Status:** Ready to execute

## 1. Delivery strategy

Build one portable controller application, then package it in two forms:

1. a Home Assistant App with an ingress administration UI and a fixed LAN port
   for devices; and
2. a standard Docker image for development and non-Supervisor installations.

Use ESPHome for the first end-to-end device path. Seeed publishes a working
configuration for the exact EE04/XIAO ESP32-S3 Plus kit, including the display,
PSRAM, buttons, battery monitor, and Home Assistant integration. This also lets
Inkboard use all three user buttons. Keep the server protocol extensible to the
native TRMNL firmware through a later compatibility adapter.

The first useful increment is deliberately narrow:

> Pair one ESPHome device, render one deterministic screen, return it through the
> direct image API, display it, retain it through an outage, and inspect the
> result in the Home Assistant UI.

## 2. Chosen stack

| Concern        | Choice                                          | Reason                                                           |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Runtime        | Node.js 24.22.1 LTS, TypeScript                 | One language across API, jobs, renderer, and UI contracts        |
| API            | Fastify                                         | Small, typed, schema-oriented, and suitable for a single service |
| Admin UI       | React, Vite                                     | Lightweight SPA that can use relative URLs under ingress         |
| Database       | SQLite, Drizzle ORM                             | Durable single-node storage with explicit migrations             |
| Validation     | TypeBox/JSON Schema                             | Shared runtime validation and OpenAPI-compatible schemas         |
| Rendering      | Chromium through `playwright-core`              | Deterministic HTML/CSS and local-page capture                    |
| Image pipeline | Sharp plus an internal 1-bit BMP encoder        | Controlled monochrome conversion and exact 48,062-byte output    |
| Jobs           | Database-backed job table and in-process worker | No Redis requirement for a single Home Assistant appliance       |
| Tests          | Vitest, Fastify injection, Playwright           | Unit, API, golden-image, and browser coverage                    |
| Logging        | Pino                                            | Structured logs already integrated with Fastify                  |
| Packaging      | Docker plus Home Assistant App metadata         | Portable core with first-class HA installation                   |

Do not adopt a distributed queue, PostgreSQL, or separate renderer service until
measurements show a single process cannot meet the workload.

## 3. Runtime boundaries

The container exposes two listeners:

| Listener       | Audience                     | Authentication                                |
| -------------- | ---------------------------- | --------------------------------------------- |
| Ingress UI/API | Home Assistant browser users | Home Assistant ingress session                |
| Device API     | E-paper devices on the LAN   | Per-device bearer token or TRMNL access token |

The ingress listener accepts traffic only from the Supervisor network. The
device listener exposes only setup, display, image, log, and check-in routes. It
must not expose administration routes.

In standalone Docker mode, the administration listener uses a local admin
account configured during first-run setup.

## 4. Repository layout

```text
apps/
  controller/
    src/
      api/
      auth/
      connectors/
      db/
      device-protocol/
      jobs/
      renderer/
      scheduler/
      storage/
      widgets/
    migrations/
    test/
  web/
    src/
packages/
  contracts/
  epaper-image/
  widget-sdk/
firmware/
  esphome/
  trmnl/
home-assistant-app/
  config.yaml
  build.yaml
  Dockerfile
  DOCS.md
  CHANGELOG.md
docker/
  Dockerfile
docs/
```

Start as a package workspace, but deploy one container and one process.

## 5. Milestones

### Milestone 0: development foundation

**Outcome:** A reproducible controller skeleton runs locally and in CI.

Work:

- Initialize the TypeScript workspace and pinned Node/package-manager versions.
- Add formatting, linting, type checking, unit tests, and production builds.
- Create Fastify and React applications with shared contracts.
- Add SQLite startup, migrations, transaction helpers, and temporary test
  databases.
- Add structured logging, configuration validation, liveness, and readiness.
- Build a multi-stage Docker image for `amd64` and `aarch64`.
- Add CI for checks, tests, image build, and dependency review.

Exit criteria:

- A clean checkout builds and starts with one command.
- `/health/live` and `/health/ready` behave independently.
- The SPA loads using a configurable base path.
- Database migrations apply to an empty and existing database.
- Container state survives restart through a mounted data directory.

### Milestone 1: e-paper image pipeline

**Outcome:** The controller creates valid, deterministic Seeed 800x480 images.

Work:

- Define the `800x480-mono` display profile.
- Render deterministic HTML/SVG test patterns in Chromium.
- Convert screenshots to grayscale, threshold or ordered-dither them, and pack
  pixels into a 1-bit BMP.
- Implement strict BMP validation: dimensions, planes, bit depth, row order,
  palette, file size, and checksum.
- Store immutable artifacts and atomically update the latest pointer.
- Add current/previous artifact retention and content-key deduplication.
- Add preview PNG generation for the administration UI.

Test patterns:

- all white and all black;
- one-pixel border and corner labels;
- checkerboard and horizontal/vertical lines;
- font samples at supported minimum sizes; and
- orientation/polarity marker.

Exit criteria:

- Every BMP is exactly 800x480, 1 bit per pixel, and 48,062 bytes.
- Identical input produces an identical checksum.
- Failed renders never replace the latest successful artifact.
- Golden-image tests cover threshold and dithering behavior.

### Milestone 2: Seeed ESPHome device vertical slice

**Outcome:** The physical Seeed EE04 kit retrieves and displays a generated
image, reports telemetry, responds to all three keys, and sleeps safely.

Work:

- Create an ESPHome package for the XIAO ESP32-S3 Plus with Arduino framework,
  80 MHz octal PSRAM, API encryption, OTA, and maintenance mode.
- Configure the proven `7.50inv2` display with SPI clock GPIO7, MOSI GPIO9, CS
  GPIO44, DC GPIO10, reset GPIO38, active-low busy GPIO4, and display enable
  GPIO43 where required by measurement.
- Configure KEY1 GPIO2, KEY2 GPIO3, and KEY3 GPIO5 as active-low buttons.
- Map short presses to previous, refresh, and next; report gestures to Home
  Assistant and the controller.
- Configure battery measurement on GPIO1 with GPIO6 enabled only during reads.
- Implement direct image retrieval with `ETag`/revision comparison.
- Implement device check-in with firmware, revision, wake reason, RSSI, battery,
  button event, and display result.
- Persist device identity, token hash, firmware/model, dimensions, last seen,
  RSSI, battery voltage, refresh interval, and displayed revision.
- Add pairing, token rotation, revoke, and identify operations.
- Add a maximum awake duration, manual maintenance switch, and OTA recovery
  procedure using the XIAO Boot/Reset controls.
- Add bounded request sizes, rate limits, and redacted device logs.

Exit criteria:

- The 24-pin jumper position and safe cable/power procedure are documented.
- The device can pair without manually editing the database.
- A physical device displays the generated test pattern in the right
  orientation and polarity.
- KEY1/KEY2/KEY3 are individually debounced and perform the configured action.
- Timer wake and each supported key wake are identified correctly.
- Repeated polls for the same revision do not refresh the panel.
- Battery voltage is within the agreed tolerance of a multimeter reading.
- PSRAM is detected and heap remains above a measured safety threshold.
- Controller unavailability leaves the last panel image intact.
- Revoking a device token prevents later image access.

### Milestone 3: Home Assistant App packaging

**Outcome:** The controller installs and operates from Home Assistant OS.

**Current status:** Packaged in `inkboard/` with `repository.yaml` at the root.
In App mode the controller reads App options, generates and persists a device
token, calls Home Assistant through the Supervisor Core API proxy
(`homeassistant_api`, no long-lived token), serves the admin UI only to the
Supervisor ingress proxy, and serves devices on a separate port (8100) that
exposes only device and health endpoints. Entities are discovered for the
editor. Images for amd64 and aarch64 are built by GitHub Actions. Verified
locally with a simulated Supervisor; installation on Home Assistant OS awaits
the first published image. Chromium isolation applies once page capture
(Milestone 6) exists.

Work:

- Add Home Assistant App metadata, build definitions, persistent storage, and
  supported architectures.
- Enable ingress for administration and expose a configurable device API port.
- Restrict the ingress listener to Supervisor traffic.
- Call Home Assistant through the Supervisor Core API proxy.
- Discover calendar, sensor, weather, and `todo.*` entities.
- Add App options, translations, logs, documentation, backup behavior, and
  security profile.
- Ensure Chromium runs without host networking, Docker socket, or broad host
  filesystem access.

Exit criteria:

- Installation, update, restart, backup, and restore preserve configuration and
  artifacts.
- The UI works under the dynamic ingress base path.
- A LAN device can reach the fixed device endpoint but cannot reach admin APIs.
- No Home Assistant long-lived access token is required.

### Milestone 4: screen and playlist management

**Outcome:** An administrator can create, preview, assign, and schedule screens.

**Current status:** All content screens use the same editable widget instances,
including migrated Calendar and To Do screens. Each instance owns its settings
and source selections; connections and cached data remain shared. The test
pattern is a diagnostic fallback. Screens are built in the admin UI from
heading, text, date/time, Home Assistant entity value, calendar agenda, month
calendar, To Do list, and divider widgets, with a live pixel-exact preview.
Rarely changed settings are collapsed by default. Devices keep a persisted
current screen, navigate with KEY1/KEY3 or Home Assistant buttons, and can
follow an ordered rotation with a configurable interval. Time-of-day schedule
rules (weekday and time windows, ordered by priority) override rotation, and
nightly quiet hours freeze the display while the device sleeps through them.
The controller returns the next boundary to the device so it wakes when a
change is due. Unchanged custom screens reuse their artifact. Widgets are
self-contained plugins in `apps/controller/src/widgets/<type>/`, discovered at
startup, validated by their own schemas, isolated on failure, and edited
through forms generated from those schemas (see `docs/widgets.md`). The
free-form grid layout remains.

Work:

- Implement device, screen, schedule, and artifact administration APIs.
- Add static message, date/time, divider, and Home Assistant entity widgets.
- Implement the 8-pixel grid layout and server-side widget rendering.
- Build screen list, editor, preview, device assignment, and manual publish UI.
- Add playlist ordering, weekday/time windows, priority, refresh interval, and
  quiet hours.
- Implement the database-backed render queue and content-key invalidation.

Exit criteria:

- A user can create a screen without editing files or YAML.
- Preview pixels match the published device image.
- Schedule resolution is deterministic across time zones and DST boundaries.
- An unchanged source/configuration does not create a new artifact.

### Milestone 5: Home Assistant calendar

**Outcome:** A useful agenda screen is driven by Home Assistant.

**Current status:** Implemented in the portable controller: calendars are
discovered from Home Assistant and selected in the admin UI (up to 10), fetched
over a bounded window, merged in time order with duplicates removed, and
labelled with their source calendar. Multi-day and in-progress events show
their end. Each calendar's normalized events are persisted separately from the
rendered artifact, so a partial or full outage, including across restarts,
keeps the last good agenda and names the failing calendar; recovery is
automatic. Identical pixels reuse the existing artifact. Fetching through the
Supervisor API and App options arrive with Milestone 3.

Work:

- Discover and select `calendar.*` entities.
- Fetch bounded event windows through the Supervisor API.
- Normalize timed/all-day events and time zones.
- Implement merged calendar sorting, limits, empty/error states, and source
  freshness.
- Cache normalized snapshots separately from rendered artifacts.
- Trigger renders only when the normalized content revision changes.

Exit criteria:

- Multiple calendars render in correct chronological order.
- All-day and multi-day events render correctly.
- A Home Assistant outage retains the last good agenda.
- Recovery updates the screen without manual repair.

### Milestone 6: local-page capture

**Outcome:** An allowlisted LAN page can become an e-paper screen safely.

Work:

- Add source configuration for URL, viewport, selector, fit mode, load timeout,
  and optional post-load delay.
- Validate hostnames, resolved addresses, and every redirect.
- Block file URLs, metadata endpoints, downloads, popups, camera, microphone,
  geolocation, and unapproved network destinations.
- Isolate browser contexts and cap CPU, memory, response size, and execution
  time.
- Add capture preview, diagnostics, and last-good fallback.

Exit criteria:

- A representative local dashboard renders predictably.
- Disallowed destinations and redirect escapes are rejected.
- A hung or oversized page cannot block the render worker indefinitely.
- Failed captures do not replace the displayed screen.

### Milestone 7: Microsoft To Do

**Outcome:** Selected Microsoft To Do lists render as read-only widgets.

**Current status:** Implemented with direct Microsoft Graph access. The user
registers a public-client Entra app; sign-in uses the device-code flow from the
admin page with `Tasks.Read`. Tokens are stored AES-256-GCM encrypted with
`INKBOARD_SECRET_KEY` or a generated `secret.key` (no MSAL cache), refreshed
before expiry and once on a Graph 401. Lists are selectable (default list
preselected); incomplete tasks are merged and ordered by due date, importance,
and creation time. Per-list snapshots survive outages and restarts; a revoked
grant enters `reauth_required` while keeping cached tasks. Sign-out deletes
tokens and snapshots, not screens. The To Do screen uses the same widget
renderer and editor as any other content screen. Every To Do widget selects
its own lists and display options, with no page-wide fallback; sign-in remains
shared under Connections. Delta sync is not implemented.

Work:

- Register/document the Microsoft public-client application model.
- Use delegated device-code authorization to avoid relying on ingress callback
  URLs.
- Store the MSAL token cache encrypted with a deployment key.
- Discover lists and retrieve tasks through Microsoft Graph.
- Normalize due date, importance, completion, recurrence summary, and ordering.
- Add list selection, item limits, completed-item filtering, connector health,
  reauthorization, and explicit sign-out.
- Implement delta synchronization if normal polling becomes wasteful.

Exit criteria:

- Authorization works from the Home Assistant UI without exposing tokens.
- Selected incomplete tasks render with stable ordering.
- Expired/revoked authorization enters an actionable reauthorization state.
- Graph outages retain cached task data within the configured stale window.

### Milestone 8: native TRMNL compatibility

**Outcome:** The controller also supports the upstream TRMNL firmware build for
the Seeed DIY kit without changing core rendering or scheduling.

Work:

- Implement compatible `GET /api/setup`, `GET /api/display`, `POST /api/log`,
  and immutable image delivery.
- Test the official `TRMNL_7inch5_OG_DIY_Kit` firmware environment, model
  `xiao_epaper_display`, using firmware 1.5.12 or newer.
- Validate filename caching, refresh instructions, battery/RSSI headers, and
  KEY3 single/double/long-press behavior.
- Document BYOS endpoint provisioning and explicitly disable incompatible
  upstream OTA updates.

Exit criteria:

- A native-firmware device pairs and displays the same artifact as ESPHome.
- An unchanged filename does not redownload or rewrite the image.
- KEY3 refresh and network reconfiguration remain functional.
- Server responses cannot trigger an incompatible firmware OTA.

### Milestone 9: release hardening

**Outcome:** The first release is supportable and recoverable.

Work:

- Add import/export, backup validation, retention limits, and storage monitoring.
- Add audit events for pairing, token changes, connector authorization, and
  publishing.
- Add battery/RSSI history and stale-device alerts.
- Run dependency, container, API authorization, and SSRF security reviews.
- Add upgrade/migration tests and rollback documentation.
- Publish versioned Docker and Home Assistant App releases.

Exit criteria:

- All product acceptance criteria pass.
- Upgrade from the previous release preserves data.
- Backup/restore is exercised on a clean Home Assistant installation.
- No critical/high security findings remain open.

## 6. Initial database model

Create these tables through migrations:

| Table               | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `devices`           | Device identity, token hash, profile, interval, status, assignment |
| `device_check_ins`  | Bounded telemetry and display outcomes                             |
| `screens`           | Screen kind, configuration, revision, render settings              |
| `widgets`           | Widget kind, grid position, binding, options                       |
| `schedules`         | Device/screen time windows, order, and priority                    |
| `connectors`        | Connector kind, public configuration, status                       |
| `connector_secrets` | Encrypted secret payload and key version                           |
| `source_snapshots`  | Normalized cached data, revision, freshness                        |
| `render_jobs`       | Idempotent work queue, attempts, lease, outcome                    |
| `artifacts`         | Immutable file metadata, checksum, content key                     |
| `audit_events`      | Security and administration events                                 |

Use UTC instants in storage and explicit IANA time zones in schedule
configuration.

## 7. API slices

### Native device compatibility

```text
GET  /api/setup
GET  /api/display
POST /api/log
GET  /images/:artifactId.bmp
```

Match the TRMNL header and response conventions closely enough that upstream
firmware can be used without a long-lived fork.

### Direct device API

```text
GET  /api/v1/devices/:deviceId/image
POST /api/v1/devices/:deviceId/check-ins
```

### Administration API

```text
/api/v1/admin/devices
/api/v1/admin/screens
/api/v1/admin/widgets
/api/v1/admin/schedules
/api/v1/admin/connectors
/api/v1/admin/artifacts
```

Generate OpenAPI from route schemas, but do not expose the administration
document on the device listener.

## 8. Cross-cutting engineering rules

- Publish only validated artifacts and always preserve the last good screen.
- Treat every external response as untrusted and bounded.
- Make jobs idempotent and lease-based so restart recovery is safe.
- Hash device tokens; encrypt recoverable connector secrets.
- Never log credentials, cookies, OAuth payloads, or full private page content.
- Separate normalized source data from widget presentation.
- Use content revisions, not wall-clock polling, to decide whether to render.
- Test time-zone behavior with fixed clocks.
- Keep the firmware protocol adapter separate from core screen selection.

## 9. First implementation sprint

Complete Milestone 0 and the smallest part of Milestone 1:

1. scaffold the workspace, controller, web UI, shared contracts, and tests;
2. add configuration, logging, health endpoints, SQLite, and migrations;
3. build and run the Docker image;
4. render the orientation test page to an 800x480 raster;
5. encode and validate the first 1-bit BMP;
6. expose the BMP through a temporary development route; and
7. add golden tests proving deterministic output.

The sprint is complete only when a generated artifact can be opened as a valid
800x480 monochrome BMP and a fresh container can reproduce the same checksum.
