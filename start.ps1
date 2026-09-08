param(
    [int]$Port = 8000,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$projectDir = $PSScriptRoot
$python = Join-Path $projectDir ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "Virtual environment not found. Run .\install.ps1 first." -ForegroundColor Yellow
    exit 1
}

$env:TEMP = Join-Path $projectDir ".tmp"
$env:TMP = Join-Path $projectDir ".tmp"
$env:MODELSCOPE_CACHE = Join-Path $projectDir "data\models\modelscope"
$env:HF_HOME = Join-Path $projectDir "data\models\huggingface"
$env:TORCH_HOME = Join-Path $projectDir "data\models\torch"
$env:XDG_CACHE_HOME = Join-Path $projectDir ".cache"
New-Item -ItemType Directory -Force -Path $env:TEMP, $env:MODELSCOPE_CACHE, $env:HF_HOME, $env:TORCH_HOME | Out-Null

Set-Location $projectDir
Write-Host "SenseVoice Studio: http://${HostAddress}:$Port" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
& $python -m uvicorn app.main:app --host $HostAddress --port $Port

