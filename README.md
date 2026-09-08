# OroNimbus WDA Browser Lab

OroNimbus is a controlled two-process Windows research fixture for testing Windows Display Affinity and defensive-posture analysis on lab-owned windows and processes.

- `OroWdaLauncher.exe` is an unprotected controller.
- `OroNimbus.exe` is a packaged Electron browser with a deliberately non-standard process name.
- The Electron main process passes its own `BrowserWindow` handle to `wda_native.node`.
- The native module delay-loads `user32.dll`, calls `SetWindowDisplayAffinity`, and reads the result with `GetWindowDisplayAffinity`.
- Optional, default-on fixtures reproduce a three-second WDA readback/reapply watchdog, process-local DLL search hardening, and a loader-visible module-change heuristic for the Electron main process.

## Install and launch

Install `v0.4.0` on Windows ARM64 or x64 with:

```powershell
irm 'https://raw.githubusercontent.com/orospor/OroNimbus-WDA-Browser-Lab/v0.4.0/install.ps1' | iex
```

The command downloads one universal offline setup, verifies its SHA-256 checksum, installs the matching ARM64 or x64 build under the current user's Local AppData folder, creates a Start-menu shortcut, and opens the launcher. The setup contains `OroWdaLauncher.exe` plus the complete `OroNimbus` Electron runtime. The binaries are unsigned, so Windows may show a SmartScreen warning.

The MSI-managed copy uses `%LOCALAPPDATA%\Programs\OroSpor\OroNimbus-WDA-Browser-Lab`. Older versioned folders installed by the `v0.2.3` ZIP script are portable files and are intentionally left untouched; the new Start-menu shortcut points to the managed `v0.4.0` launcher.

## Lab behavior

The launcher starts a separate browser in `WDA_EXCLUDEFROMCAPTURE` (`0x11`), `WDA_MONITOR` (`0x01`), or `WDA_NONE` (`0x00`) mode. The launcher window itself is never WDA-protected.

Three defense-fixture checkboxes are enabled by default:

- **3-second WDA watchdog:** reads the OroNimbus window with `GetWindowDisplayAffinity`; when the value differs from the requested mode, it reapplies that requested value. The browser reports check and repair counters.
- **DLL search hardening:** calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` and `SetDllDirectoryW(L"")` inside the OroNimbus main process before loading Electron's JavaScript API. The Electron executable and hardening addon are already loaded at that point, so this protects subsequent DLL searches rather than claiming pre-bootstrap coverage. The launcher applies the policy at its own entry point.
- **Native module-load monitor (heuristic):** takes a loader-visible baseline for the OroNimbus Electron main PID, then reports module paths first seen by later scans. It does not inspect renderer, GPU, utility, or other child processes, and it does not require administrator privileges.

### Live WDA controls

An OroNimbus window launched in unprotected `WDA_NONE` mode can select MONITOR or EXCLUDE in its header and turn WDA on while the app remains open. The same control turns WDA off again without relaunching the browser. When the watchdog is enabled, its requested value follows the live selection so it repairs toward the current UI state rather than the original launch mode.

The module control takes its main-process baseline when monitoring starts, shows any other-path modules already present at that baseline with origin explicitly unknown, and lists paths first observed by later scans with their observation time. Paths are grouped by where they reside: the packaged application tree, the Windows tree, or another location. Those groups describe provenance only; they are not trust or maliciousness verdicts. A new or externally located DLL can be legitimate software such as an accessibility tool, graphics component, security product, or overlay.

The monitor is an anomaly clue, not proof of code injection. Windows loader enumeration can miss manual-mapped images, shellcode and other memory-only changes, modules that load and unload between scans, data-file-only loads, and attempts blocked before a module became loader-visible. It also misses changes confined to OroNimbus child processes. Use the reported path and timing as a lead for authorized follow-up analysis, not as a standalone accusation.

The browser's **Clear once** button deliberately sets only its own lab window to `WDA_NONE`. With the watchdog on, the next check restores the requested protected value and increments the repair counter. This supplies a reproducible drift-and-repair test without touching another process.

`WDA_MONITOR + watchdog` mirrors the recovered custom mechanism. `WDA_EXCLUDEFROMCAPTURE` remains a useful Electron capability fixture, but no recovered application call site proved that the examined product actively requested `0x11`. See [DEFENSE-EVIDENCE.md](DEFENSE-EVIDENCE.md) for the evidence boundary.

The OroNimbus header includes `Fullscreen`, `Windowed`, and `Exit` controls. `F11` toggles fullscreen, and `Escape` returns to windowed mode. The controller's `Launch browser in fullscreen` checkbox applies to all three affinity modes.

For static analysis, scan the packaged `OroNimbus` directory. The clearest PE target is:

```text
OroNimbus\resources\app.asar.unpacked\native\wda_native.node
```

The `.node` file now also imports the DLL-search APIs used by the optional hardening fixture. Static imports establish capability; runtime state and counters establish whether the fixture was requested and applied.

## Scope and safety

- Every WDA apply, clear, inspect, and repair operation targets only OroNimbus's own top-level window.
- Module monitoring enumerates only loader-visible modules in OroNimbus's Electron main process. It neither opens nor scans another process, so elevation is not required.
- The lab does not inject into processes, modify third-party windows, install global hooks, kill processes, hide the taskbar, blank screens, or reproduce vendor certificate serials.
- The supplied decompiled material did not establish active PPL, CIG, ACG, CET, WDAC, or other process-mitigation enforcement, so the lab does not claim or simulate those controls.

## Build from source

Prerequisites:

- Windows 11 on ARM64 or x64
- Node.js 24
- Python 3.11 or newer for `node-gyp`
- Visual Studio 2022 Build Tools with Desktop development with C++
- Rust stable with `aarch64-pc-windows-msvc` and/or `x86_64-pc-windows-msvc`

Build a versioned release archive:

```powershell
.\build.ps1 -Architecture arm64
.\build.ps1 -Architecture x64
```

Archives and SHA-256 sidecars are written to `artifacts\`.

After both architecture archives exist, build the single offline installer with WiX 4:

```powershell
.\build-universal-installer.ps1
```

The universal setup and its SHA-256 sidecar are written to `release\`.

## Security boundary

OroNimbus denies web permission requests by default and accepts only HTTP/HTTPS navigation in its embedded browser surface. It does not inject into, patch, disable, control, or bypass another application. Use it only to compare known-good static evidence and runtime behavior against software you are authorized to inspect.
