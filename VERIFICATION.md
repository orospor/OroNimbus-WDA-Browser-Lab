# OroNimbus WDA Browser Lab — verification

Verified on Windows ARM64 with Electron 43.4.1. Version 0.2.3 retains the controller-wide fullscreen-launch option and adds explicit permission denial, HTTP/HTTPS-only navigation, reproducible cross-architecture packaging, and release privacy checks.

## Runtime results

| Launch mode | External `GetWindowDisplayAffinity` read-back | Result |
| --- | ---: | --- |
| `--wda=exclude` | `0x11` (`WDA_EXCLUDEFROMCAPTURE`) | Pass |
| `--wda=monitor` | `0x01` (`WDA_MONITOR`) | Pass |
| `--wda=none` | `0x00` (`WDA_NONE`) | Pass |

The observed main, renderer, GPU, and utility process image name was `OroNimbus.exe`.

## Static result

The packaged file below has a USER32 delay-import table containing both APIs:

`OroNimbus\resources\app.asar.unpacked\native\wda_native.node`

- `SetWindowDisplayAffinity`
- `GetWindowDisplayAffinity`

This is the clearest single-file scan target. Scanning the entire `OroNimbus` directory exercises recursive discovery of `.exe`, `.dll`, and `.node` PE files.

## Window-control results

- Invoking `Fullscreen` entered fullscreen and changed the button label to `Windowed`.
- Invoking `Windowed` restored the normal window and changed the label back to `Fullscreen`.
- Invoking `Exit` closed the main window and terminated the Electron process tree.

## Fullscreen-launch results

With the controller's shared fullscreen checkbox selected:

| Launch type | Started fullscreen | Affinity read-back | Result |
| --- | --- | ---: | --- |
| EXCLUDE | Yes | `0x11` | Pass |
| MONITOR | Yes | `0x01` | Pass |
| NONE | Yes | `0x00` | Pass |

## Scope

The test only launches and protects its own Electron window. It does not inject into, patch, control, or bypass another program.
