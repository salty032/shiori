// U-3: アプリ全体のショートカット一覧（表示専用）。実際のキー処理は
// useGlobalKeys / useSelection / Viewer / useTimesheet / VideoTrimmer にそれぞれ分散しているため、
// ここは表示専用の複製。
//
// **全部は載せない。** 載せるのは、このアプリで決めたキー（コマ送り・タイムシートの打ち方など）と、
// キーはありふれていても何が起きるか知らないと分からないもの（貼り付けで取り込まれる・削除を
// 取り消せる・画像のビューアで動画を操作できる等）だけ。どのアプリでも同じで押せば結果が見て
// 分かるキー（矢印での選択・Escape で閉じる等）まで並べると、このアプリならではのキーが埋もれる
// （2026-11-21 本人と決めた）。載せないと決めたキーとその理由は shortcuts.test.ts にあり、
// キー処理に書いたキーがこの表にも載せない表にも無いと、そこで落ちる。
//
// 表示言語で文言が変わるため、定数ではなく t を受け取って組み立てる関数にしている
// （モジュール読み込み時に文字列を焼き込むと、言語切り替えで更新されない）。
// keys 側も「ダブルクリック」のように訳が要るものがあるので t を通す。
import type { Translate } from './i18n'
import { VOLUME_STEP } from './video/volumeStep'

// note は組の下に小さく出す補足。
type ShortcutGroup = { title: string; items: { keys: string; desc: string }[]; note?: string }

// キャプチャのホットキーは設定で変えられるので、今の設定の値を受け取って出す。
export function shortcutGroups(t: Translate['t'], hotkeys: { capture: string; clip: string }): ShortcutGroup[] {
  return [
    {
      title: t('shortcuts.group.capture'),
      items: [
        { keys: hotkeys.capture, desc: t('shortcuts.captureStill') },
        { keys: hotkeys.clip, desc: t('shortcuts.captureClip') },
      ],
      note: t('shortcuts.hint'),
    },
    {
      title: t('shortcuts.group.global'),
      items: [
        { keys: '/', desc: t('shortcuts.focusSearch') },
        { keys: 'T', desc: t('shortcuts.quickTag') },
        { keys: 'Ctrl+C', desc: t('shortcuts.copySelected') },
        { keys: 'Ctrl+V', desc: t('shortcuts.pasteFromClipboard') },
        { keys: 'Delete', desc: t('shortcuts.deleteSelected') },
        { keys: 'Ctrl+Z', desc: t('shortcuts.undoGrid') },
        { keys: 'Ctrl+Shift+Z / Ctrl+Y', desc: t('shortcuts.redo') },
      ],
    },
    {
      title: t('shortcuts.group.viewer'),
      items: [
        { keys: '← / →', desc: t('shortcuts.prevNext') },
        { keys: ', / .', desc: t('shortcuts.frameStep') },
        { keys: 'Space', desc: t('shortcuts.playPause') },
        { keys: 'M', desc: t('shortcuts.toggleMute') },
        { keys: '↑ / ↓', desc: t('shortcuts.viewerVolume', { percent: Math.round(VOLUME_STEP * 100) }) },
        { keys: t('shortcuts.keys.doubleClick'), desc: t('shortcuts.toggleZoom') },
        { keys: '+ / - / 0', desc: t('shortcuts.zoomInOutReset') },
        { keys: 'Tab', desc: t('shortcuts.toggleDetails') },
        { keys: 'Delete', desc: t('shortcuts.deleteCurrent') },
        { keys: 'Ctrl+Z / Ctrl+Y', desc: t('shortcuts.undoRedo') },
      ],
    },
    {
      // ビューアでタイムシートを開いている間だけ効くキー。ビューアの組に混ぜると、同じキー
      // （← / → など）に 2 つの意味が並び、全部の行に「タイムシート表示中：」を付けることになる。
      title: t('shortcuts.group.timesheet'),
      items: [
        { keys: '0-9 / Enter', desc: t('shortcuts.viewerTimesheet') },
        { keys: 'F1 / F2 / F3', desc: t('shortcuts.viewerTimesheetSymbols') },
      ],
    },
    {
      title: t('shortcuts.group.trim'),
      items: [
        { keys: ', / .', desc: t('shortcuts.frameStep') },
        { keys: 'I / O', desc: t('shortcuts.trimInOut') },
      ],
    },
  ]
}
