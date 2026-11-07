# Inkboard

Inkboard renders calendar, To Do, and Home Assistant widgets into 800×480 black-and-white
images for the Seeed TRMNL 7.5-inch (OG) DIY Kit running the Inkboard ESPHome
firmware.

## How it works

- **Inkboard page** (sidebar): build screens, configure each widget instance, and set rotation,
  schedules, and quiet hours. It is served through Home Assistant ingress, so
  only signed-in Home Assistant users can open it.
- **Device port 8100**: the display downloads images and reports its status
  here. This port serves only device endpoints and requires the device token.
- **Home Assistant data**: calendars and entity values are read through the
  Supervisor. No long-lived access token is needed.
- **Widgets**: all content screens use the same self-contained plugins. The
  controller stores each instance's settings, loads its selected data, and renders
  the image. The firmware never needs calendar, To Do, or widget configuration.
- **Display updates**: the device initiates image requests and status check-ins
  over Wi-Fi. Inkboard does not push to a sleeping device. Check-in responses
  tell it when to wake next; its e-paper panel keeps the image while asleep.

See the [architecture diagram in the repository README](https://github.com/ramiroidl/inkboard#how-the-app-works)
for the complete data flow and standalone Docker alternative.

## Installation

1. In Home Assistant, go to **Settings → Apps → App store** (**Add-ons →
   Add-on store** in older versions), open the **⋮** menu, choose
   **Repositories**, and add `https://github.com/ramiroidl/inkboard`.
2. Install **Inkboard**, then start it. Turn on **Show in sidebar**.
3. Open **Inkboard** from the sidebar.

If the GitHub repository or its container images are private, Home Assistant
needs credentials:

- Add the repository as `https://<user>:<token>@github.com/ramiroidl/inkboard`,
  using a GitHub personal access token with read access to the repository.
- Under **Settings → Add-ons → Add-on store → ⋮ → Registries**, add `ghcr.io`
  with your GitHub user name and a token that has the `read:packages` scope.

Making the repository and the `amd64-addon-inkboard` / `aarch64-addon-inkboard` packages
public avoids both steps.

## Connect the display

Expand **Connections** on the Inkboard page. **Display setup** shows the two values the
firmware needs. Put them in the firmware's `secrets.yaml`:

```yaml
inkboard_controller_url: "http://<home-assistant-ip>:8100"
inkboard_device_api_token: "<token shown on the Inkboard page>"
```

Use your Home Assistant host's LAN IP address; the display may not resolve
`homeassistant.local`. Then install the firmware with ESPHome Device Builder,
first over USB and later over Wi-Fi. Do not use the sidebar's ingress URL as
the firmware's controller URL: the display uses the separate LAN device port.
The repository README at
<https://github.com/ramiroidl/inkboard> walks through every step.

## Options

| Option                          | Description                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| Device token                    | Token the display sends. Leave empty to generate one (recommended). |
| Time zone                       | IANA time zone. Empty uses Home Assistant's time zone.              |
| Calendar look-ahead (days)      | Days of upcoming events to fetch (1–31).                            |
| Data refresh interval (seconds) | How often Home Assistant data is fetched (60–3,600).                |
| Microsoft app (client) ID       | Optional default for Microsoft To Do; also settable on the page.    |
| Microsoft tenant                | `common`, `consumers`, `organizations`, or a tenant ID.             |
| Log level                       | Detail written to the App log.                                      |

To show Microsoft To Do tasks, register an app in Microsoft Entra with personal
accounts and **Allow public client flows** enabled, then enter its client ID
and select **Sign in with Microsoft** under **Connections**. See the repository
README for the steps.

To change the device port, edit the port under the App's **Network** section and
update `inkboard_controller_url` in the firmware.

## Screens and widget settings

Select **New screen**, add widgets, and configure each instance next to its live
preview. In **Calendar agenda** and **Month calendar**, tick the calendars for
that instance. In **To Do list**, tick its lists and choose task count, due-date,
and list-name options. Another widget, even on the same screen, has independent
settings. Leaving every source unticked shows no events or tasks.

Connections and sign-ins are shared, but calendar and list selections are not.
There are no fixed-layout content screens to customize first: use **Edit** on
any content screen. Existing Calendar and To Do screens migrate automatically,
including selections that previously came from page-wide settings. Rotation,
schedules, and display assignments are preserved. Deleting a migrated screen
does not recreate it.

Infrequently changed settings are collapsed by default: **Connections**,
**Automatic rotation**, **Schedules**, **Quiet hours**, **Backup and restore**,
and each display's **Device details and display settings**. The current-screen
selector remains visible. Expand **Display diagnostics** below the screen list
to hide the test pattern; it remains a fallback if no other screen exists.

### Japanese Study

Add **Japanese Study** alone on a screen for full-screen vocabulary and beginner
grammar. Choose N5 starter or travel vocabulary, one to three words, optional
romaji, and a beginner grammar proficiency/focus. The curated packs are not
official or exhaustive JLPT lists. Lessons start with **ます**, and advance daily
or hourly for vocabulary and daily or weekly for grammar from the instance's
course start date. Refreshes do not advance the course.

Import a UTF-8 CSV under **Uploaded words**, preview it, and select **Import**.
Required columns: `word,reading,translation`. Optional columns: `level`, `romaji`,
`example`, `example_reading`, `example_translation`, and `tags`. Files are limited
to 128 KiB and 200 words. Choose **Uploaded CSV** or **Bundled and uploaded words**
and save the screen. Imported words stay with the widget and are included in
portable backups. No account or firmware changes are required.

## Data and backups

Screens, settings, the generated device token, saved calendar events, cached
To Do tasks, the encrypted Microsoft sign-in with its key (`secret.key`), and
rendered images are stored in the App's data folder. Home Assistant backups
include them. Backups stop the App briefly so the database is copied in a
consistent state.

For portable screen settings, expand **Backup and restore** on the Inkboard
page. **Export** includes each widget's settings, rotation, schedules, quiet
hours, and test-pattern visibility, but no credentials or sign-ins. The App exports
version 2 files and also accepts version 1 imports, converting inherited
selections into per-instance settings. Connect the sources separately after importing.

## Moving from the standalone Docker container

The App starts with empty settings. To keep your display working without
reflashing, set the **Device token** option to the token your firmware already
uses, then change only `inkboard_controller_url` in the firmware to the App's
device port. Expand **Backup and restore** on the old controller and select
**Export**, then **Import** the file on the new one. That brings over your
screens with their widget settings, rotation, schedules, quiet hours, and
test-pattern visibility. Sign in to Microsoft To Do under **Connections** if
you use it; sign-ins are not part of this export.
