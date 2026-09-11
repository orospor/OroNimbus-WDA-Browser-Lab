[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $Version,

    [string] $WixPath,

    [string] $BalExtensionPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerRoot = Join-Path $repositoryRoot 'installer'
$artifactsRoot = Join-Path $repositoryRoot 'artifacts'
$installerArtifactsRoot = Join-Path $artifactsRoot 'universal-installer'
$packageRoot = Join-Path $installerArtifactsRoot 'packages'
$intermediateRoot = Join-Path $installerArtifactsRoot 'intermediate'
$releaseRoot = Join-Path $repositoryRoot 'release'

function Assert-LastCommand([string] $Operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Remove-OwnedDirectory([string] $Path) {
    $resolvedOwner = [System.IO.Path]::GetFullPath($installerArtifactsRoot).TrimEnd('\') + '\'
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedOwner, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a directory outside $resolvedOwner"
    }
    if (Test-Path -LiteralPath $resolvedPath) {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
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

function Assert-PeMachine(
    [string] $Path,
    [uint16] $ExpectedMachine,
    [string] $Architecture
) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Architecture payload file was not found at $Path"
    }
    $actualMachine = Get-PeMachine $Path
    if ($actualMachine -ne $ExpectedMachine) {
        throw ('Expected {0} PE machine 0x{1:X4}, found 0x{2:X4} at {3}' -f $Architecture, $ExpectedMachine, $actualMachine, $Path)
    }
}

function Get-StableWixId([string] $Prefix, [string] $Value) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $algorithm.ComputeHash($bytes)
    }
    finally {
        $algorithm.Dispose()
    }
    $hex = ([System.BitConverter]::ToString($hash)).Replace('-', '')
    return "${Prefix}_$($hex.Substring(0, 24))"
}

function ConvertTo-WixAttribute([string] $Value) {
    return [System.Security.SecurityElement]::Escape($Value)
}

function Get-RelativePath([string] $BasePath, [string] $TargetPath) {
    $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $targetFullPath = [System.IO.Path]::GetFullPath($TargetPath)
    $baseUri = [System.Uri]::new($baseFullPath)
    $targetUri = [System.Uri]::new($targetFullPath)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

function Write-PayloadFragment(
    [string] $SourceRoot,
    [string] $DestinationPath,
    [string] $DestinationSubdirectory = ''
) {
    $componentIds = [System.Collections.Generic.List[string]]::new()
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('<?xml version="1.0" encoding="utf-8"?>')
    $lines.Add('<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">')
    $lines.Add('  <Fragment>')
    $lines.Add('    <DirectoryRef Id="INSTALLFOLDER">')

    $payloadIndent = 6
    if (-not [string]::IsNullOrWhiteSpace($DestinationSubdirectory)) {
        $destinationDirectoryId = Get-StableWixId 'D' "install/$DestinationSubdirectory"
        $destinationDirectoryName = ConvertTo-WixAttribute $DestinationSubdirectory
        $lines.Add("      <Directory Id=`"$destinationDirectoryId`" Name=`"$destinationDirectoryName`">")
        $payloadIndent = 8
    }

    function Add-PayloadDirectory([string] $DirectoryPath, [string] $RelativeDirectory, [int] $IndentLevel) {
        $contentIndent = ' ' * $IndentLevel
        if (-not [string]::IsNullOrEmpty($RelativeDirectory)) {
            $directoryId = Get-StableWixId 'D' $RelativeDirectory
            $directoryName = ConvertTo-WixAttribute ([System.IO.Path]::GetFileName($DirectoryPath))
            $lines.Add("$contentIndent<Directory Id=`"$directoryId`" Name=`"$directoryName`">")
            $IndentLevel += 2
            $contentIndent = ' ' * $IndentLevel
        }

        foreach ($file in (Get-ChildItem -LiteralPath $DirectoryPath -File | Sort-Object Name)) {
            $relativeFile = (Get-RelativePath $SourceRoot $file.FullName).Replace('\', '/')
            if ($relativeFile -ieq 'OroWdaLauncher.exe') {
                continue
            }
            $componentId = Get-StableWixId 'C' $relativeFile
            $fileId = Get-StableWixId 'F' $relativeFile
            $source = ConvertTo-WixAttribute $file.FullName
            $name = ConvertTo-WixAttribute $file.Name
            $lines.Add("$contentIndent<Component Id=`"$componentId`" Guid=`"*`">")
            $lines.Add("$contentIndent  <File Id=`"$fileId`" Source=`"$source`" Name=`"$name`" KeyPath=`"yes`" />")
            $lines.Add("$contentIndent</Component>")
            $componentIds.Add($componentId)
        }

        foreach ($directory in (Get-ChildItem -LiteralPath $DirectoryPath -Directory | Sort-Object Name)) {
            $relativeChild = (Get-RelativePath $SourceRoot $directory.FullName).Replace('\', '/')
            Add-PayloadDirectory $directory.FullName $relativeChild $IndentLevel
        }

        if (-not [string]::IsNullOrEmpty($RelativeDirectory)) {
            $IndentLevel -= 2
            $contentIndent = ' ' * $IndentLevel
            $lines.Add("$contentIndent</Directory>")
        }
    }

    Add-PayloadDirectory $SourceRoot '' $payloadIndent
    if (-not [string]::IsNullOrWhiteSpace($DestinationSubdirectory)) {
        $lines.Add('      </Directory>')
    }
    $lines.Add('    </DirectoryRef>')
    $lines.Add('  </Fragment>')
    $lines.Add('  <Fragment>')
    $lines.Add('    <ComponentGroup Id="PayloadFiles">')
    foreach ($componentId in $componentIds) {
        $lines.Add("      <ComponentRef Id=`"$componentId`" />")
    }
    $lines.Add('    </ComponentGroup>')
    $lines.Add('  </Fragment>')
    $lines.Add('</Wix>')

    Set-Content -LiteralPath $DestinationPath -Value $lines -Encoding UTF8
}

function Assert-FullBrowserPayload(
    [string] $SourceRoot,
    [uint16] $ExpectedMachine,
    [string] $Architecture
) {
    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        throw "$Architecture bundle was not found at $SourceRoot. Run .\build.ps1 -Architecture $Architecture first."
    }

    $requiredFiles = @(
        'OroWdaLauncher.exe',
        'OroNimbus\OroNimbus.exe',
        'OroNimbus\resources\app.asar',
        'OroNimbus\resources\app.asar.unpacked\native\wda_native.node',
        'README.md',
        'VERIFICATION.md',
        'DEFENSE-EVIDENCE.md'
    )
    foreach ($relativePath in $requiredFiles) {
        $fullPath = Join-Path $SourceRoot $relativePath
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "$Architecture bundle is incomplete: $relativePath is missing from $SourceRoot"
        }
    }

    Assert-PeMachine (Join-Path $SourceRoot 'OroWdaLauncher.exe') $ExpectedMachine $Architecture
    Assert-PeMachine (Join-Path $SourceRoot 'OroNimbus\OroNimbus.exe') $ExpectedMachine $Architecture
    Assert-PeMachine (Join-Path $SourceRoot 'OroNimbus\resources\app.asar.unpacked\native\wda_native.node') $ExpectedMachine $Architecture

    $fileCount = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File).Count
    # The official ia32 Electron package omits two shader-compiler files that
    # are present in the 64-bit distributions.
    $minimumFileCount = if ($Architecture -eq 'ia32') { 78 } else { 80 }
    if ($fileCount -lt $minimumFileCount) {
        throw "$Architecture bundle has only $fileCount files; the complete v$Version $Architecture payload has at least $minimumFileCount."
    }

    $payloadBytes = (Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum
    # Electron's complete Windows ia32 distribution is smaller than its x64 and
    # ARM64 counterparts. Required-file and PE-machine checks above remain the
    # authoritative completeness checks; this floor only catches partial copies.
    $minimumPayloadBytes = if ($Architecture -eq 'ia32') { 275MB } else { 350MB }
    if ($payloadBytes -lt $minimumPayloadBytes) {
        throw "$Architecture bundle is unexpectedly small ($payloadBytes bytes); refusing to build a partial browser installer."
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $packageJson = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
    $Version = [string] $packageJson.version
}

if ([string]::IsNullOrWhiteSpace($WixPath)) {
    $wixCommand = Get-Command wix.exe -ErrorAction SilentlyContinue
    if ($null -eq $wixCommand) {
        throw 'WiX 4 was not found. Install the WiX .NET tool, then run this script again.'
    }
    $WixPath = $wixCommand.Source
}
else {
    $WixPath = (Resolve-Path -LiteralPath $WixPath).Path
}

if ([string]::IsNullOrWhiteSpace($BalExtensionPath)) {
    $extensionRoots = @(
        (Join-Path $env:USERPROFILE '.wix\extensions\WixToolset.Bal.wixext'),
        (Join-Path (Split-Path (Split-Path (Split-Path $WixPath -Parent) -Parent) -Parent) '.wix\extensions\WixToolset.Bal.wixext')
    ) | Select-Object -Unique
    $balExtension = $extensionRoots |
        Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'WixToolset.Bal.wixext.dll' -File -Recurse } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($null -eq $balExtension) {
        throw 'WixToolset.Bal.wixext was not found. Run: wix extension add WixToolset.Bal.wixext/4.0.5'
    }
    $BalExtensionPath = $balExtension.FullName
}
else {
    $BalExtensionPath = (Resolve-Path -LiteralPath $BalExtensionPath).Path
}

$payloads = @{
    x64 = [pscustomobject]@{
        SourceRoot = Join-Path $artifactsRoot "OroNimbus-WDA-Browser-Lab-v$Version-win-x64"
        Machine = [uint16] 0x8664
        PackageUpgradeCode = '{F98AF1B3-7155-4D06-A500-0D2BCAAB8865}'
        LauncherComponentGuid = '{B69172DF-DD40-4CFE-A21B-B7A951565698}'
    }
    arm64 = [pscustomobject]@{
        SourceRoot = Join-Path $artifactsRoot "OroNimbus-WDA-Browser-Lab-v$Version-win-arm64"
        Machine = [uint16] 0xAA64
        PackageUpgradeCode = '{AD85ACD7-66DF-4B56-BA33-2678EFEB358C}'
        LauncherComponentGuid = '{EEE20761-A7A0-40D7-8F02-54F3878C5470}'
    }
    ia32 = [pscustomobject]@{
        SourceRoot = Join-Path $artifactsRoot "OroNimbus-WDA-Browser-Lab-v$Version-win-ia32"
        Machine = [uint16] 0x014C
        PackageUpgradeCode = '{DD2F0B46-2D24-48F1-AE47-D60C8AB376F1}'
    }
}

foreach ($architecture in @('x64', 'arm64', 'ia32')) {
    Assert-FullBrowserPayload $payloads[$architecture].SourceRoot $payloads[$architecture].Machine $architecture
}

Remove-OwnedDirectory $packageRoot
Remove-OwnedDirectory $intermediateRoot
New-Item -ItemType Directory -Path $packageRoot, $intermediateRoot, $releaseRoot -Force | Out-Null

$builtPackages = @{}
foreach ($architecture in @('x64', 'arm64')) {
    $payload = $payloads[$architecture]
    $msiPath = Join-Path $packageRoot "OroNimbus-WDA-Browser-Lab-v$Version-$architecture.msi"
    $intermediatePath = Join-Path $intermediateRoot $architecture
    New-Item -ItemType Directory -Path $intermediatePath -Force | Out-Null
    $payloadFragment = Join-Path $intermediatePath 'PayloadFiles.wxs'
    Write-PayloadFragment $payload.SourceRoot $payloadFragment

    $packageArguments = @(
        'build', (Join-Path $installerRoot 'Package.wxs'), $payloadFragment,
        '-arch', $architecture,
        '-d', "ProductVersion=$Version",
        '-d', "SourceRoot=$($payload.SourceRoot)",
        '-d', "PackageUpgradeCode=$($payload.PackageUpgradeCode)",
        '-d', "LauncherComponentGuid=$($payload.LauncherComponentGuid)",
        '-intermediatefolder', $intermediatePath,
        '-pdbtype', 'none',
        '-out', $msiPath
    )
    & $WixPath @packageArguments
    Assert-LastCommand "Building the $architecture MSI"
    $builtPackages[$architecture] = $msiPath
}

$ia32Payload = $payloads['ia32']
$ia32MsiPath = Join-Path $packageRoot "OroNimbus-WDA-Browser-Lab-v$Version-ia32-companion.msi"
$ia32IntermediatePath = Join-Path $intermediateRoot 'ia32'
New-Item -ItemType Directory -Path $ia32IntermediatePath -Force | Out-Null
$ia32PayloadFragment = Join-Path $ia32IntermediatePath 'PayloadFiles.wxs'
Write-PayloadFragment `
    -SourceRoot (Join-Path $ia32Payload.SourceRoot 'OroNimbus') `
    -DestinationPath $ia32PayloadFragment `
    -DestinationSubdirectory 'OroNimbus-x86'

$ia32PackageArguments = @(
    'build', (Join-Path $installerRoot 'X86CompanionPackage.wxs'), $ia32PayloadFragment,
    '-arch', 'x86',
    '-d', "ProductVersion=$Version",
    '-d', "PackageUpgradeCode=$($ia32Payload.PackageUpgradeCode)",
    '-intermediatefolder', $ia32IntermediatePath,
    '-pdbtype', 'none',
    '-out', $ia32MsiPath
)
& $WixPath @ia32PackageArguments
Assert-LastCommand 'Building the shared x86 browser companion MSI'
$builtPackages['ia32'] = $ia32MsiPath

$setupName = "OroNimbus-WDA-Browser-Lab-v$Version-Setup-universal.exe"
$setupPath = Join-Path $releaseRoot $setupName
$bundleIntermediate = Join-Path $intermediateRoot 'bundle'
New-Item -ItemType Directory -Path $bundleIntermediate -Force | Out-Null
$bundleArguments = @(
    'build', (Join-Path $installerRoot 'Bundle.wxs'),
    '-arch', 'x86',
    '-ext', $BalExtensionPath,
    '-d', "ProductVersion=$Version",
    '-d', "X64Msi=$($builtPackages['x64'])",
    '-d', "Arm64Msi=$($builtPackages['arm64'])",
    '-d', "Ia32Msi=$($builtPackages['ia32'])",
    '-intermediatefolder', $bundleIntermediate,
    '-pdbtype', 'none',
    '-out', $setupPath
)
& $WixPath @bundleArguments
Assert-LastCommand 'Building the universal setup bundle'

$setupHash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$setupPath.sha256.txt"
Set-Content -LiteralPath $checksumPath -Value "$setupHash  $setupName" -Encoding ascii

Write-Host "Created $setupPath"
Write-Host "Created $checksumPath"
Write-Warning 'The setup is unsigned. Windows SmartScreen or Unknown publisher warnings are expected.'
