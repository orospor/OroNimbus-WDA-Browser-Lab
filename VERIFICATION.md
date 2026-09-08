# OroNimbus WDA Browser Lab — verification

`v0.4.0` release acceptance was completed on 9 September 2026 against the universal setup on native Windows ARM64 and native Intel x64 hosts with Electron 43.4.1. The setup selected one matching architecture package on each machine, and the installed launcher resolved the complete sibling `OroNimbus` runtime from its managed installation directory.

## v0.4.0 release acceptance

| Check | Windows ARM64 | Intel x64 |
| --- | --- | --- |
| Universal setup architecture selection | ARM64 selected; x64 skipped | x64 selected; ARM64 skipped |
| Installed payload | 80 files; exact MSI/source hash set | 80 files; exact MSI/source hash set |
| Launcher buttons from installed path | NONE `0x00`; MONITOR `0x01`; EXCLUDE `0x11` | NONE `0x00`; MONITOR `0x01`; EXCLUDE `0x11` |
| Live WDA sequence without relaunch | `0x00 → 0x01 → 0x11 → 0x00` | `0x00 → 0x01 → 0x11 → 0x00` |
| Watchdog drift repair | Pass; two requested-mode repairs observed | Pass; two requested-mode repairs observed |
| DLL-search hardening readback | Pass | Pass |
| Main-process module baseline and manual scan | Pass; 82 loader-visible modules in final run | Pass; 85 loader-visible modules in final run |
| Fullscreen, windowed, and exit controls | Pass | Pass |

The ARM64 Start-menu shortcut was also launched from an unrelated working directory. The Intel checks ran in the active interactive desktop after SHA-256 verification of the transferred universal setup; SSH service-session GUI launch was deliberately not treated as a valid desktop test. Temporary scheduled test tasks and transferred test files were removed afterward, while the installed application was retained.

The earlier `v0.3.0` results below are retained as historical evidence for the same core WDA behavior.

## Runtime results

| Launch mode | External `GetWindowDisplayAffinity` read-back | Result |
| --- | ---: | --- |
| `--wda=exclude` | `0x11` (`WDA_EXCLUDEFROMCAPTURE`) | Pass |
| `--wda=monitor` | `0x01` (`WDA_MONITOR`) | Pass |
| `--wda=none` | `0x00` (`WDA_NONE`) | Pass |

All three ARM64 modes passed. The x64 build also passed MONITOR mode under Windows ARM64 emulation. The observed main, renderer, GPU, and utility process image name was `OroNimbus.exe`.

## Defense-fixture results

| Check | ARM64 | x64 under ARM64 emulation |
| --- | --- | --- |
| 3000 ms watchdog performed a readback | Pass | Pass |
| Lab-only `Clear once` changed MONITOR from `0x01` to `0x00` | Pass | Pass |
| Next watchdog tick restored `0x01` and incremented repair count | Pass | Pass |
| EXCLUDE clear-and-repair restored `0x11` | Pass | Not repeated |
| `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` returned success | Pass | Pass |
| `SetDllDirectoryW(L"")` returned success | Pass | Pass |

The NONE baseline produced regular watchdog reads without a repair because `0x00` already matched the requested value.

The browser applies the DLL-search policy before requiring Electron's JavaScript API, but after the Electron executable and native hardening addon have necessarily loaded. The result verifies future-load policy state, not pre-bootstrap protection. The launcher applies the policy at its own entry point.

## v0.4.0 live-WDA acceptance checks

Launch the unprotected browser with `--wda=none` and the watchdog enabled. Without restarting OroNimbus, perform and independently read back this sequence on the same top-level window:

| UI action | Required `GetWindowDisplayAffinity` read-back |
| --- | ---: |
| Select MONITOR and turn WDA on | `0x01` (`WDA_MONITOR`) |
| Select EXCLUDE while WDA remains on | `0x11` (`WDA_EXCLUDEFROMCAPTURE`) |
| Turn WDA off | `0x00` (`WDA_NONE`) |

For each transition, the header must report the newly requested value and a matching readback. After the change, deliberately clear or alter the lab-owned window and confirm that the watchdog repairs toward the latest live UI selection, not the original launch argument. Closing and relaunching is a test failure for this sequence.

## v0.4.0 module-monitor acceptance checks

With **Monitor OroNimbus native module loads (heuristic)** enabled in the launcher:

- Confirm that the baseline becomes ready for the Electron main PID and reports at least one loader-visible module.
- Confirm that modules from other paths already present when monitoring starts are visible as baseline entries with unknown origin rather than silently treated as later first-seen events.
- Trigger a manual scan and confirm that it completes without an enumeration error. A successful test does not require a newly loaded module.
- If a later scan observes a new path, confirm it appears once as a first-seen event and is grouped as application-tree, Windows-tree, or other-path provenance.
- Confirm that the monitor works as a standard user. Administrator elevation is neither needed nor expected because the implementation enumerates only its own main process.
- Confirm that no UI label calls a module “injected,” “malicious,” or “trusted” solely from path placement or first-seen timing.

This check validates a polling heuristic, not injection detection. It cannot establish who caused a load and does not cover renderer/GPU/utility child processes, manual maps, shellcode or other memory-only changes, transient modules between polls, data-file loads, or blocked load attempts.

## Static result

The packaged file below has a USER32 delay-import table containing both APIs:

`OroNimbus\resources\app.asar.unpacked\native\wda_native.node`

- `SetWindowDisplayAffinity`
- `GetWindowDisplayAffinity`

Both the ARM64 and x64 modules also have normal imports for:

- `SetDefaultDllDirectories`
- `SetDllDirectoryW`

The launcher for each architecture imports the same DLL-search APIs. `dumpbin` reported machine `AA64` for the ARM64 module/launcher and `8664` for the x64 builds.

This is the clearest single-file scan target. Scanning the entire `OroNimbus` directory exercises recursive discovery of `.exe`, `.dll`, and `.node` PE files.

## Window-control results

- Invoking `Fullscreen` entered fullscreen and changed the button label to `Windowed`.
- Invoking the control again returned to windowed mode and restored the `Fullscreen` label.
- Invoking `Exit` closed the complete Electron process tree; no OroNimbus test processes remained after verification.

## Evidence limits

The recovered custom call path used WDA value `1`, not `0x11`. The `0x11` code was present in bundled Electron native code but had no recovered application call site, so EXCLUDE is labelled as a capability test. Managed ETSDISS WDA entries were declarations without recovered calls and must not be promoted to runtime enforcement without live evidence.

The live WDA selector and main-process module monitor are `v0.4.0` lab instrumentation. They are not claimed as recovered product features or evidence that the examined product performs injection detection.

## Fullscreen-launch results

With the controller's shared fullscreen checkbox selected:

| Launch type | Started fullscreen | Affinity read-back | Result |
| --- | --- | ---: | --- |
| EXCLUDE | Yes | `0x11` | Pass |
| MONITOR | Yes | `0x01` | Pass |
| NONE | Yes | `0x00` | Pass |

## Scope

The test only launches and protects its own Electron window. Module enumeration is limited to the Electron main process and requires no administrator access. The lab does not inject into, patch, control, or bypass another program.
