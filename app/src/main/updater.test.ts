import { vi, describe, expect, it } from 'vitest'

vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), quitAndInstall: vi.fn() } }))
vi.mock('electron', () => ({ app: { isPackaged: false, getName: vi.fn(), getVersion: vi.fn() } }))
vi.mock('./windows', () => ({ setQuitting: vi.fn() }))
vi.mock('./settings', () => ({ flushSettings: vi.fn().mockResolvedValue(undefined) }))

import { autoUpdater } from 'electron-updater'
import { stalePendingFiles, staleRootFiles, quitAndInstallUpdate } from './updater'

// quitAndInstall のシグネチャは quitAndInstall(isSilent = false, isForceRunAfter = false)。
// 引数を省くと NSIS に /S が渡らず、oneClick:false のこのアプリではインストール先を尋ねる
// ウィザードが前面に出てしまう（バックグラウンド適用のはずが、そう見えない）。
// さらに isSilent=true 側では isForceRunAfter がそのまま使われるため、第2引数を省くと
// 今度は更新後にアプリが再起動しない。どちらも引数の省略で静かに壊れるので固定する。
describe('quitAndInstallUpdate', () => {
  it('サイレント かつ 更新後に再起動する引数で呼ぶ', async () => {
    await quitAndInstallUpdate()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})

// 誤って消すと 100MB の再ダウンロードが発生し、消し損ねると 100MB が居座る。
// どちらも静かに起きるのでファイル名の判定だけは固定しておく。
describe('stalePendingFiles', () => {
  const stale = (names: string[]): string[] => stalePendingFiles(names, 'Shiori', '1.1.4')

  it('現バージョンのインストーラ → 削除（適用済み）', () => {
    expect(stale(['Shiori-Setup-1.1.4.exe'])).toEqual(['Shiori-Setup-1.1.4.exe'])
  })

  it('旧バージョンのインストーラ → 削除', () => {
    expect(stale(['Shiori-Setup-1.1.2.exe'])).toEqual(['Shiori-Setup-1.1.2.exe'])
  })

  it('新しいバージョンのインストーラ → 残す（インストール失敗時に再利用される）', () => {
    expect(stale(['Shiori-Setup-1.1.5.exe'])).toEqual([])
  })

  it('blockmap も本体と同じ規則で消す', () => {
    expect(stale(['Shiori-Setup-1.1.3.exe.blockmap'])).toEqual(['Shiori-Setup-1.1.3.exe.blockmap'])
  })

  it('中断された DL の temp- 付きファイルも対象', () => {
    expect(stale(['temp-Shiori-Setup-1.1.1.exe'])).toEqual(['temp-Shiori-Setup-1.1.1.exe'])
  })

  it('temp- 付きでも新しいバージョンなら残す（レジューム対象）', () => {
    expect(stale(['temp-Shiori-Setup-2.0.0.exe'])).toEqual([])
  })

  it('update-info.json など electron-updater の管理ファイルは触らない', () => {
    expect(stale(['update-info.json', 'installer.log'])).toEqual([])
  })

  it('別アプリのインストーラは触らない', () => {
    expect(stale(['Other-Setup-1.0.0.exe'])).toEqual([])
  })

  it('プレリリース等バージョンが読めないものは残す', () => {
    expect(stale(['Shiori-Setup-1.1.3-beta.1.exe'])).toEqual([])
  })

  it('セグメント数が違っても比較できる（1.2 < 1.1.4 ではない）', () => {
    expect(stalePendingFiles(['Shiori-Setup-1.2.exe'], 'Shiori', '1.1.4')).toEqual([])
  })
})

// 実機のキャッシュには pending の本体と同サイズ・同時刻の installer.exe が
// ルート直下に丸ごと残っていた（旧 electron-updater 世代の命名）。
describe('staleRootFiles', () => {
  it('旧世代の installer.exe を削除する', () => {
    expect(staleRootFiles(['installer.exe'])).toEqual(['installer.exe'])
  })

  it('中断された旧世代の temp-installer.exe も削除する', () => {
    expect(staleRootFiles(['temp-installer.exe'])).toEqual(['temp-installer.exe'])
  })

  it('current.blockmap は残す（消すと次回が差分DLにならない）', () => {
    expect(staleRootFiles(['current.blockmap'])).toEqual([])
  })

  it('pending ディレクトリ自体には触れない', () => {
    expect(staleRootFiles(['pending'])).toEqual([])
  })

  it('現行世代の命名のインストーラはルートに来ない想定なので触らない', () => {
    expect(staleRootFiles(['Shiori-Setup-1.1.3.exe'])).toEqual([])
  })
})
