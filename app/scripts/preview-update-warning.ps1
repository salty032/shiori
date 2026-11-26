# 更新前の確認（build/installer.nsh の customInit）だけを小さなインストーラに組み、
# 実際の更新と同じ無人モード（/S）で動かす。レジストリにも本物の Shiori にも触らない。
#
#   -Case capture    インストール先にキャプチャがある → 止まって案内が出るはず
#   -Case extension  本体のアイコン（resources\extension）だけ → 止まらないはず
#   -Case empty      何も無い → 止まらないはず
#   -Show            案内を閉じるまで待つ（文言を目で見るとき）。付けなければ 5 秒で判定して閉じる
param(
  [ValidateSet('capture', 'extension', 'empty')][string]$Case = 'capture',
  [switch]$Show
)
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$installerInclude = Join-Path $appDir 'build\installer.nsh'
$cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis'
$compiler = Get-ChildItem -LiteralPath $cacheRoot -Filter 'makensis.exe' -File -Recurse |
  Where-Object { $_.FullName -match 'nsis-3\.0\.4\.1.*\\Bin\\makensis\.exe$' } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $compiler) {
  throw "NSIS 3.0.4.1 was not found in $cacheRoot. Build the package once to populate the electron-builder cache."
}

$previewDir = Join-Path $env:TEMP ('shiori-update-warning-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $previewDir 'install'
$installerPath = Join-Path $previewDir 'Shiori-Update-Warning-Preview.exe'
$scriptPath = Join-Path $previewDir 'preview.nsi'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

$extensionDir = Join-Path $installDir 'resources\extension'
if ($Case -ne 'empty') {
  New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $extensionDir 'icon16.png') -Value '' -NoNewline
}
if ($Case -eq 'capture') {
  $monthDir = Join-Path $installDir 'captures\2026-11'
  New-Item -ItemType Directory -Path $monthDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $monthDir 'cap_preview.PNG') -Value '' -NoNewline
}

$nsi = @'
Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"
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
$nsi = $nsi.Replace('__INSTALLER_INCLUDE__', $installerInclude)
$nsi = $nsi.Replace('__INSTALLER_PATH__', $installerPath)
$nsi = $nsi.Replace('__INSTALL_DIR__', $installDir)
Set-Content -LiteralPath $scriptPath -Value $nsi -Encoding UTF8

& $compiler /V2 /WX /INPUTCHARSET UTF8 $scriptPath | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerPath)) {
  throw "NSIS preview compilation failed with exit code $LASTEXITCODE."
}

$process = Start-Process -FilePath $installerPath -ArgumentList '/S', '--updated' -PassThru
if ($Show) {
  $process.WaitForExit()
  $stopped = $true
} else {
  # 案内が出ればそこで待つので終わらない。出なければすぐ終わる。
  $stopped = -not $process.WaitForExit(5000)
  if ($stopped) { Stop-Process -Id $process.Id -Force }
}
Remove-Item -LiteralPath $previewDir -Recurse -Force -ErrorAction SilentlyContinue
if ($stopped) { "${Case}: stopped (warning shown)" } else { "${Case}: passed (exit code $($process.ExitCode))" }
