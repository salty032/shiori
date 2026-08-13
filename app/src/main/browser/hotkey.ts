// main 側専用の薄いラッパー。実体は shared/hotkey.ts（renderer の SettingsModal と
// 共有する単一の情報源。Q4: 別実装での UI/main 判定ズレを防ぐ）。
export { normalizeCaptureHotkey, captureHotkeyMainKey } from '../../shared/hotkey'
