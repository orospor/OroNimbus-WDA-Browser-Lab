# Universal Windows installer

`build-universal-installer.ps1` packages the complete v0.4.0 ARM64 and x64 browser bundles into one offline setup. At install time, the bootstrapper selects exactly one matching architecture.

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
    ...complete Electron runtime...
```

Build both architecture artifacts first if they are not already present, then build the universal setup:

```powershell
.\build.ps1 -Architecture arm64
.\build.ps1 -Architecture x64
.\build-universal-installer.ps1
```

The unsigned output and its SHA-256 sidecar are written to `release\`.

The build validates the three architecture-sensitive PE files and the complete bundle size, then generates an explicit deterministic WiX file manifest. This keeps the installer compatible with WiX 4 while ensuring that no Electron runtime or OroNimbus resource is accidentally omitted.

After installing on a test machine, `Test-InstalledBrowser.ps1` opens the controller from an unrelated working directory, exercises all three launch buttons, and verifies WDA readback values `0x00`, `0x01`, and `0x11`. It closes only browser processes created by that test.
