@echo off
rem 日常の開発エントリ。録画ごとの診断ファイルを frame-diag\ へ書き出し、テスト動画（frame-test\）を
rem http://localhost:8790/ で配る（scripts\frame-test.cjs）。
set ELECTRON_RUN_AS_NODE=
set SHIORI_FRAME_DIAGNOSTICS_DIR=%~dp0frame-diag
cd /d "%~dp0app"
if exist "%~dp0frame-test" start "" /b node scripts\frame-test.cjs serve
npm run dev
