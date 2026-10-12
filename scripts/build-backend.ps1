$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = Join-Path $repositoryRoot "backend\.venv\Scripts\python.exe"
$backendEntryPoint = Join-Path $repositoryRoot "backend\desktop.py"
$defaultConfiguration = Join-Path $repositoryRoot "shared\examples\config.v1.json"
$v2ConfigurationSchema = Join-Path $repositoryRoot "shared\schemas\v2\config.schema.json"
$outputDirectory = Join-Path $repositoryRoot "frontend\src-tauri\target\backend-dist"
$workDirectory = Join-Path $repositoryRoot "frontend\src-tauri\target\pyinstaller"

if (-not (Test-Path $python)) {
    throw "Backend Python was not found. Create backend\.venv and install backend\requirements-build.txt first."
}

if (-not (Test-Path $defaultConfiguration)) {
    throw "The default configuration resource was not found: $defaultConfiguration"
}

if (-not (Test-Path $v2ConfigurationSchema)) {
    throw "The shared v2 configuration schema was not found: $v2ConfigurationSchema"
}

New-Item -ItemType Directory -Force -Path $outputDirectory, $workDirectory | Out-Null

& $python -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --console `
    --name pocketdeck-backend `
    --distpath $outputDirectory `
    --workpath $workDirectory `
    --specpath $workDirectory `
    --paths (Join-Path $repositoryRoot "backend") `
    --add-data "$defaultConfiguration;shared\examples" `
    --add-data "$v2ConfigurationSchema;shared\schemas\v2" `
    --collect-all websockets `
    $backendEntryPoint

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed to build the PocketDeck backend executable (exit code $LASTEXITCODE)."
}

$executable = Join-Path $outputDirectory "pocketdeck-backend\pocketdeck-backend.exe"
if (-not (Test-Path $executable)) {
    throw "PyInstaller reported success but did not create $executable."
}

Write-Output "Built $executable"
