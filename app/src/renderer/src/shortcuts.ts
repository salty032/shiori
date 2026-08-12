// U-3: アプリ全体のショートカット一覧（表示専用）。実際のキー処理は
// useGlobalKeys / useSelection / Viewer にそれぞれ分散しているため、ここは表示専用の複製。
// キー割り当てを変更したら、このテーブルも合わせて更新すること。
//
// ただしこの表は「実装の網羅的な一覧」ではなく読み物なので、載せない選択もある。
// Home / End（先頭・末尾へ移動）はグリッド・ビューアとも実装は生きているが、
// 一般的すぎて説明する価値が薄いため意図的に載せていない。抜けと勘違いして
// 書き戻さないこと（キー処理は useSelection / Viewer にそのまま残っている）。
//
// 表示言語で文言が変わるため、定数ではなく t を受け取って組み立てる関数にしている
// （モジュール読み込み時に文字列を焼き込むと、言語切り替えで更新されない）。
// keys 側も「矢印キー」「ダブルクリック」のように訳が要るものがあるので t を通す。
import type { Translate } from './i18n'

export type ShortcutGroup = { title: string; items: { keys: string; desc: string }[] }

export function shortcutGroups(t: Translate['t']): ShortcutGroup[] {
  return [
    {
      title: t('shortcuts.group.global'),
      items: [
        { keys: '/', desc: t('shortcuts.focusSearch') },
        { keys: 'T', desc: t('shortcuts.quickTag') },
        { keys: 'Ctrl+C', desc: t('shortcuts.copySelected') },
        { keys: 'Ctrl+V', desc: t('shortcuts.pasteFromClipboard') },
      ],
    },
    {
      title: t('shortcuts.group.selection'),
      items: [
        { keys: t('shortcuts.keys.arrows'), desc: t('shortcuts.moveFocus') },
        { keys: 'Ctrl+A', desc: t('shortcuts.selectAll') },
        { keys: 'PageUp / PageDown', desc: t('shortcuts.pageThrough') },
        { keys: 'Enter', desc: t('shortcuts.openFocused') },
        { keys: 'Delete', desc: t('shortcuts.deleteSelected') },
        { keys: 'Escape', desc: t('shortcuts.clearSelection') },
        { keys: 'Ctrl+Z', desc: t('shortcuts.undoGrid') },
        { keys: 'Ctrl+Shift+Z / Ctrl+Y', desc: t('shortcuts.redo') },
      ],
    },
    {
      title: t('shortcuts.group.viewer'),
      items: [
        { keys: '← / →', desc: t('shortcuts.prevNext') },
        { keys: ', / .', desc: t('shortcuts.viewerFrameStep') },
        { keys: 'Enter / Escape', desc: t('shortcuts.closeViewer') },
        { keys: 'Space', desc: t('shortcuts.viewerSpace') },
        { keys: t('shortcuts.keys.doubleClick'), desc: t('shortcuts.toggleZoom') },
        { keys: '+ / - / 0', desc: t('shortcuts.zoomInOutReset') },
        { keys: 'Tab', desc: t('shortcuts.toggleDetails') },
        { keys: 'Delete', desc: t('shortcuts.deleteCurrent') },
        { keys: 'Ctrl+Z / Ctrl+Y', desc: t('shortcuts.undoRedo') },
      ],
    },
  ]
}
