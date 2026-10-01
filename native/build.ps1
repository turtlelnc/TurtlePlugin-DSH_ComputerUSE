# TurtlePlugin-DSH_ComputerUSE — build the native driver.
#
# Compiles native/src/*.cs with the in-box .NET Framework C# compiler, so a
# plugin install needs no SDK, no NuGet restore and no network. The output is a
# single self-contained TurtleComputerUse.exe next to the plugin's lib/ folder.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File native/build.ps1
#   powershell -ExecutionPolicy Bypass -File native/build.ps1 -OutputDir lib/native
[CmdletBinding()]
param(
    [string]$OutputDir = "",
    [switch]$Force,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $root 'lib\native' }
elseif (-not [System.IO.Path]::IsPathRooted($OutputDir)) { $OutputDir = Join-Path $root $OutputDir }

function Write-Step([string]$message) { if (-not $Quiet) { Write-Host "[turtle-native] $message" } }

# ---------------------------------------------------------------- locate csc.exe
$candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
    throw "The in-box .NET Framework C# compiler (csc.exe 4.0.30319) was not found. Install .NET Framework 4.x, or run the plugin with driverPath pointing at a prebuilt TurtleComputerUse.exe."
}
Write-Step "compiler: $csc"

# ---------------------------------------------------------------- locate sources
$srcDir = Join-Path $root 'native\src'
$sources = Get-ChildItem -Path $srcDir -Filter *.cs -File | Sort-Object Name
if ($sources.Count -eq 0) { throw "No C# sources found in $srcDir" }
$manifest = Join-Path $root 'native\app.manifest'

# ---------------------------------------------------------------- locate references
$fwDir = Split-Path -Parent $csc
$refNames = @(
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Web.Extensions.dll',
    'System.Xml.dll',
    'WindowsBase.dll',
    'Accessibility.dll',
    'UIAutomationClient.dll',
    'UIAutomationTypes.dll'
)

# Prefer the .NET Framework reference assemblies when a targeting pack is
# installed: they carry the full WPF/UIA surface that the runtime directory
# only exposes through the GAC.
$refRoots = New-Object System.Collections.Generic.List[string]
$refBase = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework'
if (Test-Path $refBase) {
    Get-ChildItem $refBase -Directory |
        Sort-Object { try { [version]($_.Name.TrimStart('v')) } catch { [version]'0.0' } } -Descending |
        ForEach-Object { $refRoots.Add($_.FullName) }
}
$refRoots.Add($fwDir)
$gac = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL'

$refs = @()
$resolved = @{}
foreach ($name in $refNames) {
    $path = $null
    foreach ($root in $refRoots) {
        $candidate = Join-Path $root $name
        if (Test-Path $candidate) { $path = $candidate; break }
    }
    if (-not $path) {
        $match = Get-ChildItem $gac -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq $name.TrimEnd('.dll') } |
            ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter $name -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($match) { $path = $match.FullName }
    }
    if ($path) { $refs += "/r:$path"; $resolved[$name] = $path }
    else { Write-Step "WARNING reference not found: $name" }
}
Write-Step "references: $($resolved.Count)/$($refNames.Count) resolved"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outFile = Join-Path $OutputDir 'TurtleComputerUse.exe'

if ((Test-Path $outFile) -and -not $Force) {
    $newestSource = ($sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    if ((Get-Item $outFile).LastWriteTime -ge $newestSource) {
        Write-Step "up to date: $outFile"
        exit 0
    }
}

# ---------------------------------------------------------------- compile
# The in-box .NET Framework compiler is C# 5 (Roslyn only ships with a
# developer image), so native/src stays C# 5 clean on purpose: no expression
# bodies, no `out var`, no string interpolation. See native/README.md.
$argsList = @(
    '/nologo',
    # Ignore csc.rsp: it references the framework directory's copies of
    # System/System.Core/... which then collide (CS1703) with the reference
    # assemblies resolved above.
    '/noconfig',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/warn:4',
    '/utf8output',
    '/langversion:5',
    "/out:$outFile"
)
if (Test-Path $manifest) { $argsList += "/win32manifest:$manifest" }
$argsList += $refs
$argsList += ($sources | ForEach-Object { $_.FullName })

Write-Step "compiling $($sources.Count) source files -> $outFile"
$output = & $csc @argsList 2>&1
$exit = $LASTEXITCODE
if ($output) { $output | Where-Object { $_ -notmatch '^Microsoft \(R\)' } | ForEach-Object { Write-Host $_ } }
if ($exit -ne 0) { throw "csc exited with code $exit" }
if (-not (Test-Path $outFile)) { throw "csc reported success but $outFile does not exist" }

# ---------------------------------------------------------------- deterministic stamp
# Rebuilds must be reproducible enough that a plugin update is observable, and a
# committed executable whose sources have since changed must be detectable. A
# content digest of the sources is used rather than timestamps, because a fresh
# git clone gives every file the same mtime and would make an mtime comparison
# meaningless.
$hash = (Get-FileHash -Algorithm SHA256 $outFile).Hash
$sourceDigestInput = ($sources |
    Sort-Object Name |
    ForEach-Object { "$($_.Name):$((Get-FileHash -Algorithm SHA256 $_.FullName).Hash)" }) -join "`n"
$sourceDigest = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($sourceDigestInput))).Replace('-', '').ToLowerInvariant()

$stamp = [ordered]@{
    name            = 'TurtleComputerUse'
    version         = '0.1.0-rc1'
    builtAtUtc      = (Get-Date).ToUniversalTime().ToString('o')
    sha256          = $hash
    sizeBytes       = (Get-Item $outFile).Length
    compiler        = $csc
    sources         = ($sources | ForEach-Object { $_.Name })
    sourcesSha256   = $sourceDigest
}
$stampPath = Join-Path $OutputDir 'TurtleComputerUse.build.json'
# Written without a BOM: this file is read back by Node, whose JSON.parse rejects one.
[System.IO.File]::WriteAllText($stampPath, ($stamp | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Write-Step "built $outFile ($((Get-Item $outFile).Length) bytes, sha256 $($hash.Substring(0,16))...)"
Write-Step "stamp: $stampPath"
exit 0
