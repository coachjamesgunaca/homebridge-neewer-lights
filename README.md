# homebridge-neewer-lights

Homebridge platform plugin that exposes Neewer Bluetooth LE lights to Apple Home (iOS and macOS). The plugin talks to the lights **directly over Bluetooth LE** — no companion app required — by reimplementing Neewer's BLE protocol.

Confirmed working with the **Neewer RGB660 PRO**. Other classic-protocol Neewer RGB panels (RGB530/480, RGB176, CB60 RGB, etc.) use the same command set and should work too.

Each configured light appears in Apple Home as a lightbulb with:

- on/off
- brightness
- color temperature (per-model kelvin range)
- hue + saturation (RGB models)

The plugin is split into a HomeKit side and a hardware transport, mirroring `homebridge-amaran-lights`:

- a `ble` transport that scans, connects, and writes to the lights directly (default)
- a `mock` transport for setup/testing with no hardware

## How it works

Neewer "classic" lights expose a single GATT service with a write-without-response control characteristic:

| Role | UUID |
| --- | --- |
| Service | `69400001-B5A3-F393-E0A9-E50E24DCCA99` |
| Control (write) | `69400002-B5A3-F393-E0A9-E50E24DCCA99` |
| Notify | `69400003-B5A3-F393-E0A9-E50E24DCCA99` |

Every command frame is `[0x78][tag][length][...payload][checksum]`, where the checksum is the sum of all preceding bytes modulo 256:

- Power: fixed frames `78 81 01 01 FB` (on) / `78 81 01 02 FC` (off)
- Color temperature (tag `0x87`): `[brightness 0-100][kelvin/100]`
- Hue/Saturation (tag `0x86`): `[hue LE uint16][saturation 0-100][brightness 0-100]`

Derived from [NeewerLite](https://github.com/keefo/NeewerLite) (`Model/NeewerLightConstant.swift`, `Model/NeewerLight.swift`).

## Requirements

- **macOS** host with Bluetooth (this build targets a Mac).
- Node 18+.
- Homebridge must run **in your user login session**, not as a root daemon — see the Bluetooth permission section below. This is the single biggest gotcha on macOS.

`@abandonware/noble` builds a native module on install; if it fails, install Xcode command line tools with `xcode-select --install` and reinstall.

## Install

```bash
git clone https://github.com/coachjamesgunaca/homebridge-neewer-lights.git
cd homebridge-neewer-lights
npm install            # installs deps and builds dist/ via the prepare script
npm link               # exposes the plugin to Homebridge
```

> Do **not** run `npm` with `sudo` in this folder. It builds `dist/` as root and then ordinary rebuilds fail with permission errors. If that already happened: `sudo chown -R $(whoami) .`

## macOS Bluetooth permission (important)

Core Bluetooth only grants access to processes running inside your graphical login session. The Homebridge UI installs `hb-service` as a **root LaunchDaemon**, which runs outside that session — so it can never get Bluetooth permission and the log shows:

```
[ble] adapter state: unauthorized
```

The fix is to run Homebridge as a **user LaunchAgent** instead. Once it runs in your session, macOS shows the Bluetooth prompt (and the entry appears under System Settings → Privacy & Security → Bluetooth).

1. Remove the root daemon (keeps your `~/.homebridge` config):

   ```bash
   sudo hb-service uninstall
   ```

2. Create `~/Library/LaunchAgents/com.homebridge.server.plist` pointing at your install. Example (adjust paths and storage dir to yours):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
       <key>Label</key>
       <string>com.homebridge.server</string>
       <key>RunAtLoad</key>
       <true/>
       <key>KeepAlive</key>
       <true/>
       <key>ProgramArguments</key>
       <array>
           <string>/usr/local/bin/node</string>
           <string>/usr/local/lib/node_modules/homebridge-config-ui-x/dist/bin/hb-service.js</string>
           <string>run</string>
           <string>-I</string>
           <string>-U</string>
           <string>/Users/YOU/.homebridge</string>
       </array>
       <key>WorkingDirectory</key>
       <string>/Users/YOU/.homebridge</string>
       <key>StandardOutPath</key>
       <string>/Users/YOU/.homebridge/homebridge.log</string>
       <key>StandardErrorPath</key>
       <string>/Users/YOU/.homebridge/homebridge.log</string>
       <key>EnvironmentVariables</key>
       <dict>
           <key>PATH</key>
           <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
           <key>HOME</key>
           <string>/Users/YOU</string>
           <key>UIX_STORAGE_PATH</key>
           <string>/Users/YOU/.homebridge</string>
       </dict>
   </dict>
   </plist>
   ```

3. Load it and approve the Bluetooth prompt:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.homebridge.server.plist
   ```

To restart later (after a rebuild or config change), use:

```bash
launchctl kickstart -k gui/$(id -u)/com.homebridge.server
```

## Finding your lights

Run once with `"debug": true`. With the lights powered on and **not** connected to NeewerLite or the Neewer phone app (BLE lights only talk to one host at a time), the log lists every named Bluetooth device:

```
[ble] discovered [Neewer?] name="NEEWER-RGB660 PRO" id=3f5d7e2b156bc698f6bc49d4bebdd698
```

Copy the `name=` into `bleName`, and — if you have multiple identical lights — the `id=` into `bleId`. The `id` is a host-specific UUID assigned by macOS, stable per-Mac, and the only reliable way to tell two same-named panels apart. Use the `id` **exactly as printed in this log** (other apps format it differently).

## Configuration

```json
{
  "platforms": [
    {
      "platform": "NeewerLightsPlatform",
      "name": "Neewer Lights",
      "transport": "ble",
      "writeDebounceMs": 120,
      "keepAliveSeconds": 30,
      "debug": false,
      "lights": [
        {
          "name": "Key Light",
          "bleId": "3f5d7e2b156bc698f6bc49d4bebdd698",
          "rgb": true,
          "minKelvin": 3200,
          "maxKelvin": 5600
        },
        {
          "name": "Fill Light",
          "bleId": "daface11ead427459f07f126471683af",
          "rgb": true,
          "minKelvin": 3200,
          "maxKelvin": 5600
        }
      ]
    }
  ]
}
```

A light matches if **either** `bleId` matches exactly **or** `bleName` is a case-insensitive substring of the advertised name. For multiple identical panels, use `bleId` so each HomeKit tile always maps to the same fixture.

Mock mode (verify accessories appear with no hardware):

```json
{
  "platform": "NeewerLightsPlatform",
  "name": "Neewer Lights",
  "transport": "mock",
  "lights": [
    { "name": "Key Light", "bleName": "RGB660 PRO", "rgb": true }
  ]
}
```

### Options

| Field | Default | Notes |
| --- | --- | --- |
| `transport` | `ble` | `ble` for real lights, `mock` for testing. |
| `scanTimeoutSeconds` | `0` | `0` = keep scanning until every light is found. |
| `writeDebounceMs` | `120` | Coalesce rapid slider moves into one BLE write. |
| `keepAliveSeconds` | `30` | Re-scan interval to recover dropped lights. `0` disables. |
| `debug` | `false` | Logs adapter state, every named device discovered, characteristics, and frames sent. |

### Per-light fields

| Field | Default | Notes |
| --- | --- | --- |
| `name` | — | Required. Shown in Apple Home. |
| `bleName` | — | Case-insensitive substring of the advertised BLE name. |
| `bleId` | — | Exact peripheral id (macOS UUID) for disambiguation. |
| `rgb` | `true` | `false` hides hue/saturation for bi-color models. |
| `minKelvin` | `3200` | Lower bound of the model's CCT range. |
| `maxKelvin` | `5600` | Upper bound. Some models go higher (~8500K). |

## Behavior notes

- **State is optimistic.** HomeKit reflects the last command sent; Neewer's notify read-back is inconsistent across models, so the plugin re-asserts state on reconnect rather than depending on it.
- **CCT vs RGB.** Setting color temperature switches the light to CCT mode; setting hue/saturation switches it to RGB mode. Brightness applies to whichever mode is active.
- **Reconnection.** If a light drops, the plugin keeps scanning and reconnects automatically.
- **Non-Neewer devices.** If a connected device doesn't expose the Neewer service, the plugin logs its characteristics and falls back to a writable one. Bluetooth **Mesh** bulbs (characteristics `2adb`–`2ade`) are a different, encrypted protocol and are *not* supported.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `adapter state: unauthorized` | Running as a root daemon. Switch to a user LaunchAgent (above). |
| Scans but never discovers your light | Light is off, out of range, or held by NeewerLite / the phone app. Quit those and power-cycle the light. |
| `Could not find all requested services` | The connected device isn't a classic Neewer light (e.g. a Bluetooth Mesh bulb that name-matched). Use `bleId` to target the right device. |
| Rebuild seems ignored / `undefined` errors | `dist/` is owned by root from an earlier `sudo npm`. Run `sudo chown -R $(whoami) .`, then rebuild. |
| Two identical lights, wrong one responds | Use `bleId` (not `bleName`) for each, from the debug log. |

## Verifying the protocol

```bash
npm run build
node -e 'const p=require("./dist/protocol.js");const h=u=>Buffer.from(u).toString("hex").match(/.{2}/g).join(" ");console.log(h(p.powerCommand(true)), h(p.cctCommand(100,5600,3200,5600)), h(p.hsiCommand(360,100,100)));'
# 78 81 01 01 fb   78 87 02 64 38 9d   78 86 04 68 01 64 64 33
```

## References

- Homebridge developer docs: https://developers.homebridge.io/
- NeewerLite (protocol source): https://github.com/keefo/NeewerLite
- noble (BLE): https://github.com/abandonware/noble

## License

MIT
