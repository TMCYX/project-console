<#
  install.ps1 — Project Console installer (Windows / PowerShell).

  Idempotent: safe to re-run. It will:
    1) verify node + npm are available,
    2) npm install in the app directory,
    3) copy agents/* -> ~/.config/opencode/agent/  (the Project-Manager mode),
    4) copy skills/* -> ~/.config/opencode/skills/ (the project-management skill),
    5) print the next steps (launch + data root).

  Usage:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg)       { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Step "Project Console installer"
Write-Host "    app dir: $AppDir"

# --- 1. node + npm ----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node not found on PATH. Install Node.js LTS:  winget install OpenJS.NodeJS.LTS"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm not found on PATH. Install Node.js LTS:  winget install OpenJS.NodeJS.LTS"
}
$nodeVersion = (& node --version).Trim()
Write-Ok "node $nodeVersion"

# --- 2. npm install ---------------------------------------------------------
Write-Step "Installing app dependencies (npm install)"
Push-Location $AppDir
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}
Write-Ok "dependencies installed"

# --- 3 + 4. bundle mode + skill --------------------------------------------
$ConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
$AgentDir  = Join-Path $ConfigDir "agent"
$SkillDir  = Join-Path $ConfigDir "skills"

Write-Step "Installing AI mode + skill into $ConfigDir"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null

$agentsSrc = Join-Path $AppDir "agents"
if (Test-Path $agentsSrc) {
  Get-ChildItem -Path $agentsSrc -Force | ForEach-Object {
    Copy-Item -Recurse -Force -Path $_.FullName -Destination $AgentDir
  }
  Write-Ok "agents -> $AgentDir"
} else {
  Write-Warn2 "no agents/ folder found (skipped)"
}

$skillsSrc = Join-Path $AppDir "skills"
if (Test-Path $skillsSrc) {
  Get-ChildItem -Path $skillsSrc -Force | ForEach-Object {
    Copy-Item -Recurse -Force -Path $_.FullName -Destination $SkillDir
  }
  Write-Ok "skills -> $SkillDir"
} else {
  Write-Warn2 "no skills/ folder found (skipped)"
}

# --- 5. next steps ----------------------------------------------------------
Write-Host ""
Write-Step "Done."
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1) Launch the app:"
Write-Host "       cd `"$AppDir`"; npm start" -ForegroundColor Gray
Write-Host "  2) Data root (each subfolder with a plan.json is a project):"
Write-Host "       default: C:\Users\<you>\.claude\wiki\projects\" -ForegroundColor Gray
Write-Host "       override: `$env:PROJECT_CONSOLE_ROOT='D:\path\to\projects'; npm start" -ForegroundColor Gray
Write-Host "  3) Team sync: open a project -> Sync menu, or dashboard -> 加入 Git 專案." -ForegroundColor Gray
Write-Host "  4) Optional — create the private repo with the gh CLI:"
Write-Host "       winget install GitHub.cli`n       gh auth login" -ForegroundColor Gray
