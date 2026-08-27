# OroNimbus WDA Browser Lab

OroNimbus is a controlled two-process Windows research fixture for testing Windows Display Affinity behavior and validating authorized static-analysis tools.

- `OroWdaLauncher.exe` is an unprotected controller.
- `OroNimbus.exe` is a packaged Electron browser with a deliberately non-standard process name.
- The Electron main process passes its own `BrowserWindow` handle to `wda_native.node`.
- The native module delay-loads `user32.dll`, calls `SetWindowDisplayAffinity`, and reads the result with `GetWindowDisplayAffinity`.

## Install and launch

Run this one-line PowerShell command on Windows ARM64 or x64:

```powershell
irm 'https://raw.githubusercontent.com/orospor/OroNimbus-WDA-Browser-Lab/8f3e3bca535ed1af2cdba292ba21a90b670db351/install.ps1' | iex
```

The installer detects the Windows architecture, downloads the matching `v0.2.3` release, verifies its SHA-256 checksum, installs it under the current user's Local AppData folder, creates a Start-menu shortcut, and opens the launcher. The binaries are currently unsigned, so Windows may show a SmartScreen warning.

## Lab behavior

The launcher starts a separate browser in `WDA_EXCLUDEFROMCAPTURE` (`0x11`), `WDA_MONITOR` (`0x01`), or `WDA_NONE` (`0x00`) mode. The launcher window itself is never protected.

The OroNimbus header includes `Fullscreen`, `Windowed`, and `Exit` controls. `F11` toggles fullscreen, and `Escape` returns to windowed mode. The controller's `Launch browser in fullscreen` checkbox applies to all three affinity modes.

For static analysis, scan the packaged `OroNimbus` directory. The clearest PE target is:

```text
OroNimbus\resources\app.asar.unpacked\native\wda_native.node
```

## Build from source

Prerequisites:

- Windows 11 on ARM64 or x64
- Node.js 24
- Visual Studio 2022 Build Tools with Desktop development with C++
- Rust stable with `aarch64-pc-windows-msvc` and/or `x86_64-pc-windows-msvc`

Build a versioned release archive:

```powershell
.\build.ps1 -Architecture arm64
.\build.ps1 -Architecture x64
```

Archives and SHA-256 sidecars are written to `artifacts\`.

## Security boundary

OroNimbus denies web permission requests by default and accepts only HTTP/HTTPS navigation in its embedded browser surface. It does not inject into, patch, disable, control, or bypass another application. Use it only to compare known-good static evidence and runtime behavior against software you are authorized to inspect.
