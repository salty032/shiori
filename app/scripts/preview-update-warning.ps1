$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$installerInclude = Join-Path $appDir 'build\installer.nsh'
$buildResourcesDir = Join-Path $appDir 'build'
$cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis'
$compiler = Get-ChildItem -LiteralPath $cacheRoot -Filter 'makensis.exe' -File -Recurse |
  Where-Object { $_.FullName -match 'nsis-3\.0\.4\.1.*\\Bin\\makensis\.exe$' } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $compiler) {
  throw "NSIS 3.0.4.1 was not found in $cacheRoot. Build the package once to populate the electron-builder cache."
}

$previewDir = Join-Path $env:TEMP ('shiori-update-warning-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $previewDir 'install'
$settingsPath = Join-Path $previewDir 'settings.json'
$installerPath = Join-Path $previewDir 'Shiori-Update-Warning-Preview.exe'
$scriptPath = Join-Path $previewDir 'preview.nsi'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
@{ captureRoot = (Join-Path $installDir 'captures') } | ConvertTo-Json -Compress |
  Set-Content -LiteralPath $settingsPath -Encoding UTF8 -NoNewline

$nsi = @'
Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"
!define BUILD_RESOURCES_DIR "__BUILD_RESOURCES_DIR__"
!define SHIORI_CAPTURE_SETTINGS_PATH "__SETTINGS_PATH__"
!include "__INSTALLER_INCLUDE__"
Name "Shiori"
OutFile "__INSTALLER_PATH__"
InstallDir "__INSTALL_DIR__"
Function .onInit
  !insertmacro customInit
FunctionEnd
Section "Preview"
SectionEnd
'@
$nsi = $nsi.Replace('__BUILD_RESOURCES_DIR__', $buildResourcesDir.Replace('\', '\\'))
$nsi = $nsi.Replace('__SETTINGS_PATH__', $settingsPath)
$nsi = $nsi.Replace('__INSTALLER_INCLUDE__', $installerInclude)
$nsi = $nsi.Replace('__INSTALLER_PATH__', $installerPath)
$nsi = $nsi.Replace('__INSTALL_DIR__', $installDir)
Set-Content -LiteralPath $scriptPath -Value $nsi -Encoding UTF8

& $compiler /INPUTCHARSET UTF8 $scriptPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerPath)) {
  throw "NSIS preview compilation failed with exit code $LASTEXITCODE."
}

$process = Start-Process -FilePath $installerPath -ArgumentList '/S' -PassThru
try {
  Wait-Process -Id $process.Id -ErrorAction Stop
  Remove-Item -LiteralPath $previewDir -Recurse -Force
} catch {
  Write-Warning "The preview is running as process $($process.Id). Close its window to finish the preview."
}
