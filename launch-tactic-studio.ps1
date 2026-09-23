param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'insight'
$python = Join-Path $project '.venv\Scripts\python.exe'
$backend = Join-Path $project 'backend'
$frontend = Join-Path $project 'frontend'
if (-not (Test-Path -LiteralPath $python)) {
    throw 'The Insight Python runtime is missing. Run insight\packaging\demoparser-lean\setup-backend-dev.ps1 first.'
}
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$backendProcess = $null
$frontendProcess = $null
try {
    $backendProcess = Start-Process -FilePath $python -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000') -WorkingDirectory $backend -WindowStyle Hidden -PassThru
    $frontendProcess = Start-Process -FilePath $pnpm -ArgumentList @('run','dev','--host','127.0.0.1') -WorkingDirectory $frontend -WindowStyle Hidden -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/docs' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'The tactical backend did not become ready within 30 seconds.' }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/tactics' }
    Write-Host 'CS2 Tactic Studio is running. Press Ctrl+C to stop both local services.'
    while (-not $backendProcess.HasExited -and -not $frontendProcess.HasExited) {
        Start-Sleep -Milliseconds 500
    }
} finally {
    foreach ($child in @($frontendProcess, $backendProcess)) {
        if ($null -ne $child -and -not $child.HasExited) {
            Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
