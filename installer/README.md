# Universal Windows installer

`build-universal-installer.ps1` packages the complete `v0.5.0` ARM64, x64, and ia32 browser bundles into one offline setup. At install time, the bootstrapper selects exactly one native ARM64 or x64 launcher/browser package and also installs the shared true 32-bit x86 browser companion.

This setup is the canonical installer used by `install.ps1`; the architecture-specific ZIP files remain portable release artifacts and should not be expanded over an MSI-managed installation.

Older ZIP/script installations stay in their separate versioned folder under `%LOCALAPPDATA%\Programs\OroNimbus-WDA-Browser-Lab`; installing or uninstalling this MSI does not remove those portable files.

The MSI preserves the portable layout used by the working local installation:

```text
%LOCALAPPDATA%\Programs\OroSpor\OroNimbus-WDA-Browser-Lab\
  OroWdaLauncher.exe
  OroNimbus\
    OroNimbus.exe
    resources\app.asar
    resources\app.asar.unpacked\native\wda_native.node
    resources\app.asar.unpacked\native\cig_probe_unsigned.node
    ...complete Electron runtime...
  OroNimbus-x86\
    OroNimbus.exe
    resources\app.asar
    resources\app.asar.unpacked\native\wda_native.node
    resources\app.asar.unpacked\native\cig_probe_unsigned.node
    ...complete 32-bit Electron runtime...
```

`OroNimbus` matches the host's native architecture. `OroNimbus-x86` is installed as a separate PE32 companion on both supported host architectures. Keeping distinct directories prevents one architecture's same-named Electron files from overwriting another's and lets the launcher verify `IMAGE_FILE_MACHINE_I386 (0x014C)` before it starts the x86 selection.

Build all three architecture artifacts first if they are not already present, then build the universal setup:

```powershell
.\build.ps1 -Architecture arm64
.\build.ps1 -Architecture x64
.\build.ps1 -Architecture ia32
.\build-universal-installer.ps1
```

The unsigned output and its SHA-256 sidecar are written to `release\`.

The build validates the launcher, browser executable, and native addon PE machines and checks each complete bundle size before generating deterministic WiX file manifests. The x86 companion has its own hidden per-user MSI in the bundle so it can be installed once beside either native package without component collisions. This keeps the installer compatible with WiX 4 while ensuring that no Electron runtime or OroNimbus resource is accidentally omitted.

After installing on a test machine, `Test-InstalledBrowser.ps1` verifies the x86 executable and addon as PE machine `0x014C`, opens the controller from an unrelated working directory, exercises the native and x86 choices, and verifies WDA readbacks `0x00`, `0x01`, and `0x11` for each. OroNimbus also displays its runtime `process.arch` for cross-checking, while the separate DevTools acceptance harness verifies opt-in CIG setter/readback state on the main/WDA-owner PID and the Chromium process topology. The tests close only browser processes they create.

CIG in this package is intentionally applied by the already-loaded native addon in the Electron main process. It is real `MicrosoftSignedOnly` enforcement with Windows readback, but it is post-bootstrap, main-PID-only, and irreversible until relaunch. The installer does not configure Image File Execution Options, Exploit Protection, or any machine-wide policy. Strict creation-time CIG would reject the unsigned Electron executable/addon/runtime and is not presented as a working launch mode.

Each browser tree includes `cig_probe_unsigned.node`, a never-preloaded unsigned enforcement control. The baseline loads and frees it; effective CIG must reject it with `ERROR_INVALID_IMAGE_HASH` (`577`). It is not a second runtime dependency or another WDA owner.

Both renderer surfaces explicitly use the Chromium sandbox, context isolation, disabled Node integration, and web security. Every privileged IPC handler is restricted to the trusted top-level toolbar renderer's main frame. Chromium creates a dynamic set of same-name renderer, GPU, and utility child processes; the installer and test must not assume a fixed count of seven or treat those roles as extra WDA copies. Only the main process owns the WDA window and the module monitor remains main-process-only.

The ia32 companion uses Electron `43.4.1`, in the last Electron major series that publishes official Windows x86 binaries. Electron 44 and later are 64-bit-only, and v43 reaches end of life in January 2027. Treat the x86 payload as a compatibility fixture with a defined retirement plan, not a long-lived production-browser dependency.

Install the tagged `v0.5.0` setup through the repository bootstrap script with:

```powershell
irm 'https://raw.githubusercontent.com/orospor/OroNimbus-WDA-Browser-Lab/v0.5.0/install.ps1' | iex
```
