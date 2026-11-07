# Develop Inkboard

## Repository layout

| Path                    | Contents                                                |
| ----------------------- | ------------------------------------------------------- |
| `apps/controller`       | Node.js controller: API, rendering, connectors, widgets |
| `apps/web`              | React admin page                                        |
| `packages/contracts`    | Types shared by the controller and the admin page       |
| `packages/epaper-image` | 1-bit BMP encoder                                       |
| `firmware/esphome`      | ESPHome firmware for the display                        |
| `inkboard`              | Home Assistant App metadata, options, and documentation |
| `docker/Dockerfile`     | `standalone` and `homeassistant` image targets          |
| `docs`                  | Product spec, system design, plan, and widget guide     |

## Run from source

Use Node.js 24.22.1 and npm 11.19.1. The repository includes `.nvmrc` and
`.node-version` files for Node version managers.

```powershell
npm ci
npm run build
npm start
```

Run `npm run dev` after the first build to restart the controller when backend
files change. It listens on `127.0.0.1:8099` and stores data in `.inkboard/`.
Set `INKBOARD_HOST=0.0.0.0` to let a display on the network reach it. Copy
`.env.example` to `.env` for Home Assistant and other settings; see
[standalone.md](standalone.md).

## Test

```powershell
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

Run `typecheck` before `lint` on a fresh clone: it builds the shared packages that
lint's type-aware rules read. Tests mock Home Assistant and Microsoft, so they need no accounts or network.
The orientation image must be exactly 48,062 bytes; with
`INKBOARD_ENABLE_DEVELOPMENT_ROUTES=true`, it is served at
`/api/v1/development/orientation.bmp` and its SHA-256 checksum stays identical
across restarts.

## Try App mode locally

Build the App target and simulate the Supervisor with a long-lived token:

```powershell
docker build -f docker/Dockerfile --target homeassistant -t inkboard-app:local .
docker run --rm -p 18099:8099 -p 18100:8100 -v inkboard-app-data:/data `
  -e SUPERVISOR_TOKEN=<long-lived-token> `
  -e INKBOARD_SUPERVISOR_URL=http://homeassistant.local:8123 `
  -e INKBOARD_ADMIN_ALLOWED_ADDRESSES=172.17.0.1 `
  inkboard-app:local
```

`INKBOARD_ADMIN_ALLOWED_ADDRESSES` stands in for the Supervisor's ingress proxy
(172.30.32.2), the only address allowed to reach the admin page in a real App.

## Release the App

The `Home Assistant App image` workflow builds
`ghcr.io/ramiroidl/amd64-addon-inkboard` and `aarch64-addon-inkboard` on
pushes to `main` that change the App, and tags them with the version in
`inkboard/config.yaml`. To publish an update:

1. Raise `version` in `inkboard/config.yaml` and add an entry to
   `inkboard/CHANGELOG.md`.
2. Merge to `main` and wait for the workflow to finish.
3. Home Assistant offers the update on the next store refresh.

The container packages must be public, or every Home Assistant that installs
the App needs registry credentials. After the first workflow run, open each
package under **GitHub → Packages → Package settings** and set its visibility
to **Public**.

## Write widgets

Widgets are plugins under `apps/controller/src/widgets/<type>/`. See
[widgets.md](widgets.md).

## Endpoints

- `GET /health/live`, `GET /health/ready`
- `GET /api/v1/admin/status`
- `GET /api/v1/admin/devices`, `PUT /api/v1/admin/devices/:deviceId/screen`,
  `PUT /api/v1/admin/devices/:deviceId/display`
- `GET /api/v1/admin/widgets`
- `GET /api/v1/admin/entities?domain=sensor`
- `GET|POST /api/v1/admin/screens`, `GET|PUT|DELETE /api/v1/admin/screens/:screenId`
- `GET /api/v1/admin/screens/:screenId/preview.bmp`, `POST /api/v1/admin/screens/preview.bmp`
- `PUT /api/v1/admin/rotation`, `PUT /api/v1/admin/schedules`, `PUT /api/v1/admin/quiet-hours`
- `PUT /api/v1/admin/test-pattern`
- `GET|PUT /api/v1/admin/calendars`
- `GET /api/v1/admin/microsoft-todo`, `PUT .../settings`, `POST|DELETE .../sign-in`,
  `POST .../sign-out`, `GET|PUT .../lists`
- `GET /api/v1/device/image.bmp` and `POST /api/v1/device/check-in` (device
  token required)
- `GET|POST /api/v1/admin/backup` (export and import screens and settings)
- `GET /api/v1/development/orientation.bmp` (development only)

In the App, admin endpoints are served only through ingress; port 8100 serves
only `/health` and `/api/v1/device`.
