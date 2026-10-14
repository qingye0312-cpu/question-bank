# Dot-source this file before using a workspace-local Rust installation:
# . .\scripts\env.ps1
$projectRoot = Split-Path -Parent $PSScriptRoot
$localCargo = Join-Path $projectRoot '.tooling\cargo'
$localRustup = Join-Path $projectRoot '.tooling\rustup'
if ((Test-Path -LiteralPath (Join-Path $localCargo 'bin\cargo.exe')) -and (Test-Path -LiteralPath $localRustup)) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = $localRustup
    $cargoBin = Join-Path $localCargo 'bin'
    if (($env:Path -split ';') -notcontains $cargoBin) {
        $env:Path = "$cargoBin;$env:Path"
    }
}
