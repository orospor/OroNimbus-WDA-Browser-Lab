# OroNimbus WDA Browser Lab

OroNimbus is a controlled Windows research fixture for testing Windows Display Affinity (WDA), process-local Code Integrity Guard (CIG), and defensive-posture analysis on lab-owned windows and processes.

- `OroWdaLauncher.exe` is an unprotected controller.
- `OroNimbus\OroNimbus.exe` is the native x64 or ARM64 Electron browser selected for the host.
- `OroNimbus-x86\OroNimbus.exe` is a separate, true 32-bit (`IMAGE_FILE_MACHINE_I386`) Electron browser, not a label applied to a 64-bit process.
- The Electron main process passes its own `BrowserWindow` handle to `wda_native.node`.
- The native module delay-loads `user32.dll`, calls `SetWindowDisplayAffinity`, and reads the result with `GetWindowDisplayAffinity`.
- Optional fixtures provide a three-second WDA readback/reapply watchdog, process-local DLL search hardening, Microsoft-signed-only CIG with operating-system readback, a loader-visible module-change heuristic for the Electron main process, and a live view of Chromium's process topology.

## Install and launch

Install `v0.5.0` on Windows ARM64 or x64 with:

```powershell
irm 'https://raw.githubusercontent.com/orospor/OroNimbus-WDA-Browser-Lab/v0.5.0/install.ps1' | iex
```

The command downloads one universal offline setup, verifies its SHA-256 checksum, installs the matching native ARM64 or x64 launcher/browser and the shared x86 browser companion under the current user's Local AppData folder, creates a Start-menu shortcut, and opens the launcher. The binaries are unsigned, so Windows may show a SmartScreen warning.

The MSI-managed copy uses `%LOCALAPPDATA%\Programs\OroSpor\OroNimbus-WDA-Browser-Lab`. Older versioned folders installed by the `v0.2.3` ZIP script are portable files and are intentionally left untouched; the new Start-menu shortcut points to the managed `v0.5.0` launcher.

## Lab behavior

The launcher starts either the native browser or the separate 32-bit x86 browser in `WDA_EXCLUDEFROMCAPTURE` (`0x11`), `WDA_MONITOR` (`0x01`), or `WDA_NONE` (`0x00`) mode. It validates the selected executable's PE machine before launch, and OroNimbus reports its runtime `process.arch`. The launcher window itself is never WDA-protected.

The watchdog, DLL-search hardening, main-process module monitor, and process-topology view are enabled by default:

- **3-second WDA watchdog:** reads the OroNimbus window with `GetWindowDisplayAffinity`; when the value differs from the requested mode, it reapplies that requested value. The browser reports check and repair counters.
- **DLL search hardening:** calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` and `SetDllDirectoryW(L"")` inside the OroNimbus main process before loading Electron's JavaScript API. The Electron executable and hardening addon are already loaded at that point, so this protects subsequent DLL searches rather than claiming pre-bootstrap coverage. The launcher applies the policy at its own entry point.
- **Native module-load monitor (heuristic):** takes a loader-visible baseline for the OroNimbus Electron main PID, then reports module paths first seen by later scans. It does not inspect renderer, GPU, utility, or other child processes, and it does not require administrator privileges.
- **Chromium process topology:** periodically reports the live Electron/Chromium process roles. The count is dynamic and commonly includes the main process, separate lab-UI and web-content renderers, a GPU process, and utility services.

### Code Integrity Guard

**Enable CIG MicrosoftSignedOnly** is intentionally off by default. When selected, OroNimbus loads its native addon and then calls `SetProcessMitigationPolicy(ProcessSignaturePolicy, MicrosoftSignedOnly)` in the Electron main process before importing Electron's JavaScript API. The browser displays the setter result, `GetProcessMitigationPolicy` readback, raw policy flags, PID, timing, and scope. A successful CIG state therefore means the Windows policy is effective for future executable-image mappings in the main process that owns the WDA window.

This is real CIG, but it is deliberately a post-bootstrap fixture. `OroNimbus.exe`, `wda_native.node`, and Electron's native runtime have already loaded before the policy can be requested. The policy does not retroactively validate those images, does not automatically cover renderer/GPU/utility child PIDs, and does not block every memory-only technique. It cannot be turned off in the running process; relaunch without the option to return to the baseline.

The package also carries `cig_probe_unsigned.node`, a never-preloaded unsigned image used only as an enforcement control. A CIG-enabled launch runs this check once; on a no-CIG launch, clicking the CIG inspection control runs the explicit baseline check once. Without CIG the probe must load and be immediately freed, while an effective signature policy must reject it with `ERROR_INVALID_IMAGE_HASH` (Win32 error `577`). The native helper derives the fixed probe path from its own packaged directory and accepts no caller-supplied DLL path. This paired result checks a real future image load instead of relying on the policy flags alone.

Readback distinguishes Microsoft-only, Store-only, and Microsoft/Store/WHQL opt-in enforcement. The launcher's CIG option passes only when the requested Microsoft-only policy is active; a different pre-existing signature policy is reported by its exact variant rather than mislabeled as off.

Strict creation-time CIG is not offered as a working browser mode. The packaged Electron executable, native addon, and several Electron DLLs are not Microsoft-signed, so applying `PROCESS_CREATION_MITIGATION_POLICY_BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON` before startup would prevent this unsigned payload from bootstrapping. An ordinary publisher code-signing certificate would not satisfy the Microsoft-signed-only policy. The UI must not describe the post-bootstrap fixture as strict, pre-bootstrap, or process-tree-wide CIG.

### Chromium process isolation

Electron uses Chromium's multi-process architecture. Windows can consequently show the same `OroNimbus.exe` image several times with main, renderer, GPU, and utility roles; the exact number changes with page state and services and is not a fixed seven. Each process may also contain many threads, so “multi-process” and “multi-threaded” are not interchangeable.

Only the Electron main process owns the top-level `BrowserWindow` to which WDA is applied. The additional processes are isolation and workload boundaries, not duplicate WDA protectors, and launching extra copies would not strengthen the window's affinity. The topology panel identifies the single WDA owner and shows the sandbox state reported for each observed Chromium role.

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

The `.node` file also imports the DLL-search and process-mitigation APIs used by the optional hardening fixtures. Static imports establish capability only. WDA and CIG are reported as active only when the corresponding Windows readback succeeds and matches the requested value.

## Scope and safety

- Every WDA apply, clear, inspect, and repair operation targets only OroNimbus's own top-level window.
- Module monitoring enumerates only loader-visible modules in OroNimbus's Electron main process. It neither opens nor scans another process, so elevation is not required.
- CIG is opt-in, process-local, post-bootstrap, and limited to the same main PID that owns the WDA window. It never changes another process or a machine-wide mitigation setting.
- `app.enableSandbox()` is called before readiness, and both the lab UI renderer and untrusted web-content renderer explicitly use `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`. Web permission requests and pop-up windows are denied.
- Every privileged IPC handler verifies that its caller is the trusted top-level toolbar renderer and its main frame. The embedded web-content renderer cannot invoke WDA, CIG, module, navigation, or window-control handlers directly.
- The lab does not inject into processes, modify third-party windows, install global hooks, kill processes, hide the taskbar, blank screens, or reproduce vendor certificate serials.
- The supplied decompiled ETS material did not establish active PPL, CIG, ACG, CET, WDAC, or other process-mitigation enforcement. The new CIG option is lab-only instrumentation and is not evidence that ETS uses CIG.

## 32-bit support lifecycle

This project pins Electron `43.4.1`, from the final Electron major line that publishes official Windows x86 (`win32-ia32`) binaries. Electron 44 and later are 64-bit-only, and the Electron project states that the v43 line reaches end of life in January 2027. The x86 companion is therefore a bounded compatibility and research fixture, not a long-term production browser baseline. See Electron's [v43 announcement](https://www.electronjs.org/blog/electron-43-0) and [breaking-changes notice](https://www.electronjs.org/docs/latest/breaking-changes#removed-windows-32-bit-ia32-and-linux-32-bit-arm-armv7l-support).

## Build from source

Prerequisites:

- Windows 11 on ARM64 or x64
- Node.js 24
- Python 3.11 or newer for `node-gyp`
- Visual Studio 2022 Build Tools with Desktop development with C++
- Rust stable with `aarch64-pc-windows-msvc`, `x86_64-pc-windows-msvc`, and `i686-pc-windows-msvc` as required

Build a versioned release archive:

```powershell
.\build.ps1 -Architecture arm64
.\build.ps1 -Architecture x64
.\build.ps1 -Architecture ia32
```

Archives and SHA-256 sidecars are written to `artifacts\`.

After all three architecture archives exist, build the single offline installer with WiX 4:

```powershell
.\build-universal-installer.ps1
```

The universal setup and its SHA-256 sidecar are written to `release\`.

## Security boundary

OroNimbus denies web permission requests by default and accepts only HTTP/HTTPS navigation in its embedded browser surface. It does not inject into, patch, disable, control, or bypass another application. Use it only to compare known-good static evidence and runtime behavior against software you are authorized to inspect.
