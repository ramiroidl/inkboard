# Inkboard

Inkboard renders calendars and Home Assistant data into 800×480 black-and-white
images for the Seeed TRMNL 7.5-inch (OG) DIY Kit running the Inkboard ESPHome
firmware.

## How it works

- **Inkboard page** (sidebar): build screens, choose calendars, and set rotation,
  schedules, and quiet hours. It is served through Home Assistant ingress, so
  only signed-in Home Assistant users can open it.
- **Device port 8100**: the display downloads images and reports its status
  here. This port serves only device endpoints and requires the device token.
- **Home Assistant data**: calendars and entity values are read through the
  Supervisor. No long-lived access token is needed.

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

The **Display setup** card on the Inkboard page shows the two values the
firmware needs. Put them in the firmware's `secrets.yaml`:

```yaml
inkboard_controller_url: "http://<home-assistant-ip>:8100"
inkboard_device_api_token: "<token shown on the Inkboard page>"
```

Use your Home Assistant host's LAN IP address; the display may not resolve
`homeassistant.local`. Then install the firmware with ESPHome Device Builder,
first over USB and later over Wi-Fi. The repository README at
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
and select **Sign in with Microsoft** on the Inkboard page. See the repository
README for the steps. Add **Calendar** and **To Do** to **Automatic rotation**
to switch between them.

To change the device port, edit the port under the App's **Network** section and
update `inkboard_controller_url` in the firmware.

## Data and backups

Screens, settings, the generated device token, saved calendar events, cached
To Do tasks, the encrypted Microsoft sign-in with its key (`secret.key`), and
rendered images are stored in the App's data folder. Home Assistant backups
include them. Backups stop the App briefly so the database is copied in a
consistent state.

## Moving from the standalone Docker container

The App starts with empty settings. To keep your display working without
reflashing, set the **Device token** option to the token your firmware already
uses, then change only `inkboard_controller_url` in the firmware to the App's
device port. Recreate your screens and calendar selection on the Inkboard page.
