import { useEffect, useRef } from 'react'
import { useT } from '../i18n'
import { font } from '../styles'
import { usePanelResize } from '../hooks/usePanelResize'
import { requiredSheetLength, timesheetGlyph, timesheetLabels, TOEI_SYMBOL } from '../../../shared/timesheet'
import type { Timesheet } from '../hooks/useTimesheet'
import { XIcon } from './Icon'

// タイムシート（手打ち）。**詳細パネルと入れ替わりで、同じ場所に出る。**
// 打っている間はタグやメモより表を見ているので、場所を取り合わせるより明け渡す方がよい。
//
// **見た目は東映アニメーション デジタルタイムシートをそのまま写す**（2026-08-13 の指示）。
// 打つ人はそちらの用紙を見慣れており、欄の位置・色・目盛りの入り方が手掛かりになっている。
// 独自の並びにすると、読めはしても「いつもの表」として読めない。
//
//   ACTION（原画 A〜G）｜コマ目盛り｜SOUND（S1 S2）｜CELL（動画 a〜g）｜CAM（1 2）
//
//   - 1 コマ 1 マス。コマ番号は 2 コマごとに出す（実物と同じ間引き）
//   - 1 秒（素材 fps ぶん）ごとに太線で区切り、**秒のブロックごとに地色を替える**
//   - 秒の番号はブロックの最終行に出す
//   - 新しい絵が始まるコマにだけ番号が入り、続くコマは縦線が伸びる
//
// Shiori が打つのは **CELL（動画）の a 列**だけ。他の欄は実物と同じ枠を出すが空のまま——
// 映像から分かるのは「絵が変わった位置」だけで、原画か中割りかも層の分離も分からない
// （docs/TIMESHEET.md 3-4）。**埋められない欄を消さずに空で見せる**方が、何が分かって
// 何が分かっていないかがそのまま読める。

const ROW_H = 15

// 実物の配色。テーマ変数は使わない（用紙の色そのものが手掛かりなので、ダーク／ライトで
// 変わってはいけない）。
const c = {
  frame: '#7a8a99',        // 欄をまたぐ枠線
  rule: '#c9d6e2',         // 1 コマごとの罫線
  ruleSecond: '#5f7381',   // 1 秒ごとの太線
  headText: '#1b3348',
  actionBand: '#e4e9ee',
  actionSub: '#dbe9f7',
  soundBand: '#dee5f6',
  cellBand: '#fbe3e6',
  camBand: '#e2f2e2',
  counterBg: '#f7fbfc',
  counterInk: '#5a7280',
  // 秒のブロックごとに交互に敷く地色。
  bandA: '#eef1fa',
  bandB: '#edf7f1',
  ink: '#12212b',
  // 選択中のマス（実物の選択色と同じ薄い青）。
  sel: '#bcd9f2',
  selRow: 'rgba(188,217,242,0.30)',
}

const ACTION_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
const SOUND_COLS = ['S1', 'S2']
const CELL_COLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
const CAM_COLS = ['1', '2']

const W = { action: 42, counter: 46, sound: 26, cell: 42, cam: 60 }
const TOTAL_W =
  ACTION_COLS.length * W.action + W.counter + SOUND_COLS.length * W.sound
  + CELL_COLS.length * W.cell + CAM_COLS.length * W.cam

// 打った番号が入るのは CELL の a（＝動画欄の 1 列目）。クリップボードへ出すのも 1 列だけ。
const WRITE_COL = 0

type Props = {
  sheet: Timesheet
  /** 1 秒のマス数に使う素材の fps */
  fps: number
}

export default function TimesheetPanel({ sheet, fps }: Props) {
  const { t } = useT()
  const currentRowRef = useRef<HTMLDivElement>(null)
  const { width, handleResizeStart } = usePanelResize({
    storageKey: 'shiori-timesheet-width', min: 320, max: 900, defaultWidth: 620, direction: 'left',
  })

  // コマ送りに追従して現在行を見える位置へ寄せる。**block: 'nearest' にする**——常に中央へ
  // 寄せると 1 コマ送るたびに表全体が動き、どこを見ているか分からなくなる。
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [sheet.current])

  const { total, marks, current, pending } = sheet
  const labels = timesheetLabels(marks)
  const labelAt = new Array<string | null>(total).fill(null)
  marks.forEach((mark, i) => { if (mark.frame < total) labelAt[mark.frame] = labels[i] })
  // 縦線は「最初の番号より後ろ」にだけ伸ばす。打ち始める前のコマに線が出ていると、
  // まだ何も記録していない区間が「絵が続いている」ように読めてしまう。
  // **× を打った後も伸ばさない**——カラは「その層に絵が無い」なので、続く絵も無い。
  const held = new Array<boolean>(total).fill(false)
  let showing = false
  for (let i = 0; i < total; i++) {
    const label = labelAt[i]
    if (label !== null) showing = label !== TOEI_SYMBOL.empty
    else held[i] = showing
  }

  const perSecond = Math.max(1, Math.round(fps))
  const need = requiredSheetLength(total, fps)

  function cellBorder(i: number): string {
    if (i === 0) return '1px solid transparent'
    return i % perSecond === 0 ? `1px solid ${c.ruleSecond}` : `1px solid ${c.rule}`
  }

  return (
    <aside style={{ ...st.panel, width }} data-timesheet data-keep-selection>
      <div style={st.resizeHandle} onPointerDown={handleResizeStart} />
      <div style={st.head}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: font.sm }}>{t('timesheet.title')}</span>
          <span style={{ color: c.counterInk, fontSize: font.xs }}>
            {t('timesheet.count', { marks: String(marks.length), total: String(total) })}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            style={st.copyBtn}
            onClick={sheet.copy}
            title={t('timesheet.copyHint', { sec: String(need.seconds), frames: String(need.frames) })}>
            {t(sheet.copied ? 'timesheet.copied' : 'timesheet.copy')}
          </button>
          <button style={st.closeBtn} onClick={() => sheet.setOpen(false)} title={t('timesheet.toggle')}>
            <XIcon size={13} />
          </button>
        </div>
      </div>

      {/* 横は用紙の幅で固定してスクロールさせる。**欄を間引いて畳まない**——欄の位置関係
          そのものが実物の手掛かりなので、狭いときは切るのではなくスクロールで見せる。 */}
      <div style={st.scrollX}>
        <div style={{ width: TOTAL_W, flexShrink: 0 }}>
          <div style={{ ...st.groupRow, borderBottom: `1px solid ${c.frame}` }}>
            <div style={{ ...st.group, width: ACTION_COLS.length * W.action, background: c.actionBand }}>ACTION</div>
            <div style={{ ...st.group, width: W.counter, background: c.counterBg, borderRight: `1px solid ${c.frame}` }} />
            <div style={{ ...st.group, width: SOUND_COLS.length * W.sound, background: c.soundBand }}>SOUND</div>
            <div style={{ ...st.group, width: CELL_COLS.length * W.cell, background: c.cellBand }}>CELL</div>
            <div style={{ ...st.group, width: CAM_COLS.length * W.cam, background: c.camBand }}>CAM</div>
          </div>
          <div style={{ ...st.groupRow, borderBottom: `1px solid ${c.frame}` }}>
            {ACTION_COLS.map((label) => <div key={`a${label}`} style={{ ...st.colHead, width: W.action, background: c.actionSub }}>{label}</div>)}
            <div style={{ ...st.colHead, width: W.counter, background: c.counterBg, borderRight: `1px solid ${c.frame}` }} />
            {SOUND_COLS.map((label) => <div key={`s${label}`} style={{ ...st.colHead, width: W.sound, background: c.soundBand }}>{label}</div>)}
            {CELL_COLS.map((label) => <div key={`c${label}`} style={{ ...st.colHead, width: W.cell, background: c.cellBand }}>{label}</div>)}
            {CAM_COLS.map((label) => <div key={`m${label}`} style={{ ...st.colHead, width: W.cam, background: c.camBand }}>{label}</div>)}
          </div>

          <div style={st.body}>
            {Array.from({ length: total }, (_, i) => {
              const label = labelAt[i]
              const isCurrent = i === current
              const secondIdx = Math.floor(i / perSecond)
              // 秒のブロックごとに地色を替える（実物と同じ）。1 秒の切れ目が目で追える。
              const band = secondIdx % 2 === 0 ? c.bandA : c.bandB
              const border = cellBorder(i)
              const isSecondEnd = i % perSecond === perSecond - 1
              return (
                <div
                  key={i}
                  ref={isCurrent ? currentRowRef : undefined}
                  style={{ display: 'flex', height: ROW_H, background: isCurrent ? c.selRow : undefined, cursor: 'pointer' }}
                  onClick={() => sheet.seek(i)}>
                  {ACTION_COLS.map((label2) => (
                    <div key={`a${label2}`} style={{ ...st.cell, width: W.action, background: band, borderTop: border }} />
                  ))}
                  {/* コマ目盛り。秒はブロックの最終行、コマ番号は 2 コマごと（実物と同じ間引き）。 */}
                  <div style={{ ...st.cell, width: W.counter, background: c.counterBg, borderTop: border, borderRight: `1px solid ${c.frame}`, color: c.counterInk, justifyContent: 'space-between', padding: '0 4px' }}>
                    <span style={{ fontWeight: 700 }}>{isSecondEnd ? secondIdx + 1 : ''}</span>
                    <span>{(i + 1) % 2 === 0 ? i + 1 : ''}</span>
                  </div>
                  {SOUND_COLS.map((label2) => (
                    <div key={`s${label2}`} style={{ ...st.cell, width: W.sound, background: band, borderTop: border }} />
                  ))}
                  {CELL_COLS.map((label2, col) => {
                    const isWrite = col === WRITE_COL
                    return (
                      <div
                        key={`c${label2}`}
                        style={{
                          ...st.cell, width: W.cell, borderTop: border, position: 'relative',
                          background: isWrite && isCurrent ? c.sel : band,
                          fontWeight: 800, color: c.ink,
                        }}>
                        {isWrite && (isCurrent && pending
                          ? <span style={{ opacity: 0.6, borderBottom: `1px solid ${c.ink}` }}>{timesheetGlyph(pending)}</span>
                          : label !== null ? timesheetGlyph(label) : '')}
                        {isWrite && held[i] && !(isCurrent && pending) && (
                          <span style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, background: c.ink, opacity: 0.7 }} />
                        )}
                      </div>
                    )
                  })}
                  {CAM_COLS.map((label2) => (
                    <div key={`m${label2}`} style={{ ...st.cell, width: W.cam, background: band, borderTop: border }} />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </aside>
  )
}

const st: Record<string, React.CSSProperties> = {
  panel: {
    background: '#fff', borderLeft: '1px solid var(--border-default)', flexShrink: 0,
    display: 'flex', flexDirection: 'column', position: 'relative',
    color: c.ink, fontSize: 10, fontVariantNumeric: 'tabular-nums',
  },
  resizeHandle: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 10, userSelect: 'none' },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '8px 10px', background: c.actionBand, borderBottom: `1px solid ${c.frame}`,
    flexShrink: 0, color: c.headText,
  },
  copyBtn: {
    padding: '4px 10px', background: '#fff', border: `1px solid ${c.frame}`, borderRadius: 2,
    color: c.ink, fontSize: font.xs, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  closeBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', color: c.headText, cursor: 'pointer', padding: '2px 4px',
  },
  scrollX: { flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', display: 'flex' },
  groupRow: { display: 'flex', height: 16, flexShrink: 0 },
  group: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRight: `1px solid ${c.frame}`, color: c.headText, fontWeight: 700, letterSpacing: 0.6,
  },
  colHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRight: `1px solid ${c.rule}`, color: c.headText, fontWeight: 700,
  },
  body: { overflowY: 'auto', height: 'calc(100% - 32px)' },
  cell: { display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: `1px solid ${c.rule}` },
}
