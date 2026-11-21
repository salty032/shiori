// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_DEFAULTS } from '../../../shared/settingsDefaults'
import SettingsModal from './SettingsModal'

vi.mock('../i18n', () => ({
  useT: () => ({ t: (key: string) => key, tp: (key: string, count: number) => `${key}:${count}` }),
}))

function props(): ComponentProps<typeof SettingsModal> {
  return {
    settings: SETTINGS_DEFAULTS, startup: false, taggerReady: false,
    taggerProgress: null, retagProgress: null, extensionStatus: null,
    onClose: vi.fn(), onToggleStartup: vi.fn(), onUpdateCaptureHotkey: vi.fn(async () => true),
    onUpdateClipHotkey: vi.fn(async () => true), onUpdateSetting: vi.fn(),
    onTaggerDownload: vi.fn(), onTaggerCancelDownload: vi.fn(), onTaggerDelete: vi.fn(),
    onTaggerRetagAll: vi.fn(), onShowWhatsNew: vi.fn(),
    onShareExport: vi.fn(async () => ({ canceled: true })),
    onShareImport: vi.fn(async () => ({ canceled: true })),
  }
}

describe('SettingsModal data tab lifecycle', () => {
  const getStorageInfo = vi.fn(async () => null)
  beforeEach(() => {
    getStorageInfo.mockClear()
    // IPC subscriptions remain active for the lifetime of the settings modal.
    vi.stubGlobal('api', {
      getAppVersion: vi.fn(async () => '1.5.0'), getWsPort: vi.fn(async () => 8765),
      onCaptureMoveProgress: vi.fn(() => () => {}), getStorageInfo,
    })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('使用量はデータを開くまで取得せず、タブを往復しても再取得しない', async () => {
    const ui = render(<SettingsModal {...props()} />)
    expect(getStorageInfo).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(ui.getByText('settings.tab.tag')) })
    expect(getStorageInfo).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(ui.getByText('settings.tab.data')) })
    expect(getStorageInfo).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(ui.getByText('settings.tab.tag')) })
    await act(async () => { fireEvent.click(ui.getByText('settings.tab.data')) })
    expect(getStorageInfo).toHaveBeenCalledTimes(1)
  })

  // 設定画面へ渡す保存の口は 1 本（onUpdateSetting）。押した選択肢が、そのキーと値で届くこと。
  it('基本・データのタブで選んだ値が、そのキーで保存に渡る', async () => {
    const p = props()
    const ui = render(<SettingsModal {...p} />)
    fireEvent.click(ui.getByText('settings.theme.dark'))
    expect(p.onUpdateSetting).toHaveBeenLastCalledWith('theme', 'dark')
    await act(async () => { fireEvent.click(ui.getByText('settings.tab.data')) })
    fireEvent.click(ui.getByText('settings.captureResize.fhd'))
    expect(p.onUpdateSetting).toHaveBeenLastCalledWith('captureResize', 'fhd')
    fireEvent.click(ui.getByText('settings.videoExportFormat.h264'))
    expect(p.onUpdateSetting).toHaveBeenLastCalledWith('videoExportFormat', 'h264')
  })

  it('共有書き出し中に別タブへ移っても、処理中の状態と完了結果を保持する', async () => {
    let finish!: (result: { canceled: boolean; count: number }) => void
    const p = props()
    p.onShareExport = vi.fn(() => new Promise<{ canceled: boolean; count: number }>((resolve) => { finish = resolve }))
    const ui = render(<SettingsModal {...p} />)
    await act(async () => { fireEvent.click(ui.getByText('settings.tab.data')) })
    fireEvent.click(ui.getByText('settings.exportLibrary'))
    fireEvent.click(ui.getByText('settings.tab.about'))
    fireEvent.click(ui.getByText('settings.tab.data'))
    expect((ui.getByText('settings.exporting') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(ui.getByText('settings.tab.about'))
    await act(async () => { finish({ canceled: false, count: 3 }) })
    fireEvent.click(ui.getByText('settings.tab.data'))
    expect(ui.getByText('toast.exported:3')).toBeTruthy()
    expect(p.onShareExport).toHaveBeenCalledTimes(1)
  })
})
