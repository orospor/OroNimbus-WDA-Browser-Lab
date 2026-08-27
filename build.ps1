[CmdletBinding()]
param(
    [ValidateSet("arm64", "x64")]
    [string] $Architecture = "arm64"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$rustTarget = if ($Architecture -eq "arm64") {
    "aarch64-pc-windows-msvc"
} else {
    "x86_64-pc-windows-msvc"
}

function Assert-Success([string] $Operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Remove-GeneratedDirectory([string] $Path, [string] $ExpectedParent) {
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $resolvedParent = [System.IO.Path]::GetFullPath($ExpectedParent).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove generated directory outside $resolvedParent"
    }
    if (Test-Path -LiteralPath $resolvedPath) {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
}

Push-Location $projectRoot
try {
    $version = [string] (Get-Content -Raw -Encoding UTF8 package.json | ConvertFrom-Json).version
    $artifactRoot = Join-Path $projectRoot "artifacts"
    $bundleName = "OroNimbus-WDA-Browser-Lab-v$version-win-$Architecture"
    $bundleRoot = Join-Path $artifactRoot $bundleName
    $archivePath = Join-Path $artifactRoot "$bundleName.zip"
    $checksumPath = "$archivePath.sha256.txt"

    npm ci --ignore-scripts
    Assert-Success "npm ci"

    npx node-gyp rebuild --target=43.4.1 --arch=$Architecture --dist-url=https://electronjs.org/headers
    Assert-Success "Building the native WDA module"

    $nativeAddon = Join-Path $projectRoot "build\Release\wda_native.node"
    if (-not (Test-Path -LiteralPath $nativeAddon -PathType Leaf)) {
        throw "Native module was not produced at $nativeAddon"
    }
    $nativeText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($nativeAddon))
    if ($nativeText.IndexOf("C:\Users\", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "Native module contains a local user-profile path. Refusing to package it."
    }

    node .\pack.mjs $Architecture
    Assert-Success "Packaging the Electron browser"

    cargo build --manifest-path .\launcher\Cargo.toml --release --locked --target $rustTarget
    Assert-Success "Building the launcher"

    New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
    Remove-GeneratedDirectory -Path $bundleRoot -ExpectedParent $artifactRoot
    New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null

    $browserSource = Join-Path $projectRoot "dist\OroNimbus-win32-$Architecture"
    $launcherSource = Join-Path $projectRoot "launcher\target\$rustTarget\release\orowda-launcher.exe"
    if (-not (Test-Path -LiteralPath $browserSource -PathType Container)) {
        throw "Packaged browser was not found at $browserSource"
    }
    if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
        throw "Launcher was not found at $launcherSource"
    }

    Copy-Item -LiteralPath $browserSource -Destination (Join-Path $bundleRoot "OroNimbus") -Recurse
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $bundleRoot "OroWdaLauncher.exe")
    Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $bundleRoot
    Copy-Item -LiteralPath (Join-Path $projectRoot "VERIFICATION.md") -Destination $bundleRoot

    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    if (Test-Path -LiteralPath $checksumPath) {
        Remove-Item -LiteralPath $checksumPath -Force
    }
    Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $checksumPath -Encoding ascii -Value "$hash  $([System.IO.Path]::GetFileName($archivePath))"

    Write-Host "Created $archivePath"
    Write-Host "Created $checksumPath"
}
finally {
    Pop-Location
}
