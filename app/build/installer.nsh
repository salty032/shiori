LangString SHIORI_CAPTURE_ROOT_IN_INSTALL_DIR 1033 "Your capture folder is inside the app's installation folder. Updating may delete captures stored there. Change the save location in Settings > Data, then try the update again."
LangString SHIORI_CAPTURE_ROOT_IN_INSTALL_DIR 1041 "キャプチャと録画の保存場所が、Shiori のインストール先の中にあります。このまま更新すると、保存場所内のキャプチャや録画が削除されるおそれがあります。設定 > データ で保存場所を変更してから、もう一度更新してください。"
LangString SHIORI_CAPTURE_ROOT_CHECK_FAILED 1033 "Shiori could not check the capture folder. The update was stopped to protect your files. Check the save location in Settings > Data, then try again."
LangString SHIORI_CAPTURE_ROOT_CHECK_FAILED 1041 "キャプチャと録画の保存場所を確認できなかったため、更新を中止しました。設定 > データ で保存場所を確認してください。"

!ifndef SHIORI_CAPTURE_SETTINGS_PATH
  !define SHIORI_CAPTURE_SETTINGS_PATH "$APPDATA\Shiori\settings.json"
!endif
!ifndef SHIORI_CAPTURE_SCRIPT_PATH
  !define SHIORI_CAPTURE_SCRIPT_PATH "${BUILD_RESOURCES_DIR}\check-capture-root.ps1"
!endif

!macro customInit
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  Delete "$PLUGINSDIR\capture-root-unsafe"
  Delete "$PLUGINSDIR\capture-root-safe"
  Delete "$PLUGINSDIR\capture-root-check-failed"
  File /oname=check-capture-root.ps1 "${SHIORI_CAPTURE_SCRIPT_PATH}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-capture-root.ps1" -InstallDir "$INSTDIR" -SettingsPath "${SHIORI_CAPTURE_SETTINGS_PATH}" -ResultDir "$PLUGINSDIR"'
  Pop $R9

  IfFileExists "$PLUGINSDIR\capture-root-unsafe" captureRootUnsafe 0
  IfFileExists "$PLUGINSDIR\capture-root-safe" captureRootSafe 0
  Goto captureRootCheckFailed

captureRootUnsafe:
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "$(SHIORI_CAPTURE_ROOT_IN_INSTALL_DIR)"
  Abort

captureRootSafe:
  Goto captureRootCheckDone

captureRootCheckFailed:
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "$(SHIORI_CAPTURE_ROOT_CHECK_FAILED)"
  Abort

captureRootCheckDone:
!macroend
