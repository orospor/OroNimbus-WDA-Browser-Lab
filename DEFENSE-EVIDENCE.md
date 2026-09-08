# Defense evidence and fixture mapping

This note records the evidence boundary used for OroNimbus `v0.4.0`. The source folders contained decompiled text, not original executable files, and nothing from them was executed. Line numbers refer to those supplied decompilations. No third-party implementation code is copied into this lab.

| Recovered evidence | Classification | OroNimbus fixture |
| --- | --- | --- |
| `main.ipc.decompiled.js:609-628` maps the content-protection IPC value to `0` or `1` and calls `SetWindowDisplayAffinity` through a runtime `ffi-napi` binding. | Recovered executable call path; invocation still depends on renderer IPC. | `--wda=monitor` applies `WDA_MONITOR (0x01)` through the lab's delay-loaded native module. |
| `main.ipc.decompiled.js:552-601` reads the current value, compares it with `1`, and reapplies after a mismatch; `:636-665` starts a 3000 ms interval. | Active-capable watchdog path. | `--watchdog` runs a 3000 ms readback loop, records checks/repairs, and repairs only the lab-owned window. |
| `main.ipc.decompiled.js:1144-1159` defaults the feature gate on and installs the binding/handler. `main.protected.decompiled.js:775,851,856-860` contains disable paths. | Default-enabled feature gate, not proof that startup alone applies WDA. | The launcher defaults the watchdog on and exposes an explicit checkbox to disable it. |
| `etschrome.exe.decompiled.c:933827-933845` contains Electron native `0x11` behavior, but no recovered application call site invokes it. | Static Electron capability, not confirmed product use. | EXCLUDE is retained and labelled as a separate capability test. |
| Managed ETSDISS files declare `SetWindowDisplayAffinity` and `GetWindowDisplayAffinity` (for example, `UASTCManager.exe.decompiled.cs:2485-2489`) without a recovered invocation. | Declaration/capability only; a static scanner must not report it as confirmed active enforcement. | Documentation and test expectations keep static capability separate from runtime readback. |
| `cpbrowser.exe.decompiled.cs:897-910` and related startup paths call `SetDefaultDllDirectories(0x800)` plus `SetDllDirectory("")`. | Recovered active startup hardening against legacy DLL search-order abuse. | Optional `--harden-dll-search` applies the same API policy before the Electron JavaScript API loads and reports both results. The Electron executable and addon must load first, so the browser fixture explicitly has a bootstrap gap; the launcher applies it at entry. |
| The package code performs MD5 file checks and redeployment; certificate serial checks do not call `WinVerifyTrust`/`SignedCms.CheckSignature` and failures are telemetry-only. | Integrity behavior exists, but the recovered certificate logic is not trustworthy signature enforcement. | Not reproduced in this WDA-focused release. A future trust fixture should use SHA-256 and `WinVerifyTrust`, not copied serials. |

## v0.4.0 lab instrumentation, not recovered evidence

The live WDA selector is a lab usability feature. It changes only OroNimbus's own top-level window between NONE, MONITOR, and EXCLUDE while the browser is running, and updates the watchdog's requested value. Its presence does not imply that the examined product exposed or used an equivalent live selector.

The native module-load monitor is also lab-only instrumentation. It periodically enumerates the Windows-loader-visible module list for the OroNimbus Electron main PID and records paths first seen after its baseline. “Application tree,” “Windows tree,” and “other path” are provenance groupings, not trust decisions. The monitor does not need administrator access because it does not open another process.

This heuristic cannot prove injection or identify the actor that caused a load. It does not observe renderer, GPU, utility, or other child processes; manual-mapped images; shellcode or other memory-only modifications; modules that load and unload between scans; data-file loads absent from the executable loader list; or attempts blocked before a module became visible. A first-seen or other-path entry is an investigation lead only and may be entirely legitimate.

## Negative findings

No supplied call path established active `SetProcessMitigationPolicy`, PPL, CIG, ACG, CET, WDAC, or product-specific injection detection. Native CFG-related strings alone are not proof of a runtime enforcement policy. The lab therefore does not report those controls as present, and the `v0.4.0` self-module heuristic does not change that negative finding.

The supplied material also contains global input hooks, process termination, taskbar/window suppression, and screen blanking. Those mechanisms are intrusive proctoring controls rather than capture-defense evidence and are intentionally excluded.
