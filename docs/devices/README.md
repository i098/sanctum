# Set up a Sanctum hardware listener

A device needs network access, a microphone, and a visible light or screen.
Use the website on a device that can run a modern browser.
Keep that browser tab open and the device awake while it listens.
Use the Rust listener on Linux without a browser microphone or installed Node.js.
Use the [device protocol](protocol.md) to build a client for other hardware.

## Build on a Raspberry Pi

Use a current 64-bit Raspberry Pi OS and connect a supported USB or I²S microphone.
Install the ALSA utilities package, then use `arecord -l` to find your microphone.
Build with Rust 1.97.1 or a later compatible toolchain:

```sh
cargo build --release --locked --manifest-path devices/Cargo.toml
```

Run `devices/target/release/sanctum-listener` from a terminal.
Replace the example server with your Sanctum HTTPS origin.
For a terminal that stays visible, use:

```sh
devices/target/release/sanctum-listener \
  --server https://sanctum.example.com --state-dir "$HOME/.local/state/sanctum-listener" \
  --name 'Meeting room' --input alsa:default --light term --screen none
```

Tell people in the room that the device records before you pair it.
Sign in at `https://sanctum.example.com/pair`, enter the code, and approve the named device.
The light blinks each digit in order, with ten blinks for zero.
A light-only device cannot show the address. Put it on the device label.
A steady light or a screen that shows `listening` means that the device records.
It also records during `reconnecting` and `degraded`.

Use `--input alsa:<device>` to select another ALSA input.
For an input driver that does not use ALSA, supply `--input cmd:<command>`. The command must write mono PCM16 LE at 16 kHz.
Use `--input file:<wav>` for a synthetic fixture at the same format and rate.
The binary does not accept a configuration that has no visible indicator.

## Use an LED

Wire an LED with a series resistor sized for the LED and GPIO voltage and current limits.
Do not connect the LED directly across power or to a GPIO pin without current limiting.
Configure the board so the kernel exposes the LED under `/sys/class/leds/`.
Grant the listener user access to that LED's `brightness` and `trigger` files, not to all of `/sys`.
Use `--light sysfs:<led-name> --screen none`.
Add `:pwm` only when that LED supports variable brightness.
If the microphone hardware supports it, use a recording light powered by the microphone supply rail.

## Use a small screen

Build the kiosk assets on a development machine:

```sh
npm ci
npm run build:kiosk -w web-app
```

Copy `web-app/dist/kiosk/` to the screen device.
Use `--light none --screen kiosk:/path/to/kiosk` and open `http://127.0.0.1:7171/` on its screen.
Disable display blanking and keep the kiosk page visible.
The page does not request the microphone or a sign-in.
Losing the kiosk connection stops recording.

## Run as a service

Install the binary at `/usr/local/bin/sanctum-listener` and copy the kiosk assets to `/usr/local/share/sanctum-kiosk/`.
Create a local service user named `sanctum-listener` and give it access to the selected audio input.
Copy the [systemd example](../../deploy/device/sanctum-listener.service) to `/etc/systemd/system/` and set its origin, name, input, and outputs.
Open the kiosk in the device's desktop session if the service uses `--screen kiosk:…`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sanctum-listener.service
```

Send `SIGUSR1` to pause or resume.
Use `systemctl stop sanctum-listener.service` to close capture and give the client time to upload buffered audio.
Revoke a lost device in Menu → Settings → Devices in the website.
Keep the service state directory private. It holds the credential and unwritten audio until the server confirms storage.
