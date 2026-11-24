param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$SettingsPath,
  [Parameter(Mandatory = $true)][string]$ResultDir
)

$result = 'safe'
try {
  if (Test-Path -LiteralPath $SettingsPath -PathType Leaf) {
    $settings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $captureRoot = $settings.captureRoot
    if ($captureRoot) {
      $install = [IO.Path]::GetFullPath($InstallDir).TrimEnd([char]92)
      $root = [IO.Path]::GetFullPath([string]$captureRoot).TrimEnd([char]92)
      if ($root.Equals($install, [StringComparison]::OrdinalIgnoreCase) -or
          $root.StartsWith($install + [char]92, [StringComparison]::OrdinalIgnoreCase)) {
        $result = 'unsafe'
      }
    }
  }
} catch {
  $result = 'error'
}

if ($result -eq 'unsafe') {
  [IO.File]::WriteAllText((Join-Path $ResultDir 'capture-root-unsafe'), '1')
} elseif ($result -eq 'error') {
  [IO.File]::WriteAllText((Join-Path $ResultDir 'capture-root-check-failed'), '1')
} else {
  [IO.File]::WriteAllText((Join-Path $ResultDir 'capture-root-safe'), '1')
}
