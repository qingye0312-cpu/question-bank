# Run from any directory: powershell -File windows/scripts/build-portable.ps1
# Requires the normal Windows build prerequisites; does not install the app.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This build script requires Windows.' }
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'env.ps1')

Push-Location $projectRoot
try {
    # Use the same platform settings and locked dependencies as the installer.
    & node scripts/tauri.mjs build --target x86_64-pc-windows-msvc --no-bundle -- --locked
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)." }

    $metadataText = & cargo metadata --no-deps --format-version 1 --locked --manifest-path desktop/src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate the Cargo output directory.' }
    $metadata = $metadataText | ConvertFrom-Json
    $source = Join-Path $metadata.target_directory 'x86_64-pc-windows-msvc\release\question-bank.exe'
    # Read the actual PE architecture instead of labelling an ARM or x86 binary x64.
    $bytes = [System.IO.File]::ReadAllBytes($source)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
    if ($machine -ne 0x8664) { throw 'Only the Windows x64 portable build is validated by this script.' }

    $version = (Get-Content -LiteralPath package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $delivery = Join-Path $projectRoot '交付'
    New-Item -ItemType Directory -Force -Path $delivery | Out-Null
    $name = "题库_${version}_x64-portable.exe"
    $destination = Join-Path $delivery $name
    Copy-Item -LiteralPath $source -Destination $destination
    # Use .NET directly: nested Windows PowerShell may inherit a PowerShell 7
    # module path where Get-FileHash is unavailable.
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($destination)
    try {
        $sha256 = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText("$destination.sha256", "$sha256  $name`n", $utf8)
    Write-Output "Portable executable: $destination"
    Write-Output "Bytes: $((Get-Item -LiteralPath $destination).Length)"
    Write-Output "SHA256: $sha256"
    Write-Output 'Requires an existing Microsoft Edge WebView2 Runtime. App data stays in the normal user profile.'
} finally {
    Pop-Location
}
