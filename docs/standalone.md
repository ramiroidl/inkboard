# Run Inkboard without the Home Assistant App

Use this guide when Home Assistant runs as Container or Core (which cannot
install Apps), or to run Inkboard on another computer. The controller runs in
Docker and reaches Home Assistant with a long-lived access token. Everything
else, including the firmware, works the same as in the
[main installation guide](../README.md).

## Install Docker

On Linux, install [Docker Engine](https://docs.docker.com/engine/install/). On
Windows, confirm WSL 2 is available, then install Docker Desktop:

```powershell
wsl --status
winget install --id Docker.DockerDesktop --exact `
  --accept-package-agreements --accept-source-agreements
```

If WSL is not installed, run `wsl --install` from an administrator terminal and
restart Windows. Start Docker Desktop and wait for its engine to report that it
is running.

## Configure

Copy `.env.example` to `.env`. `.env` is ignored by Git; never commit it.

```dotenv
INKBOARD_DEVICE_API_TOKEN=replace-with-at-least-32-random-characters
INKBOARD_HOME_ASSISTANT_URL=http://homeassistant.local:8123
INKBOARD_HOME_ASSISTANT_TOKEN=replace-with-a-home-assistant-long-lived-access-token
INKBOARD_TIME_ZONE=America/Chicago
INKBOARD_CALENDAR_LOOK_AHEAD_DAYS=7
INKBOARD_CALENDAR_REFRESH_SECONDS=300
```

- Generate the device token with `openssl rand -hex 32`, or in PowerShell:

  ```powershell
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToHexString($bytes).ToLowerInvariant()
  ```

- Create the Home Assistant token under your Home Assistant user profile →
  **Security** → **Long-lived access tokens**. The URL and token must be set
  together.
- The time zone must be an IANA name such as `America/Mexico_City`.
- Look-ahead days can be 1–31 and refresh intervals 60–3,600 seconds.

Optional settings:

| Variable                           | Purpose                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `INKBOARD_HOME_ASSISTANT_CALENDAR` | Starting calendar selection, such as `calendar.family,calendar.work` |
| `INKBOARD_MICROSOFT_CLIENT_ID`     | Microsoft To Do app registration; it can also be entered on the page |
| `INKBOARD_MICROSOFT_TENANT`        | `common` (default), `consumers`, `organizations`, or a tenant ID     |
| `INKBOARD_TODO_REFRESH_SECONDS`    | How often To Do tasks are fetched (60–3,600, default 300)            |
| `INKBOARD_SECRET_KEY`              | 32-byte key (hex or base64) for saved sign-ins; generated when unset |

## Run

Build the image and start it with a named volume so the database survives
container replacement:

```powershell
docker build -f docker/Dockerfile --target standalone -t inkboard-controller:local .
docker run --detach --name inkboard-controller `
  --publish 8099:8099 `
  --volume inkboard-data:/data `
  --env-file .env `
  --restart unless-stopped `
  inkboard-controller:local
```

Open `http://<computer-ip>:8099`. In standalone mode the admin page and the
device endpoints share port 8099, and the admin page has no sign-in, so do not
expose the port outside your home network. Allow inbound TCP 8099 in the
computer's firewall so the display can reach it.

In the firmware secrets, use:

```yaml
inkboard_controller_url: "http://<computer-ip>:8099"
inkboard_device_api_token: "<INKBOARD_DEVICE_API_TOKEN from .env>"
```

Verify the controller:

```powershell
Invoke-RestMethod http://localhost:8099/health/ready
docker inspect --format "{{.State.Health.Status}}" inkboard-controller
docker logs inkboard-controller
```

To update, pull the new source, rebuild the image, and recreate the container
with the same command. Removing the container keeps the `inkboard-data`
volume; delete it with `docker volume rm inkboard-data` only when you no longer
need the saved screens and settings.

A `401` from `/api/v1/device/image.bmp` means the display's token does not
match `INKBOARD_DEVICE_API_TOKEN`.

## Move to the Home Assistant App later

The App starts with empty settings. To keep the display working without
reflashing, set the App's **Device token** option to the token the firmware
already uses, then change only `inkboard_controller_url` to the App's device
port (8100) and install the firmware over Wi-Fi. Use **Export** in the old
controller's **Backup** card and **Import** on the new Inkboard page to bring
over your screens, rotation, schedules, quiet hours, and selections.
