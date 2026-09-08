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
foreach ($requiredPath in @($launcherPath, $browserPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required installed executable was not found at $requiredPath"
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
}
'@

function Get-InstalledBrowserProcesses {
    return @(Get-Process -Name 'OroNimbus' -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -ieq $browserPath
        }
        catch {
            $false
        }
    })
}

function Wait-ForMainWindow([int[]] $ExcludedProcessIds, [uint32] $ExpectedAffinity) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $lastObserved = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($process in (Get-InstalledBrowserProcesses)) {
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

    foreach ($mode in $modes) {
        $beforeLaunch = @(Get-InstalledBrowserProcesses | Select-Object -ExpandProperty Id)
        $posted = [OroNimbusInstallerTestNative]::PostMessage(
            $launcher.MainWindowHandle,
            0x0111,
            [UIntPtr]::new($mode.ButtonId),
            [IntPtr]::Zero
        )
        if (-not $posted) {
            throw "Could not invoke the installed launcher's $($mode.Name) button."
        }

        $browser = Wait-ForMainWindow $beforeLaunch $mode.Affinity
        $results.Add([pscustomobject]@{
            Mode = $mode.Name
            ProcessId = $browser.Process.Id
            Affinity = ('0x{0:X}' -f $browser.Affinity)
            BrowserPath = $browser.Process.Path
        })
        Stop-TestBrowserProcesses $preexistingProcessIds
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
