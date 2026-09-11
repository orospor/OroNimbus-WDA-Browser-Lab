# OroNimbus WDA Browser Lab — verification

`v0.5.0` adds a true ia32 browser companion, opt-in process-local CIG, explicit Chromium renderer sandboxing, and a live process-topology view. These controls have different scopes and must be verified independently; a WDA match does not prove CIG or sandbox state, and the presence of multiple Chromium processes does not mean multiple WDA copies exist.

## v0.5.0 release acceptance contract

The following evidence is required before publishing the `v0.5.0` tag and universal installer:

| Check | Required evidence |
| --- | --- |
| Native package selection | x64 host installs/launches PE machine `0x8664`; ARM64 host installs/launches PE machine `0xAA64` |
| True 32-bit selection | `OroNimbus-x86\OroNimbus.exe` and its `wda_native.node` are PE machine `0x014C`; the launched app reports `process.arch = ia32` |
| Architecture isolation | Native and x86 Electron trees occupy separate directories; selecting one never overwrites or silently falls back to the other |
| WDA on both architectures | Native and x86 main windows independently read back NONE `0x00`, MONITOR `0x01`, and EXCLUDE `0x11` |
| CIG opt-in | `SetProcessMitigationPolicy` is attempted only when requested; `GetProcessMitigationPolicy` succeeds and reports `MicrosoftSignedOnly` on the same PID that owns the WDA window |
| CIG boundary | UI reports post-Electron-executable-bootstrap timing, main/WDA-owner-only scope, exact Microsoft/Store/WHQL policy variant, raw flags and errors, and that relaunch is required to disable it |
| CIG enforcement control | Without CIG, packaged `cig_probe_unsigned.node` loads and is freed; with CIG effective, the never-preloaded image is rejected with `ERROR_INVALID_IMAGE_HASH` (`577`) |
| Explicit sandboxing | `app.enableSandbox()` is called before readiness and both renderer surfaces use `sandbox: true`, context isolation, disabled Node integration, and web security |
| Privileged IPC boundary | Every privileged handler accepts only the trusted top-level toolbar renderer's main frame and rejects the embedded web-content renderer and subframes |
| Process topology | One and only one entry is identified as the main/WDA owner; separate lab-UI and web-content renderer PIDs are observed; no assertion requires a fixed total count |
| Module-monitor scope | Baseline and first-seen module events remain limited to the main Electron PID and are described as heuristic evidence, not injection proof |
| Exit behavior | Exit closes the browser's dynamic Chromium process tree without terminating unrelated processes |

The CIG result must retain separate fields for requested state, setter attempt/result, Windows readback, effective policy, timing, scope, PID, pre-existing policy, and the packaged probe-load result. “Requested,” a successful process launch, or policy flags without the enforcement control is not a pass.

Strict creation-time `PROCESS_CREATION_MITIGATION_POLICY_BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON` is deliberately not a working-browser acceptance case. The current Electron executable, native addon, and several runtime DLLs are not Microsoft-signed, so strict startup CIG is expected to reject the payload before it can provide the WDA lab. The supported fixture applies real CIG after those bootstrap images are loaded and tests future image mappings in the main process only.

## v0.4.0 historical release acceptance

`v0.4.0` release acceptance was completed on 9 September 2026 against the universal setup on native Windows ARM64 and native Intel x64 hosts with Electron 43.4.1. The setup selected one matching architecture package on each machine, and the installed launcher resolved the complete sibling `OroNimbus` runtime from its managed installation directory.

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

## v0.5.0 ia32 acceptance checks

The universal setup carries one native payload and one x86 companion payload. On each supported x64 and ARM64 host:

- Verify `OroNimbus-x86\OroNimbus.exe` and `OroNimbus-x86\resources\app.asar.unpacked\native\wda_native.node` both have PE machine `0x014C`.
- Select the launcher's 32-bit option and confirm the WDA-owner process path is the `OroNimbus-x86` path and the application reports `ia32` in its process label/state.
- Repeat NONE, MONITOR, and EXCLUDE and independently read the main window's affinity as `0x00`, `0x01`, and `0x11`.
- Clear the 32-bit window once with the watchdog enabled and confirm the watchdog restores the selected mode.
- Deselect the option and confirm the native PE machine/path and runtime architecture return without reinstalling.

An x86-named directory or UI label is insufficient. The PE header, actual launched path, and runtime architecture must agree.

Electron `43.4.1` belongs to the final Electron major line that publishes official `win32-ia32` binaries. Electron 44 and later do not publish them, and v43 reaches end of life in January 2027. Acceptance of the x86 fixture does not remove that lifecycle limitation.

## v0.5.0 CIG acceptance checks

Launch each supported browser architecture with CIG selected and at least one WDA mode:

- First launch without CIG, explicitly invoke the CIG inspection control, and confirm its one-shot `cig_probe_unsigned.node` check is attempted, loaded, and freed, with no code-integrity block.
- Confirm `cigRequested`, `setAttempted`, `setOk`, `getOk`, `effective`, and `microsoftSignedOnly` are true.
- Confirm the CIG result PID equals the state PID and the single process-topology entry marked as the WDA owner.
- Confirm the raw readback flags include `MicrosoftSignedOnly`, timing is `post-electron-executable-bootstrap`, and scope is `electron-main-wda-owner-only`.
- Confirm the same never-preloaded probe no longer loads, `blockedByCodeIntegrity` is true, and both the actual and expected Win32 errors are `ERROR_INVALID_IMAGE_HASH` (`577`).
- Confirm the selected WDA value still reads back correctly after CIG is effective.
- Invoke the CIG inspection control again and confirm it performs a read-only policy refresh rather than claiming to re-enable or disable the policy.
- Relaunch without CIG to test the baseline; there is no supported live-off transition because the policy is irreversible for the running process.
- If Windows reports an already-active signature policy before the setter call, retain `preexisting` and the before-flags instead of attributing that policy to OroNimbus.

This pass proves Microsoft-signed-only image policy for future loads in the main/WDA-owner PID. It does not prove creation-time coverage, retroactive validation of the Electron/bootstrap images, CIG on child processes, or blocking of manual-mapped and other memory-only code.

### Observed packaged-browser results

The final architecture packages were exercised on 11 September 2026 before building the universal setup:

| Browser | WDA exercise | CIG enforcement probe | Topology result |
| --- | --- | --- | --- |
| IA-32 | MONITOR read back `0x01`; watchdog repaired a deliberate clear | Flags `0x5`; blocked with error `577` | Five-process snapshot; one WDA owner; both renderers sandboxed |
| x64 under ARM64 emulation | NONE read back `0x00`; live selector completed the NONE/MONITOR/EXCLUDE sequence | Flags `0x5`; blocked with error `577` | Five-process snapshot; one WDA owner; both renderers sandboxed |
| Native ARM64 | EXCLUDE read back `0x11`; watchdog repaired a deliberate clear | Flags `0x5`; blocked with error `577` | Five-process snapshot; one WDA owner; both renderers sandboxed |

The IA-32 no-CIG control also loaded and freed `cig_probe_unsigned.node`, proving that the later error `577` was the CIG-side difference rather than a generally unloadable fixture. Five is the observed snapshot for these runs, not a fixed process-count requirement. Installed-layout and launcher-selection evidence was then collected separately from the completed universal setup.

### Observed universal-setup result

The unsigned `v0.5.0` universal setup installed successfully on native Windows ARM64 on 11 September 2026 and placed both `OroNimbus\OroNimbus.exe` and `OroNimbus-x86\OroNimbus.exe` under the managed per-user installation root. The installed controller was started with an unrelated working directory and produced this externally checked matrix:

| Controller selection | NONE | MONITOR | EXCLUDE | CIG readback on every launch |
| --- | ---: | ---: | ---: | --- |
| Native ARM64 path | `0x00` | `0x01` | `0x11` | Flags `0x5` |
| True x86 path | `0x00` | `0x01` | `0x11` | Flags `0x5` |

All six launches resolved the exact selected installed executable path. The x86 selection never fell back to the native directory, and the setup returned exit code `0` with all required native, x86, addon, and probe files present.

## v0.5.0 sandbox and topology acceptance checks

- Confirm the source calls `app.enableSandbox()` before `app.whenReady()`.
- Confirm both `BrowserWindow` and `WebContentsView` use `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, and `webviewTag: false`.
- Confirm every privileged IPC request verifies both the trusted toolbar `webContents` and its top-level `mainFrame`; requests from the embedded content renderer or a subframe must be rejected.
- Confirm the lab UI renderer and web-content renderer have different PIDs and the topology marks exactly one main/WDA owner.
- Confirm the observed role count may grow or shrink as Chromium starts and stops GPU or utility services. Do not require exactly seven processes.
- Confirm every visible child is described as process isolation/workload separation rather than an additional WDA owner or redundant protection copy.
- Confirm the module-monitor panel continues to say main PID only even while the topology panel displays child roles.

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

## v0.5.0 static result

Each packaged native addon below has a USER32 delay-import table containing both WDA APIs:

`OroNimbus\resources\app.asar.unpacked\native\wda_native.node`

`OroNimbus-x86\resources\app.asar.unpacked\native\wda_native.node`

- `SetWindowDisplayAffinity`
- `GetWindowDisplayAffinity`

The ARM64, x64, and ia32 modules also have normal imports for:

- `SetDefaultDllDirectories`
- `SetDllDirectoryW`
- `SetProcessMitigationPolicy`
- `GetProcessMitigationPolicy`

The launcher for each native architecture imports the same DLL-search APIs. The required PE machines are `AA64` (`0xAA64`) for the ARM64 module/launcher, `8664` (`0x8664`) for the x64 module/launcher, and `I386` (`0x014C`) for the x86 browser and addon.

Local inspection of the generated `v0.5.0` architecture artifacts on 11 September 2026 found matching executable/addon pairs: ARM64 `0xAA64`, x64 `0x8664`, and ia32 `0x014C`. `Get-AuthenticodeSignature` reported both the browser executable and addon as `NotSigned` in all three artifacts. That result supports the documented strict creation-time CIG incompatibility; it is not a substitute for the runtime CIG and WDA checks above.

The addon is the clearest single-file capability scan target. Static imports do not prove a runtime request. Active WDA requires matching `GetWindowDisplayAffinity` readback, and active CIG requires matching `GetProcessMitigationPolicy` readback on the main/WDA-owner PID. Scanning both `OroNimbus` directories exercises recursive discovery of `.exe`, `.dll`, and `.node` PE files across native and ia32 payloads.

## Window-control results

- Invoking `Fullscreen` entered fullscreen and changed the button label to `Windowed`.
- Invoking the control again returned to windowed mode and restored the `Fullscreen` label.
- Invoking `Exit` closed the complete Electron process tree; no OroNimbus test processes remained after verification.

## Evidence limits

The recovered custom call path used WDA value `1`, not `0x11`. The `0x11` code was present in bundled Electron native code but had no recovered application call site, so EXCLUDE is labelled as a capability test. Managed ETSDISS WDA entries were declarations without recovered calls and must not be promoted to runtime enforcement without live evidence.

The live WDA selector and main-process module monitor began as `v0.4.0` lab instrumentation. The `v0.5.0` x86 companion, CIG option, explicit renderer sandboxing, and topology panel are also lab instrumentation. None is claimed as a recovered ETS feature. In particular, successful OroNimbus CIG readback is not evidence that ETS employs CIG, and the module/path heuristic is not proof that the examined product performs injection detection.

## Fullscreen-launch results

With the controller's shared fullscreen checkbox selected:

| Launch type | Started fullscreen | Affinity read-back | Result |
| --- | --- | ---: | --- |
| EXCLUDE | Yes | `0x11` | Pass |
| MONITOR | Yes | `0x01` | Pass |
| NONE | Yes | `0x00` | Pass |

## Scope

The test only launches and protects its own Electron window. Only the Electron main PID owns that top-level WDA window; renderer, GPU, and utility children are dynamic Chromium isolation roles rather than additional protected-window copies. Module enumeration and opt-in CIG are limited to the main/WDA-owner process and require no administrator access. The lab does not inject into, patch, control, or bypass another program.
