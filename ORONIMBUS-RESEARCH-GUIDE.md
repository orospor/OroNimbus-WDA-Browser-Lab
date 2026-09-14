# OroNimbus WDA Browser Lab: Architecture and Defensive Research Guide

This guide describes the architecture, Windows controls, observable evidence, and research boundaries of OroNimbus WDA Browser Lab. The analyzed baseline is `v0.5.0` at commit `8123998`.

OroNimbus is a controlled, self-targeting Windows research fixture. It can demonstrate Window Display Affinity (WDA), WDA drift repair, process-local Code Integrity Guard (CIG), DLL-search hardening, loader-visible module changes, and Electron process isolation. It is not a general-purpose injection detector or a hardened production browser.

Research should use only lab-owned processes and inert test fixtures. The project intentionally does not provide remote-process injection, manual mapping, process hollowing, stealth mechanisms, third-party targeting, or mitigation bypasses.

## Execution architecture

```text
OroWdaLauncher.exe (native controller; never WDA-protected)
    |
    +-- OroNimbus/OroNimbus.exe       native x64 or ARM64 browser
    +-- OroNimbus-x86/OroNimbus.exe   genuine IA-32 browser companion
            |
            +-- Electron main/browser process
            |     +-- owns the protected top-level HWND
            |     +-- loads wda_native.node
            |     +-- applies and reads WDA
            |     +-- optionally enables CIG
            |     +-- runs the WDA watchdog
            |     +-- monitors its loader-visible modules
            |     +-- samples Electron process topology
            |
            +-- trusted local toolbar renderer
            +-- remote-content renderer
            +-- GPU process
            +-- utility/network service processes
```

The launcher validates the selected executable's PE machine before starting it and passes the requested WDA and optional hardening flags. It does not attach to, inject into, or modify the browser after launch. See [launcher/src/main.rs](launcher/src/main.rs).

The Electron main process loads the native bridge before importing Electron when DLL hardening or CIG is requested. This is early JavaScript-startup enforcement, but it is not process-creation-time enforcement. See [app/main.js](app/main.js) and [native/wda_native.cc](native/wda_native.cc).

## Chromium process topology

Windows normally displays several processes named `OroNimbus.exe`. They are Chromium isolation and workload boundaries, not redundant WDA protectors:

- Main/browser process: owns the sole protected top-level window.
- Trusted lab-UI renderer: displays OroNimbus controls.
- Remote-content renderer: displays the requested web content.
- GPU process: handles graphics work.
- Utility processes: provide network and other Chromium services as needed.

The count is dynamic. It can change after navigation, renderer restarts, GPU changes, or service activation. A seven-process observation is not a fixed design requirement and does not mean seven windows or seven WDA instances. Chromium is both multi-process and multi-threaded; merely launching extra identical processes would not add capture protection.

OroNimbus samples `app.getAppMetrics()` every 1.5 seconds and records PID, reported process type, mapped role, sandbox state, integrity level, CPU use, working set, and exit events. This is Electron telemetry rather than an independently reconstructed Windows parent/child graph.

## Window Display Affinity

OroNimbus supports the three Windows affinity values:

| Mode | Value | Intended behavior in supported capture paths |
| --- | ---: | --- |
| `WDA_NONE` | `0x00` | No capture restriction |
| `WDA_MONITOR` | `0x01` | Window content is not reproduced outside a monitor display path |
| `WDA_EXCLUDEFROMCAPTURE` | `0x11` | Window is omitted from supported capture paths on supported Windows versions |

The Electron main process obtains the `BrowserWindow` native HWND and passes it to `wda_native.node`. Native code validates the value, calls `SetWindowDisplayAffinity`, immediately calls `GetWindowDisplayAffinity`, and returns independent setter and readback results.

A successful setter result by itself is not treated as proof. Active-state evidence requires the requested and read-back values to match.

WDA applies only to the lab's own top-level window. It does not make renderer, GPU, or utility processes independently WDA-protected; their output is composed into the main window. WDA is also not DRM, injection prevention, or an absolute screen-capture guarantee. Capture behavior can vary by Windows version, graphics composition, capture API, virtualization, and remote-desktop path. See Microsoft's [SetWindowDisplayAffinity documentation](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity).

### Startup interval

The current application shows its window and applies WDA after a short delayed callback. This creates a small visible-before-affinity interval. A production design should minimize that interval by applying the selected mode before showing normal content and should independently verify the resulting readback.

## WDA watchdog and drift simulation

When enabled, the watchdog reads the current affinity every three seconds. If the value does not match the current requested mode, it attempts to reapply the requested mode and records:

- Total checks.
- Detected mismatches or read errors.
- Repair attempts and successful repairs.
- Last readback and repair time.
- Windows error information.

The live selector changes both the window affinity and the watchdog's repair target. The built-in **Clear once** action deliberately writes `WDA_NONE` to OroNimbus's own window without changing that target.

- With the watchdog off, the cleared state should persist.
- With the watchdog on, the requested protected value should return after the next watchdog cycle.

This demonstrates drift detection and recovery. It cannot attribute who changed the affinity or which mechanism caused the change. Because the watchdog runs inside the same Electron main process, code already executing in that process could interfere with the protected state, timer, evidence, or repair function.

## Code Integrity Guard

The optional CIG control applies `ProcessSignaturePolicy` with `MicrosoftSignedOnly` to the Electron main/WDA-owner PID. OroNimbus records:

- Whether CIG was requested.
- Setter attempt, result, and Windows error.
- Policy readback before and after the request.
- Raw policy flags and individual Microsoft-only, Store-only, and opt-in fields.
- Whether a signature policy already existed.
- PID, timing, and declared scope.
- A controlled enforcement-probe result.

Microsoft documents the policy fields in [PROCESS_MITIGATION_BINARY_SIGNATURE_POLICY](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-process_mitigation_binary_signature_policy).

### Controlled unsigned-image probe

The package carries `cig_probe_unsigned.node`, a byte-identical copy of the native addon that is deliberately not preloaded. The CIG inspection performs one fixed-path `LoadLibraryExW` attempt against that packaged control image:

| Configuration | Expected result |
| --- | --- |
| CIG off | The control image loads and is immediately freed |
| Microsoft-only CIG effective | The same future load is rejected with Win32 error `577` (`ERROR_INVALID_IMAGE_HASH`) |

The native helper derives the fixed probe path from its own package directory. No arbitrary DLL path or target PID is accepted. Readback plus the enforcement result is stronger evidence than merely displaying a selected CIG checkbox.

### CIG boundary

The current fixture enables CIG only after `OroNimbus.exe`, Electron bootstrap components, and `wda_native.node` are already mapped. It therefore protects certain future executable-image mappings; it does not retroactively validate previously loaded images.

Additional limitations:

- Verified only for the Electron main/WDA-owner PID.
- Child-process CIG coverage is not established.
- Irreversible inside a running process; returning to baseline requires relaunch.
- Does not establish coverage of manual-mapped or memory-only code.
- Rejecting one unsigned control proves that controlled case, not universal injection resistance.

Strict Microsoft-only CIG at process creation is not a working mode for the current unsigned Electron package. It would reject required non-Microsoft Electron and application components before the browser could bootstrap. Ordinary publisher signing does not by itself satisfy a Microsoft-only policy.

## DLL-search hardening

The native launcher hardens its own DLL search at entry. When requested, the browser also calls:

```text
SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)
SetDllDirectoryW("")
```

This narrows subsequent legacy name-based DLL resolution and helps against classic search-order hijacking. It does not authenticate application-local files or protect against:

- Images already loaded before hardening.
- Explicit absolute-path library loads.
- Manual mapping or memory-only modification.
- Abuse of already trusted code.
- Replacement of writable application files.

The current browser's executable and native bridge must load before its browser-side policy can be requested, so the browser has a documented bootstrap gap.

## Loader-visible module monitor

The native helper takes a module snapshot of its own main process with the Windows Toolhelp module APIs. JavaScript establishes a baseline, polls every two seconds, deduplicates normalized paths, and records paths first observed after the baseline.

Paths are grouped as:

- Application tree.
- Windows tree.
- Other path.
- Unknown.

These labels describe location, not trust. An `other path` image can be legitimate software such as an accessibility component, security product, graphics overlay, or diagnostic tool.

### Monitor blind spots

The monitor is an anomaly heuristic, not proof of injection:

- It monitors only the Electron main PID.
- Renderer, GPU, utility, and other child PIDs are outside its scope.
- It sees only images represented in the Windows loader's module list.
- Manual-mapped images and memory-only changes may be absent.
- A two-second polling interval can miss transient loads.
- Pre-baseline images have no first-seen attribution.
- A previously observed path is not treated as new after an unload/reload cycle.
- Data-file mappings and attempts blocked before becoming loader-visible may be absent.
- The evidence generator runs inside the process being observed and is not tamper-resistant.

The appropriate claim is **main-process loader-visible module anomaly monitoring**, not universal DLL-injection detection.

## Renderer sandbox and IPC boundary

OroNimbus enables Electron sandboxing before application readiness. Its toolbar and remote-content renderers use:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `webviewTag: false`

The remote site runs in a separate `WebContentsView`. Popups and browser permission requests are denied. Privileged IPC handlers verify that the sender is both the exact trusted toolbar `webContents` and its top-level main frame. Embedded remote content therefore cannot directly invoke the WDA, CIG, module, navigation, or window-control operations.

This reduces web-to-main privilege exposure. It does not make the privileged Electron main process invulnerable, and compromising the trusted toolbar origin would expose the narrow operations deliberately bridged to it.

## Architecture variants

The launcher validates these PE machine values:

| Target | PE machine |
| --- | ---: |
| IA-32 | `0x014C` |
| x64 | `0x8664` |
| ARM64 | `0xAA64` |

The 32-bit selection starts a separate genuine IA-32 Electron package and matching native addon under `OroNimbus-x86`; it does not disguise a 64-bit process as 32-bit. Each architecture should be tested independently.

The project pins Electron `43.4.1` for its IA-32 companion and documents that branch as a bounded compatibility and research fixture. See the [Electron 43 announcement](https://www.electronjs.org/blog/electron-43-0) and [Electron breaking-changes notice](https://www.electronjs.org/docs/latest/breaking-changes#removed-windows-32-bit-ia32-and-linux-32-bit-arm-armv7l-support).

## Benign defensive research matrix

The following matrix exercises the current controls without producing reusable third-party injection tooling.

| Test | Configuration | Benign stimulus | Expected evidence |
| --- | --- | --- | --- |
| Baseline | CIG off, WDA NONE, monitors on | No added module | `0x00` WDA, non-empty baseline, exactly one WDA-owner PID |
| CIG negative control | CIG off | Built-in unsigned probe | Probe loads and is freed |
| CIG enforcement | CIG on in a fresh process | Same fixed probe | Microsoft-only readback and error `577` |
| Module positive control | Module monitor on | Fixed inert self-loaded fixture retained across two scans | One first-seen loader-visible module event |
| Path classification | Module monitor on | Same authorized fixture from a controlled external folder | `other path`, without a maliciousness verdict |
| WDA negative control | MONITOR or EXCLUDE; watchdog off | **Clear once** | Readback remains `0x00`; repair counter stays unchanged |
| WDA recovery | MONITOR or EXCLUDE; watchdog on | **Clear once** | Requested WDA returns and repair counter increases |
| Live WDA | Watchdog on | NONE -> MONITOR -> EXCLUDE -> NONE | Matching `0x00 -> 0x01 -> 0x11 -> 0x00` readbacks |
| Process scope | All controls on | Observe topology during navigation | One WDA owner; child counts remain dynamic |
| Architecture | Repeat core tests | IA-32, x64, ARM64 | PE machine, selected path, and `process.arch` agree |
| Memory-only category | Documentation case | No operational bypass implementation | Explicitly recorded as not covered |

The module positive control is not currently shipped. If added, it should be a fixed, inert, self-process-only fixture that remains resident long enough to cross at least two scans. It should accept neither an arbitrary target PID nor an arbitrary caller-supplied library path.

## Recommended evidence packet

Retain the following for every run:

1. Repository tag and commit.
2. SHA-256 of the executable, native bridge, and test fixture.
3. Windows build, OS architecture, process architecture, and selected executable path.
4. Main PID and protected HWND.
5. Requested WDA value, readback, setter/readback errors, and match result.
6. Watchdog counters and timestamps.
7. CIG request, setter result, exact readback flags, scope, PID, timing, and probe result.
8. Module baseline, scan count, first-seen path, classification, and timestamp.
9. Electron process roles, PIDs, sandbox state, and process-exit events.
10. Screenshots only as supporting presentation evidence; they do not replace Windows readback.

The automated verifier exports a structured result containing these major state groups. See [verify-controls.mjs](verify-controls.mjs) and the acceptance contract in [VERIFICATION.md](VERIFICATION.md).

## Safe inert-fixture design

A future positive module-control fixture should:

- Be compiled specifically for OroNimbus and have a fixed packaged identity.
- Export only its version and a test marker.
- Perform no network, credential, input, screen, persistence, or process-control activity.
- Be loaded only after an explicit local lab action.
- Operate only in the current OroNimbus test process.
- Remain resident for a known interval so polling results are reproducible.
- Have signed and unsigned variants when signature-policy comparisons are required.
- Produce a structured result tied to a nonce and binary hash.

This validates defensive observations without implementing a reusable stealth or cross-process injector.

## What OroNimbus can and cannot establish

### Supported claims

- WDA was requested and independently read back on the lab-owned top-level window.
- Live WDA changes and controlled drift repair occurred.
- Microsoft-only CIG was read back in the main PID.
- A controlled future unsigned loader-mediated image mapping was rejected.
- Subsequent legacy DLL search behavior was narrowed.
- A previously unseen loader-visible module path appeared in the main process.
- Trusted and untrusted renderer surfaces use sandbox and IPC boundaries.

### Unsupported claims

- Comprehensive DLL-injection prevention or detection.
- Manual-map, shellcode, or general memory-only detection.
- CIG or module-monitor coverage for every Chromium child.
- Creation-time Microsoft-only CIG for the packaged browser.
- Attribution of the actor or technique behind a WDA state change.
- Tamper-resistant external telemetry.
- Production-grade proctor anti-tamper readiness.

OroNimbus is therefore a useful controlled comparison lab. It should be used to produce narrow, reproducible evidence for each Windows control rather than a single claim that an application is "injection-proof."

## Production-oriented next steps

The highest-value defensive improvements are:

1. Apply and verify WDA before displaying normal browser content.
2. Add a fixed inert resident module-control fixture and structured JSON evidence export.
3. Add an external read-only observer for process creation, image-load, mitigation, and liveness telemetry across the Chromium tree.
4. Verify mitigation state separately for every relevant process role.
5. Sign release artifacts and add independent publisher verification rather than relying only on a checksum from the same release channel.
6. Move security-critical evidence away from the process being observed or protect it with authenticated, append-only reporting.
7. Maintain explicit negative controls so a requested setting is never confused with an effective operating-system policy.

These additions improve defensive assurance while keeping the lab authorized, observable, and reproducible.
