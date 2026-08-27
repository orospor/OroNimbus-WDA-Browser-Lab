[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $Version = '0.2.3',

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
$bundleName = "OroNimbus-WDA-Browser-Lab-v$Version-win-$architecture"
$assetName = "$bundleName.zip"
$releaseBase = "https://github.com/$repository/releases/download/v$Version"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "OroNimbus-$([guid]::NewGuid().ToString('N'))"
$archivePath = Join-Path $temporaryRoot $assetName
$checksumPath = "$archivePath.sha256.txt"
$installParent = Join-Path $env:LOCALAPPDATA 'Programs\OroNimbus-WDA-Browser-Lab'
$installRoot = Join-Path $installParent $bundleName

New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName.sha256.txt" -OutFile $checksumPath

    $expectedHash = ((Get-Content -Raw -Encoding ASCII -LiteralPath $checksumPath).Trim() -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        throw 'OroNimbus download failed SHA-256 verification.'
    }

    New-Item -ItemType Directory -Path $installParent -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $installParent -Force
    $launcherPath = Join-Path $installRoot 'OroWdaLauncher.exe'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "OroWdaLauncher.exe was not found after extraction at $launcherPath"
    }

    $programsFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $shortcutPath = Join-Path $programsFolder 'OroNimbus WDA Browser Lab.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcherPath
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = 'OroNimbus Windows Display Affinity research fixture'
    $shortcut.Save()

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
