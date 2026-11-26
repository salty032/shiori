LangString SHIORI_CAPTURE_ROOT_IN_INSTALL_DIR 1033 "Your capture folder is inside the app's installation folder. Updating may delete captures stored there. Change the save location in Settings > Data, then try the update again."
LangString SHIORI_CAPTURE_ROOT_IN_INSTALL_DIR 1041 "キャプチャと録画の保存場所が、Shiori のインストール先の中にあります。このまま更新すると、保存場所内のキャプチャや録画が削除されるおそれがあります。設定 > データ で保存場所を変更してから、もう一度更新してください。"

; 更新では、入っている古い版のアンインストーラがインストール先を丸ごと消す（electron-builder の
; uninstaller.nsh。ゴミ箱を通らない）。古い版の動きは新しい版から変えられないので、消される前に
; 走るここ（新しい版のインストーラの .onInit）で、インストール先に画像・動画があれば止める。
;
; **設定（captureRoot）を読んで判定しない。** 保存場所を変えるとき移動を断ったぶんは元の場所に
; 残るので、今の保存場所が外でもインストール先に素材が残っている人がいる。設定を読む方式は
; PowerShell や settings.json が読めないと判定できず、更新が止まったままになった（1.9.2）。
;
; 拡張子は app/src/main/system/media-exts.ts の MEDIA_EXTS と揃える。本体に含まれる画像は
; resources\extension（拡張機能のアイコン）だけなので、そこは見ない。
!ifndef BUILD_UNINSTALLER
Function shioriFindMedia
  ; 引数: $INSTDIR からの相対フォルダ（"" で $INSTDIR 自身）。戻り値: 最初に見つけたファイルのパス。無ければ ""。
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R3 ""

  ClearErrors
  FindFirst $R1 $R2 "$INSTDIR$R0\*.*"
  IfErrors done

  loop:
    StrCmp $R2 "" done
    StrCmp $R2 "." next
    StrCmp $R2 ".." next
    IfFileExists "$INSTDIR$R0\$R2\*.*" isDir isFile

  isDir:
    StrCmp "$R0\$R2" "\resources\extension" next
    Push "$R0\$R2"
    Call shioriFindMedia
    Pop $R3
    StrCmp $R3 "" next done

  isFile:
    StrCpy $R4 $R2 "" -4
    StrCmp $R4 ".png" found
    StrCmp $R4 ".jpg" found
    StrCmp $R4 ".gif" found
    StrCmp $R4 ".mp4" found
    StrCpy $R4 $R2 "" -5
    StrCmp $R4 ".jpeg" found
    StrCmp $R4 ".webp" found
    StrCmp $R4 ".webm" found
    Goto next

  found:
    StrCpy $R3 "$INSTDIR$R0\$R2"
    Goto done

  next:
    FindNext $R1 $R2
    Goto loop

  done:
    FindClose $R1
    StrCpy $R0 $R3
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd
!endif

!macro customInit
  Push $R9
  Push ""
  Call shioriFindMedia
  Pop $R9
  StrCmp $R9 "" shioriCaptureCheckDone
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "$(SHIORI_CAPTURE_ROOT_IN_INSTALL_DIR)"
  Abort
shioriCaptureCheckDone:
  Pop $R9
!macroend
