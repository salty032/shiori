import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipFrames } from '../../../shared/api.video'
import { TIMESHEET_LOCKED } from '../timesheetLock'
import {
  buildToeiClipboard, canBuildTimesheet, countReusedFrames, decodeTimesheet, encodeTimesheet,
  expandMarks, isToeiSymbol, normalizeTimesheetValue, timesheetRows, TOEI_SYMBOL, type TimesheetMark
} from '../../../shared/timesheet'

// 記号の入力キー。**東映デジタルタイムシートの割り当てをそのまま使う**（F1/F2/F3 と
// テンキーの / - *）。`-` はビューアのズームアウトとぶつかるが、表を開いている間は
// こちらが取る——ぶつかるものを譲っていたら、そもそも東映の操作系は載らない。
const SYMBOL_KEYS: Record<string, string> = {
  F1: TOEI_SYMBOL.inbetween, '/': TOEI_SYMBOL.inbetween,
  F2: TOEI_SYMBOL.reverse, '-': TOEI_SYMBOL.reverse,
  F3: TOEI_SYMBOL.empty, '*': TOEI_SYMBOL.empty,
}

// 手打ちのタイムシートの状態と操作。
//
// **ビューアではなくここに置く。** 表は詳細パネルの場所に出す（打っている間、詳細パネルは
// 邪魔なので入れ替える）ため、表の所有者はビューアの外側でなければならない。
// ビューアからは映像の現在コマだけが流れ込んでくる。
//
// ## 操作系は東映アニメーション デジタルタイムシートに寄せる
//
// 打つ人はそちらに慣れている。**ビューアの既定のキーとぶつかるものは、表を開いている間
// こちらが取る**（Enter は「確定」であって「閉じる」ではない、数字はズームではない、等）。
// 詳細は docs/TIMESHEET.md。
//
//   数字 / 英字 … 動画番号を打つ（半角英数字。東映と同じ）
//   Enter      … 確定して次のコマへ。何も打っていなければ通し番号を振る
//   Backspace  … 打ちかけを 1 文字消す。空なら現在コマの記入を消す
//   ↑ / ↓      … 1 コマ戻る / 進む（, / . と同じ動き。東映のカーソル移動に合わせる）
//   Escape     … 打ちかけを捨てる。空なら表を閉じる

export type TimesheetPlayer = {
  stepFrame: (dir: number) => void
  goToFrame: (idx: number) => void
}

export function useTimesheet(imageId: number | null, fps: number | null) {
  const [clipFrames, setClipFrames] = useState<ClipFrames | null>(null)
  const [current, setCurrent] = useState(0)
  // 推定抜けの中では表に対応する実測行が無い。現在の実測行の後ろ何コマ目かを別に持つ。
  const [currentGap, setCurrentGap] = useState(0)
  const [marks, setMarks] = useState<TimesheetMark[]>([])
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  // 打ちかけの動画番号。確定するまで保存もコピーもされない（東映と同じく Enter で確定）。
  const [pending, setPending] = useState('')
  // 映像を動かす口。表はビューアの外（詳細パネルの場所）にいるので、プレーヤーへは
  // ビューアに預けてもらったこの参照から届く。
  const playerRef = useRef<TimesheetPlayer | null>(null)

  // 配る版では ready を立てない。**ボタンも表も出ず、キーも取らない**——ここを false に
  // するだけで、下の visible も handleKey も自動的に止まる（判定を増やすと、増やした
  // ぶんだけ配る版に漏れる経路ができる）。開発版では従来どおり。
  const ready = !TIMESHEET_LOCKED && canBuildTimesheet(clipFrames, fps)
  const visible = ready && open
  const total = clipFrames?.pts.length ?? 0
  // 元の動画のコマの並び（抜けの位置に空のコマが入る）。表示も書き出しもこれを母数にする
  // ——表の行をそのまま並べると、抜けたぶんだけ下が詰まって番号が元の動画とずれる。
  const rows = useMemo(() => timesheetRows(clipFrames), [clipFrames])
  // 専用の絵が撮れなかったコマ数。**番号はずれていない**（canBuildTimesheet の注記）が、
  // そのコマは直前と同じ絵が出ているだけなので、そこで新しい絵が始まっていても見えない。
  // 表を開くと詳細パネルが隠れるため、打っている場所から読めるのはここだけ。
  const reused = countReusedFrames(clipFrames)

  // クリップが変わったら全部引き直す。**開いたままにはしない**——別のクリップでいきなり
  // 打てる状態になっていると、隣のクリップに打ち込む事故が起きる。
  useEffect(() => {
    setClipFrames(null)
    setCurrent(0)
    setCurrentGap(0)
    setMarks([])
    setPending('')
    setCopied(false)
    setOpen(false)
    if (imageId == null) return
    let canceled = false
    window.api.getTimesheet(imageId)
      .then((json) => { if (!canceled) setMarks(decodeTimesheet(json)) })
      .catch((err) => console.warn('[timesheet] load failed', err))
    return () => { canceled = true }
  }, [imageId])

  const onFramesReady = useCallback((frames: ClipFrames | null) => setClipFrames(frames), [])
  // コマが動いたら打ちかけは捨てる。打った番号がどのコマのものか曖昧になるより、
  // 打ち直してもらう方がよい。
  const onFrameIndex = useCallback((idx: number, gap: number) => {
    setCurrent(idx)
    setCurrentGap(gap)
    setPending('')
  }, [])

  const apply = useCallback((next: TimesheetMark[]): void => {
    setMarks(next)
    setCopied(false)
    if (imageId != null) {
      window.api.saveTimesheet(imageId, encodeTimesheet(next)).catch((err) => console.warn('[timesheet] save failed', err))
    }
  }, [imageId])

  const setMemo = useCallback((frame: number, memo: string): void => {
    setMarks((prev) => {
      const next = prev.map((m) => (m.frame === frame ? { ...m, memo: memo || undefined } : m))
      if (imageId != null) {
        window.api.saveTimesheet(imageId, encodeTimesheet(next)).catch((err) => console.warn('[timesheet] save failed', err))
      }
      return next
    })
    setCopied(false)
  }, [imageId])

  const copy = useCallback(async (): Promise<void> => {
    try {
      // 打った内容は表の行の添字で持っている。書き出すときだけ、抜けを含めた並びの
      // 位置へ移す（そうしないと貼り付け先で抜けたぶんだけ上へずれる）。
      await navigator.clipboard.writeText(buildToeiClipboard(expandMarks(marks, rows), rows.length))
      setCopied(true)
    } catch (err) {
      console.warn('[timesheet] clipboard write failed', err)
    }
  }, [marks, rows])

  const bindPlayer = useCallback((player: TimesheetPlayer | null) => { playerRef.current = player }, [])
  const seek = useCallback((frame: number) => playerRef.current?.goToFrame(frame), [])

  // 表を開いている間だけ、キーをこちらで取る。取ったら true を返す。
  const handleKey = useCallback((e: KeyboardEvent): boolean => {
    if (!visible) return false
    const player = playerRef.current

    const bare = !e.ctrlKey && !e.metaKey && !e.altKey
    // 推定抜けには保存先となる実測行が無い。移動キーは通すが、入力は受け取って捨てる。
    const inGap = currentGap > 0
    // ○ / ● / × は 1 つで 1 マスぶんなので、打ちかけがあっても置き換える。
    if (bare && SYMBOL_KEYS[e.key]) {
      e.preventDefault()
      if (!inGap) setPending(SYMBOL_KEYS[e.key])
      return true
    }

    // 1 文字の半角英数字はそのまま動画番号へ。修飾キー付きは既存のショートカットに譲る。
    // 記号を打った後に数字を打ったら、記号を捨てて番号の入力に切り替える。
    if (bare && e.key.length === 1 && /[0-9A-Za-z]/.test(e.key)) {
      e.preventDefault()
      if (!inGap) setPending((p) => normalizeTimesheetValue(isToeiSymbol(p) ? e.key : p + e.key))
      return true
    }

    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      if (inGap) { player?.stepFrame(1); return true }
      const value = normalizeTimesheetValue(pending)
      const without = marks.filter((m) => m.frame !== current)
      apply([...without, value ? { frame: current, value } : { frame: current }].sort((a, b) => a.frame - b.frame))
      setPending('')
      player?.stepFrame(1)
      return true
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      if (inGap) return true
      // 記号は 1 文字ずつ削れない（綴りが崩れるだけ）ので、まるごと捨てる。
      if (pending) setPending((p) => (isToeiSymbol(p) ? '' : p.slice(0, -1)))
      else apply(marks.filter((m) => m.frame !== current))
      return true
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      player?.stepFrame(e.key === 'ArrowDown' ? 1 : -1)
      return true
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (pending) setPending('')
      else setOpen(false)
      return true
    }

    return false
  }, [visible, pending, marks, current, currentGap, apply])

  return {
    ready, visible, open, setOpen, total, rows, current, currentGap, marks, pending, copied, reused,
    onFramesReady, onFrameIndex, setMemo, copy, handleKey, bindPlayer, seek,
  }
}

export type Timesheet = ReturnType<typeof useTimesheet>
