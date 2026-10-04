@echo off
rem 対応検査の評価用に、録画ごとの時刻列を frame-diag\ へ書き出して開発起動する。
rem 採点: cd app && node scripts/evaluate-frame-diagnostics.cjs ..\frame-diag
set ELECTRON_RUN_AS_NODE=
set SHIORI_FRAME_DIAGNOSTICS_DIR=%~dp0frame-diag
cd /d "%~dp0app"
npm run dev
