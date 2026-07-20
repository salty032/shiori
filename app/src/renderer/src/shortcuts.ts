// U-3: アプリ全体のショートカット一覧（表示専用）。実際のキー処理は
// useGlobalKeys / useSelection / Viewer にそれぞれ分散しているため、ここは表示専用の複製。
// キー割り当てを変更したら、このテーブルも合わせて更新すること。
export type ShortcutGroup = { title: string; items: { keys: string; desc: string }[] }

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '全体',
    items: [
      { keys: '/', desc: '検索欄にフォーカス' },
      { keys: 'T', desc: 'フォーカス中の画像にクイックタグ' },
      { keys: 'Ctrl+,', desc: '設定を開く' },
      { keys: 'Ctrl+C', desc: '選択中の画像をコピー' },
      { keys: 'Ctrl+V', desc: 'クリップボードから画像を取り込み' },
    ],
  },
  {
    title: '選択・グリッド',
    items: [
      { keys: '矢印キー', desc: 'フォーカス移動' },
      { keys: 'Shift+矢印 / Shift+クリック', desc: '範囲選択' },
      { keys: 'Ctrl+矢印 / Ctrl+クリック', desc: 'フォーカス移動のみ / 個別に追加選択' },
      { keys: 'Ctrl+Shift+矢印', desc: '範囲を追加選択' },
      { keys: 'Ctrl+A', desc: 'すべて選択' },
      { keys: 'Home / End', desc: '先頭 / 末尾のフォーカスへ' },
      { keys: 'PageUp / PageDown', desc: 'ページ送り' },
      { keys: 'Enter / Space', desc: 'フォーカス中の画像を開く' },
      { keys: 'Delete', desc: '選択中の画像を削除' },
      { keys: 'Escape', desc: '選択を解除' },
      { keys: 'Ctrl+Z', desc: '元に戻す（削除の取り消し／選択の取り消し）' },
      { keys: 'Ctrl+Shift+Z / Ctrl+Y', desc: 'やり直し' },
    ],
  },
  {
    title: 'ビューア',
    items: [
      { keys: '← / →', desc: '前 / 次の画像へ' },
      { keys: 'Home / End', desc: '読み込み済みの最初 / 最後の画像へ' },
      { keys: 'Space / Escape / Enter', desc: 'ビューアを閉じる' },
      { keys: 'ダブルクリック', desc: 'ズームのオン・オフ切り替え' },
      { keys: '+ / - / 0', desc: 'ズームイン / アウト / リセット' },
      { keys: 'Tab', desc: '詳細パネルの表示切り替え' },
      { keys: 'Delete', desc: '表示中の画像を削除' },
      { keys: 'Ctrl+Z / Ctrl+Y', desc: '元に戻す / やり直し' },
    ],
  },
]
