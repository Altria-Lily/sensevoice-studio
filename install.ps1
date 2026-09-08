param(
    [switch]$Cpu,
    [switch]$OfficialSource,
    [ValidateSet("cu126", "cu128", "cu130")]
    [string]$Cuda = "cu128"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = $PSScriptRoot
$venvDir = Join-Path $projectDir ".venv"
$cacheDir = Join-Path $projectDir ".cache"
$tempDir = Join-Path $projectDir ".tmp"
$modelDir = Join-Path $projectDir "data\models"

New-Item -ItemType Directory -Force -Path $cacheDir, $tempDir, $modelDir | Out-Null
$env:PIP_CACHE_DIR = Join-Path $cacheDir "pip"
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:MODELSCOPE_CACHE = Join-Path $modelDir "modelscope"
$env:HF_HOME = Join-Path $modelDir "huggingface"
$env:TORCH_HOME = Join-Path $modelDir "torch"

$pypiIndex = if ($OfficialSource) {
    "https://pypi.org/simple"
} else {
    "https://pypi.tuna.tsinghua.edu.cn/simple"
}
$pytorchBase = if ($OfficialSource) {
    "https://download.pytorch.org/whl"
} else {
    "https://mirrors.nju.edu.cn/pytorch/whl"
}

if (-not (Test-Path (Join-Path $venvDir "Scripts\python.exe"))) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        & py -3.11 -m venv $venvDir
        if ($LASTEXITCODE -ne 0) {
            & py -3.12 -m venv $venvDir
        }
    } else {
        & python -m venv $venvDir
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $venvDir "Scripts\python.exe"))) {
        throw "Unable to create .venv. Install Python 3.11 or 3.12 and try again."
    }
}

$python = Join-Path $venvDir "Scripts\python.exe"
& $python -m pip install --upgrade pip "setuptools<82" wheel --index-url $pypiIndex

$hasNvidia = $null -ne (Get-Command nvidia-smi -ErrorAction SilentlyContinue)
if ($Cpu -or -not $hasNvidia) {
    Write-Host "Installing CPU PyTorch..." -ForegroundColor Cyan
    & $python -m pip install torch torchaudio --index-url "$pytorchBase/cpu"
} else {
    Write-Host "Installing NVIDIA PyTorch ($Cuda)..." -ForegroundColor Cyan
    & $python -m pip install torch torchaudio --index-url "$pytorchBase/$Cuda"
}

& $python -m pip install -r (Join-Path $projectDir "requirements.txt") --index-url $pypiIndex
& $python -c "import torch, funasr; print('FunASR:', funasr.__version__); print('PyTorch:', torch.__version__); print('CUDA available:', torch.cuda.is_available())"

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Run: .\start.ps1"
Write-Host "Models will be downloaded to: $modelDir"
