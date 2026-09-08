[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $Version = '0.4.0',

    [switch] $NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'OroNimbus WDA Browser Lab requires Windows.'
}

$nativeArchitecture = if (-not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
    $env:PROCESSOR_ARCHITEW6432
}
else {
    $env:PROCESSOR_ARCHITECTURE
}

if ([string]::IsNullOrWhiteSpace($nativeArchitecture)) {
    throw 'Windows did not report a processor architecture.'
}

$architecture = switch ($nativeArchitecture.ToUpperInvariant()) {
    'ARM64' { 'arm64' }
    'AMD64' { 'x64' }
    default { throw "Unsupported Windows architecture: $nativeArchitecture" }
}

$repository = 'orospor/OroNimbus-WDA-Browser-Lab'
$assetName = "OroNimbus-WDA-Browser-Lab-v$Version-Setup-universal.exe"
$releaseBase = "https://github.com/$repository/releases/download/v$Version"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "OroNimbus-$([guid]::NewGuid().ToString('N'))"
$setupPath = Join-Path $temporaryRoot $assetName
$checksumPath = "$setupPath.sha256.txt"
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\OroSpor\OroNimbus-WDA-Browser-Lab'

New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $setupPath
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName.sha256.txt" -OutFile $checksumPath

    $expectedHash = ((Get-Content -Raw -Encoding ASCII -LiteralPath $checksumPath).Trim() -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        throw 'OroNimbus download failed SHA-256 verification.'
    }

    $setupProcess = Start-Process -FilePath $setupPath -ArgumentList @('/quiet', '/norestart') -Wait -PassThru
    if ($setupProcess.ExitCode -notin @(0, 3010)) {
        throw "OroNimbus setup failed with exit code $($setupProcess.ExitCode)."
    }

    $launcherPath = Join-Path $installRoot 'OroWdaLauncher.exe'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "OroWdaLauncher.exe was not found after setup at $launcherPath"
    }

    Write-Host "Installed OroNimbus WDA Browser Lab $Version ($architecture) to $installRoot"
    if (-not $NoLaunch) {
        Start-Process -FilePath $launcherPath -WorkingDirectory $installRoot
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
