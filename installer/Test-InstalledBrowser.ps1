[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $InstallRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$launcherPath = Join-Path $resolvedRoot 'OroWdaLauncher.exe'
$browserPath = Join-Path $resolvedRoot 'OroNimbus\OroNimbus.exe'
$x86BrowserPath = Join-Path $resolvedRoot 'OroNimbus-x86\OroNimbus.exe'
$x86AddonPath = Join-Path $resolvedRoot 'OroNimbus-x86\resources\app.asar.unpacked\native\wda_native.node'
foreach ($requiredPath in @($launcherPath, $browserPath, $x86BrowserPath, $x86AddonPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required installed executable was not found at $requiredPath"
    }
}

function Get-PeMachine([string] $Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            throw "$Path is not a PE file."
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "$Path has an invalid PE signature."
        }
        return $reader.ReadUInt16()
    }
    finally {
        $stream.Dispose()
    }
}

foreach ($x86Path in @($x86BrowserPath, $x86AddonPath)) {
    $machine = Get-PeMachine $x86Path
    if ($machine -ne 0x014C) {
        throw ('Expected a 32-bit x86 PE (machine 0x014C), found 0x{0:X4} at {1}' -f $machine, $x86Path)
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OroNimbusInstallerTestNative
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetDlgItem(IntPtr window, int controlId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetProcessMitigationPolicy(
        IntPtr process,
        int mitigationPolicy,
        out uint policyFlags,
        UIntPtr length);
}
'@

function Get-InstalledBrowserProcesses([string] $ExpectedPath = '') {
    return @(Get-Process -Name 'OroNimbus' -ErrorAction SilentlyContinue | Where-Object {
        try {
            ($_.Path -ieq $browserPath -or $_.Path -ieq $x86BrowserPath) -and (
                [string]::IsNullOrWhiteSpace($ExpectedPath) -or $_.Path -ieq $ExpectedPath
            )
        }
        catch {
            $false
        }
    })
}

function Wait-ForMainWindow(
    [int[]] $ExcludedProcessIds,
    [uint32] $ExpectedAffinity,
    [string] $ExpectedPath
) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $lastObserved = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($process in (Get-InstalledBrowserProcesses $ExpectedPath)) {
            if ($ExcludedProcessIds -contains $process.Id) {
                continue
            }
            $process.Refresh()
            if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
                continue
            }
            $affinity = [uint32] 0
            if ([OroNimbusInstallerTestNative]::GetWindowDisplayAffinity($process.MainWindowHandle, [ref] $affinity)) {
                $lastObserved = $affinity
                if ($affinity -eq $ExpectedAffinity) {
                    return [pscustomobject]@{
                        Process = $process
                        Window = $process.MainWindowHandle
                        Affinity = $affinity
                    }
                }
            }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "OroNimbus did not expose the expected WDA value 0x$($ExpectedAffinity.ToString('X')) within 20 seconds. Last observed: $lastObserved"
}

function Set-LauncherCheckbox([IntPtr] $LauncherWindow, [int] $ControlId, [bool] $Checked) {
    $control = [OroNimbusInstallerTestNative]::GetDlgItem($LauncherWindow, $ControlId)
    if ($control -eq [IntPtr]::Zero) {
        throw "Launcher control $ControlId was not found."
    }
    $value = if ($Checked) { [UIntPtr]::new(1) } else { [UIntPtr]::Zero }
    [void] [OroNimbusInstallerTestNative]::SendMessage($control, 0x00F1, $value, [IntPtr]::Zero)
}

function Stop-TestBrowserProcesses([int[]] $PreservedProcessIds) {
    foreach ($process in (Get-InstalledBrowserProcesses)) {
        if ($PreservedProcessIds -contains $process.Id) {
            continue
        }
        try {
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
                [void] [OroNimbusInstallerTestNative]::PostMessage($process.MainWindowHandle, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)
            }
        }
        catch {
        }
    }
    Start-Sleep -Seconds 2
    foreach ($process in (Get-InstalledBrowserProcesses)) {
        if ($PreservedProcessIds -notcontains $process.Id) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

$preexistingProcessIds = @(Get-InstalledBrowserProcesses | Select-Object -ExpandProperty Id)
$launcher = Start-Process -FilePath $launcherPath -WorkingDirectory $env:WINDIR -PassThru
$results = [System.Collections.Generic.List[object]]::new()

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $launcher.Refresh()
    } while ($launcher.MainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)

    if ($launcher.MainWindowHandle -eq [IntPtr]::Zero) {
        throw 'The installed OroWdaLauncher did not create its controller window.'
    }

    $modes = @(
        [pscustomobject]@{ Name = 'NONE'; ButtonId = [uint32] 1103; Affinity = [uint32] 0x00 },
        [pscustomobject]@{ Name = 'MONITOR'; ButtonId = [uint32] 1102; Affinity = [uint32] 0x01 },
        [pscustomobject]@{ Name = 'EXCLUDE'; ButtonId = [uint32] 1101; Affinity = [uint32] 0x11 }
    )
    $architectures = @(
        [pscustomobject]@{ Name = 'NATIVE'; X86 = $false; BrowserPath = $browserPath },
        [pscustomobject]@{ Name = 'X86'; X86 = $true; BrowserPath = $x86BrowserPath }
    )

    foreach ($architecture in $architectures) {
        Set-LauncherCheckbox $launcher.MainWindowHandle 1109 $architecture.X86
        Set-LauncherCheckbox $launcher.MainWindowHandle 1110 $true
        foreach ($mode in $modes) {
            $beforeLaunch = @(Get-InstalledBrowserProcesses | Select-Object -ExpandProperty Id)
            $posted = [OroNimbusInstallerTestNative]::PostMessage(
                $launcher.MainWindowHandle,
                0x0111,
                [UIntPtr]::new($mode.ButtonId),
                [IntPtr]::Zero
            )
            if (-not $posted) {
                throw "Could not invoke the installed launcher's $($architecture.Name) $($mode.Name) button."
            }

            $browser = Wait-ForMainWindow $beforeLaunch $mode.Affinity $architecture.BrowserPath
            [uint32] $cigFlags = 0
            $cigReadOk = [OroNimbusInstallerTestNative]::GetProcessMitigationPolicy(
                $browser.Process.Handle,
                8,
                [ref] $cigFlags,
                [UIntPtr]::new(4)
            )
            if (-not $cigReadOk -or ($cigFlags -band 0x01) -eq 0) {
                $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw "CIG MicrosoftSignedOnly was not active for $($architecture.Name) $($mode.Name): flags 0x$($cigFlags.ToString('X')), Win32 error $lastError."
            }
            $results.Add([pscustomobject]@{
                Architecture = $architecture.Name
                Mode = $mode.Name
                ProcessId = $browser.Process.Id
                Affinity = ('0x{0:X}' -f $browser.Affinity)
                CigFlags = ('0x{0:X}' -f $cigFlags)
                BrowserPath = $browser.Process.Path
            })
            Stop-TestBrowserProcesses $preexistingProcessIds
        }
    }
}
finally {
    Stop-TestBrowserProcesses $preexistingProcessIds
    try {
        $launcher.Refresh()
        if (-not $launcher.HasExited -and $launcher.MainWindowHandle -ne [IntPtr]::Zero) {
            [void] [OroNimbusInstallerTestNative]::PostMessage($launcher.MainWindowHandle, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero)
            if (-not $launcher.WaitForExit(3000)) {
                Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
    }
}

$results
