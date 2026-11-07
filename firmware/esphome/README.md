# Seeed TRMNL 7.5-inch ESPHome firmware

This configuration is the first Inkboard hardware vertical slice for the Seeed
EE04 board with a XIAO ESP32-S3 Plus. It downloads the controller's current
800x480 monochrome BMP, refreshes the panel only after a changed HTTP response,
reports battery, Wi-Fi, wake, button, and display status to the controller,
exposes all three keys to Home Assistant, and supports encrypted ESPHome API and
OTA connections. Optional 15-minute deep sleep uses all three keys as wake
sources.

Maintenance mode defaults to on so the device remains reachable during setup
and OTA updates. KEY1 and KEY3 switch to the previous and next controller
screen.

## Install

Follow the [installation guide](../../README.md#2-assemble-the-display) to
assemble the display, add the secrets, and install the firmware with ESPHome
Device Builder. The secrets this configuration needs are listed in
[`secrets.example.yaml`](secrets.example.yaml):

| Secret                        | Value                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `wifi_ssid`, `wifi_password`  | Your 2.4 GHz Wi-Fi network                                                                                                 |
| `inkboard_api_encryption_key` | A random 32-byte base64 key (`openssl rand -base64 32`)                                                                    |
| `inkboard_fallback_password`  | At least eight characters, for the setup hotspot                                                                           |
| `inkboard_controller_url`     | `http://<home-assistant-ip>:8100`, or `http://<computer-ip>:8099` when running [without the App](../../docs/standalone.md) |
| `inkboard_device_api_token`   | The token on the Inkboard page's **Display setup** card                                                                    |

Never use `localhost` in `inkboard_controller_url`; on the display it refers to
the display itself. Do not commit `secrets.yaml`; it is listed in
`.gitignore`.

The device token is compiled into the firmware. If you change it, install the
firmware again.

To check the controller from another computer on the network, request the
current image with the token; it must return `200 OK` and 48,062 bytes:

```powershell
$headers = @{ Authorization = "Bearer <device-token>" }
Invoke-WebRequest http://<home-assistant-ip>:8100/api/v1/device/image.bmp `
  -Headers $headers -OutFile current.bmp
(Get-Item current.bmp).Length
```

`401 Unauthorized` means the token does not match.

After the first boot, the ESPHome logs show the Wi-Fi connection, a battery
sample, an image download, one full e-paper refresh, and a device check-in. The
first image is the test pattern: a white background with a black square at the
top left, an outlined circle at the top right, a triangle at the bottom left,
nested rectangles at the bottom right, and readable text in the center. If an
build shows reversed colors, press **Inkboard OG Force Redraw** once. If that does
not help, tick **Invert colors** on the display's card on the Inkboard page.

## Device status and buttons

The administration page shows the latest check-in, including firmware version,
battery voltage, Wi-Fi RSSI, wake reason, and display result. The controller
keeps the latest state and check-in history in the persistent `/data` database.

- **KEY1** shows the previous screen.
- **KEY2** samples the battery, reports `refresh`, and checks for a newer image.
- **KEY3** shows the next screen.

Every key first reports the press to the controller and then downloads the
resulting image. For KEY1 and KEY3 the controller changes the device's current
screen; screens wrap around. A key press also lets the next image through during
quiet hours. Pressing a key while the device sleeps wakes it and does the same.
Home Assistant also exposes **Previous Screen**, **Next Screen**, and **Refresh
Display** buttons. The admin page can select a screen directly; the device shows
it on its next refresh or button press.

The battery input is measured only while GPIO6 enables the board's divider. The
reported voltage applies the EE04 board's 2:1 divider correction; compare it
with a multimeter before relying on it for precise battery-percentage estimates.

## Maintenance mode and deep sleep

**Inkboard OG Maintenance Mode** is on by default and prevents deep sleep. Keep
it on while developing or installing OTA updates. While it is on, the display
checks the controller every 15 minutes so rotating screens and clocks stay
current.

When maintenance mode is switched off, the device finishes its current request,
waits briefly, powers down the display interface, and sleeps. Each check-in
response tells it how long: until the controller's next scheduled change, at
most 15 minutes, or until quiet hours end (up to 12 hours). If a check-in fails,
it sleeps for 15 minutes. It wakes from the timer or from KEY1, KEY2, or KEY3,
records the wake reason, refreshes/checks in, and returns to sleep. A
two-minute awake-time guard prevents a failed network request from draining the
battery indefinitely.

To recover OTA access while sleep is enabled, press any key and begin the
wireless installation while the device is awake. If that window is too short,
use the BOOT/RESET USB recovery procedure.

## Install later updates over Wi-Fi

Keep the device powered and online. In ESPHome Device Builder, select **Install**
and then **Wirelessly**. The OTA transfer is encrypted with the same key as the
ESPHome native API.

If an OTA build prevents normal startup, ESPHome safe mode should accept another
OTA upload. If it does not, repeat the BOOT/RESET USB recovery procedure and
install a factory binary.
