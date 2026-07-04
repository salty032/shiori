@echo off
rem 日常の開発エントリ。
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0app"
npm run dev
