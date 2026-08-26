import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  WS_PORTS, MAX_UI_HOLD_MS, FRAME_WATCHDOG_MS, TIMECODE_POLL_MS,
  renderExtensionBlocks, readGeneratedBlock,
} from '../../shared/wire-limits'
import { NAMED_CAPTURE_KEY_VALUES } from '../../shared/hotkey'
import { backgroundJs, contentJs, keyGuardJs, manifestJson } from './extension-source'

// extension/background.js・content.js はバンドラ無しで配布されるため、app 側の定数を
// import できない。以前は同じ数値を手で書き写し、このテストが拡張のソースを正規表現で
// 切り出して突き合わせていた（L-1 の指摘）。今は shared/wire-limits.ts が唯一の原本で、
// 拡張の const 行は `npm run ext:limits` が目印の内側へ生成する。
//
// **ここで見るのは 2 つだけ** — 生成し直し忘れと、目印の内側の手書き換え。どちらも
// 起きても画面には何も出ない（拡張は黙って古い値で動き続ける）ので、ここで落とす。
describe('拡張の定数は wire-limits.ts からの生成物（L-1）', () => {
  const sources: Record<string, string> = { 'background.js': backgroundJs, 'content.js': contentJs }
  for (const block of renderExtensionBlocks(NAMED_CAPTURE_KEY_VALUES)) {
    it(`extension/${block.file} の「${block.id}」が生成結果と一致する（ずれていたら npm run ext:limits）`, () => {
      expect(readGeneratedBlock(sources[block.file], block.id)).toBe(block.text)
    })
  }
})

// 値そのものの妥当性は原本（TypeScript 側）だけ見れば足りる。拡張へ写った値が同じことは
// 上のブロック比較が保証している。
describe('原本の値が満たすべき条件', () => {
  it('ポート候補の先頭は従来のポートのまま（更新直後に既存利用者が候補探しをしないため）', () => {
    expect(WS_PORTS[0]).toBe(39821)
  })

  it('候補どうしが十分に離れている（予約はブロック単位で来るため隣は同時に潰れる）', () => {
    for (let i = 1; i < WS_PORTS.length; i++) {
      expect(WS_PORTS[i] - WS_PORTS[i - 1]).toBeGreaterThanOrEqual(1000)
    }
    // Windows の既定の動的ポート範囲（49152-65535）より下に置き、OS の自動割り当てと
    // 衝突しないようにする。
    for (const port of WS_PORTS) expect(port).toBeLessThan(49152)
  })

  it('UI 非表示の上限がクリップ最長（30秒）＋停止マージンを十分に上回る', () => {
    // 上限がクリップ長を下回ると、録画中に強制復元が走ってプレーヤー UI が写り込む。
    expect(MAX_UI_HOLD_MS).toBeGreaterThan((30 + 10) * 1000)
  })

  it('録画中の復帰確認はタイムコードの定期送信より十分に短い間隔で回る', () => {
    // rVFC ループは <video> の差し替えで止まる。復帰が定期送信頼みだと、30 秒クリップの
    // 1/6 でコマ通知が途切れたままになる。
    expect(FRAME_WATCHDOG_MS).toBeLessThan(TIMECODE_POLL_MS / 4)
    expect(FRAME_WATCHDOG_MS).toBeGreaterThanOrEqual(100)   // 無駄に回さない下限
  })
})

// ここから下は値ではなく**受け渡しの経路**。生成では固定できないので、拡張のソースを
// 読んで「途中の段で落ちていないか」を見る。
describe('extension との受け渡しの経路', () => {
  // 素材のコマ間隔は content.js が測り、background.js が中継し、ws-server.ts が受ける。
  // **background.js の normalizePortMessage は項目を1つずつ書き写して作り直す**ので、
  // そこに書き足し忘れると content.js が送っていても消える。実際にそれで「ビットレートが
  // 素材 fps に連動しない」状態になった（2026-08-13）。3 段すべてを固定する。
  it('素材のコマ間隔が content.js → background.js の両方を素通りする', () => {
    expect(contentJs).toMatch(/frameDurMs:\s*measuredFrameDur\s*!=\s*null/)
    expect(backgroundJs).toMatch(/frameDurMs:\s*boundedNumber\(\s*msg\.frameDurMs/)
  })

  // コマ送りの読み取り表示に出す文言は extension-bridge.ts（原本は ja.ts）→ background.js →
  // content.js の3段を通る。**拡張は文言を持たない**ので、どこか1段でも落ちると
  // 「これ以上進めません」が黙って空文字になり、動けなかったことが画面から消える。
  it('コマ送りの文言が main → background.js → content.js の3段を素通りする', () => {
    const bridgeTs = readFileSync(join(__dirname, './extension-bridge.ts'), 'utf-8')
    const bootstrapTs = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf-8')
    // 拡張へ渡すのは接続時（extension-bridge）と設定変更時（bootstrap）の2経路。両方見る。
    expect(bridgeTs).toMatch(/stepLabels: browserStepLabels\(\)/)
    expect(bootstrapTs).toMatch(/stepLabels: browserStepLabels\(\)/)
    expect(bridgeTs).toMatch(/blocked: t\('video\.stepBlocked'\), dropped: t\('video\.stepDropped'\)/)
    for (const src of [backgroundJs, contentJs]) {
      expect(src).toMatch(/blocked: stepLabel\(msg\.stepLabels\?\.blocked\)/)
      expect(src).toMatch(/dropped: stepLabel\(msg\.stepLabels\?\.dropped\)/)
    }
  })
})

describe('録画停止後のプレーヤー UI 復帰（post-capture の immediate）', () => {
  // ホスト別の復帰待ちはスクリーンショット用に調整された値。クリップでは合図が「録画が
  // 実際に止まった後」にしか来ないので、待っても写り込みは防げず停止から数秒 UI が
  // 戻らないだけになる。クリップだけこの待ちを飛ばす経路を、両端で固定する。
  const delayFn = contentJs.match(/function restoreDelayFor\(host, immediate\)[\s\S]*?\n}/)?.[0] ?? ''
  const delayTable = contentJs.match(/const POST_CAPTURE_RESTORE_DELAY_BY_HOST = \{[\s\S]*?\n\}/)?.[0] ?? ''
  const defaultDelay = contentJs.match(/const DEFAULT_POST_CAPTURE_RESTORE_DELAY_MS = [^\n]+/)?.[0] ?? ''
  // eslint-disable-next-line no-new-func
  const restoreDelayFor = Function(`"use strict";
${defaultDelay}
${delayTable}
${delayFn}
return restoreDelayFor`)() as (host: string, immediate: boolean) => number

  it('immediate なら待たない', () => {
    expect(restoreDelayFor('youtube.com', true)).toBe(0)
    expect(restoreDelayFor('example.test', true)).toBe(0)
  })

  it('immediate でなければ従来どおりホスト別に待つ（スクショの挙動を変えない）', () => {
    expect(restoreDelayFor('youtube.com', false)).toBeGreaterThan(0)
    // 表に無いホストも既定値で待つ
    expect(restoreDelayFor('example.test', false)).toBeGreaterThan(0)
  })

  it('immediate が background.js / content.js の検疫を素通りする', () => {
    // どちらかが落とすと、印を付けても届かず待ちが残る（三重実装・M-1 と同じ形）。
    expect(backgroundJs).toContain("{ type: 'post-capture', immediate: msg.immediate === true }")
    expect(contentJs).toContain("{ type: 'post-capture', immediate: msg.immediate === true }")
  })

  it('印を付けるのは録画側だけで、スクリーンショット側は従来どおり', () => {
    const recordingTs = readFileSync(join(__dirname, '../video/recording.ts'), 'utf-8')
    const bootstrapTs = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf-8')
    expect(recordingTs).toContain("broadcastMessage({ type: 'post-capture', immediate: true })")
    expect(bootstrapTs).toContain("broadcastMessage({ type: 'post-capture' })")
    expect(bootstrapTs).not.toContain('immediate: true')
  })
})

// 録画の「準備中」表示（clip-arming / clip-armed）。
// **実際にここで落ちた**（2026-08-26）: content.js には表示を書いたのに background.js の
// 検疫とタブ振り分けの両方へ足しておらず、合図が 1 つも届かなかった。**画面には何も出ず、
// 録画は普通に成功する**ので、実機で押してみるまで気づけない。三重実装（M-1）の典型。
describe('録画の準備中表示（clip-arming / clip-armed）', () => {
  it('background.js の検疫を通る', () => {
    expect(backgroundJs).toContain("{ type: 'clip-arming', label: stepLabel(msg.label) }")
    expect(backgroundJs).toContain("{ type: 'clip-armed' }")
  })

  // **文言は app 側（ja.ts）が原本で、拡張は 1 語も持たない。** 途中の段で落ちると
  // 丸だけが出て文字が消えるか、拡張に日本語を書き戻すことになる（英語表示の人にだけ
  // 日本語が出て、こちらからは永久に気づけない）。3 段とも固定する。
  it('準備中の文言が main → background.js → content.js の3段を素通りする', () => {
    const recordingTs = readFileSync(join(__dirname, '../video/recording.ts'), 'utf-8')
    expect(recordingTs).toContain("broadcastMessage({ type: 'clip-arming', label: t('video.clipArming') })")
    for (const src of [backgroundJs, contentJs]) {
      expect(src).toContain("{ type: 'clip-arming', label: stepLabel(msg.label) }")
    }
    expect(contentJs).toContain('showArmingOverlay(safeMsg.label)')
    // 拡張に日本語が焼き付いていないこと（オーバーレイの中身は app から来た文字だけ）
    expect(contentJs).not.toContain("label.textContent = '録画の準備中'")
  })

  it('background.js がアクティブタブへ振り分ける（全ポートに配ると裏のタブに残る）', () => {
    expect(backgroundJs).toContain(
      "['request-timecode', 'pre-capture', 'post-capture', 'notice', 'clip-arming', 'clip-armed']"
    )
  })

  it('content.js の検疫を通り、表示の出し／消しに繋がっている', () => {
    expect(contentJs).toContain("{ type: 'clip-arming', label: stepLabel(msg.label) }")
    expect(contentJs).toContain("{ type: 'clip-armed' }")
    expect(contentJs).toContain('showArmingOverlay(safeMsg.label)')
    expect(contentJs).toContain('hideArmingOverlay()')
  })

  it('録画側が出して、消してから撮り始める（順序が逆だと録画に写る）', () => {
    const recordingTs = readFileSync(join(__dirname, '../video/recording.ts'), 'utf-8')
    const arming = recordingTs.indexOf("broadcastMessage({ type: 'clip-arming'")
    const armed = recordingTs.indexOf("broadcastMessage({ type: 'clip-armed' })")
    const start = recordingTs.indexOf("send('recorder:start'")
    expect(arming).toBeGreaterThan(-1)
    expect(armed).toBeGreaterThan(arming)
    expect(start).toBeGreaterThan(armed)
  })
})

describe('コマ通知が途切れる経路（content.js の rVFC ループ）', () => {
  it('録画中にトラッカーが止まったら main へ知らせる', () => {
    // 途切れた区間のコマは表に入らず、撮り逃しの枚数にも割合にも現れない。
    // 黙って通すと「最も精度が良く見えるクリップの後半が対応していない」形になる。
    const stopFn = contentJs.match(/function stopFrameTracker\(\)[\s\S]*?\n}/)?.[0] ?? ''
    expect(stopFn).toContain('reportingFrames')
    expect(stopFn).toContain('reportFrameGap()')
  })

  it('同じ <video> 要素でもトラッカーの生存を確かめ直す', () => {
    // 要素が一時的に DOM から外れるだけでもループは自分で止まる。observedVideo が
    // 変わらないため、ここで早期 return すると二度と復帰しない経路だった。
    const observeFn = contentJs.match(/function observeVideo\(video\)[\s\S]*?\n}/)?.[0] ?? ''
    expect(observeFn).toMatch(/video === observedVideo\s*\)\s*\{\s*startFrameTracker\(video\)/)
  })

  it('frame-gap は background.js と ws-server.ts の両方で素通しされる', () => {
    // 片側だけだと中継の途中で落ちて、知らせが届かない。
    const wsServerTs = readFileSync(join(__dirname, './ws-server.ts'), 'utf-8')
    expect(backgroundJs).toContain("msg.type === 'frame-gap'")
    expect(wsServerTs).toContain("msg.type === 'frame-gap'")
  })
})

describe('コマ送りのキー入口（key-guard.js → content.js）', () => {
  // 入口（key-guard.js）と中身（content.js）を別ファイルに分けた代償として、**片方だけ直すと
  // キーが黙って死ぬ**（押しても何も起きないだけで、原因は画面からもログからも読めない）。
  // 名前の一致と、早く走ることの 2 点をここで固定する。
  const manifest = JSON.parse(manifestJson) as {
    content_scripts: { js: string[]; run_at?: string; matches: string[] }[]
  }
  const guardEntry = manifest.content_scripts.find((s) => s.js.includes('key-guard.js'))
  const contentEntry = manifest.content_scripts.find((s) => s.js.includes('content.js'))

  it('受け渡しの名前が両側で一致する', () => {
    expect(contentJs).toContain('window.__shioriFrameStepKey = (dir)')
    expect(keyGuardJs).toContain('window.__shioriFrameStepKey')
  })

  it('キーの入口は document_start で、content.js より先に走る', () => {
    // **ここが document_idle に戻ると DMM TV の倍速が復活する**（サイトのハンドラが先に
    // 登録され、こちらの stopImmediatePropagation では止まらない）。コマ送りは効いたままなので、
    // 倍速が変わっていることに気づけない＝素材の時間軸が打鍵のたびに伸縮する。
    expect(guardEntry?.run_at).toBe('document_start')
    expect(contentEntry?.run_at).toBe('document_idle')
  })

  it('入口は window のキャプチャ段階に立つ', () => {
    // document ではサイトが document 自身へ登録したハンドラを止められない
    // （イベントは window → document の順に降りるため）。
    expect(keyGuardJs).toMatch(/window\.addEventListener\('keydown',[\s\S]*?\}, true\)/)
  })

  it('奪ったキーは keydown だけでなく keypress / keyup も塞ぐ', () => {
    // **keydown だけ塞いだ版では DMM TV の倍速が変わり続けた**（コマ送りは正常に効くので、
    // 倍速が変わっていることに気づけない＝素材の時間軸が打鍵のたびに伸縮する）。
    // サイトがどのイベントを見ているかは分からないので、3 つとも塞ぐ。
    for (const type of ['keydown', 'keypress', 'keyup']) {
      expect(keyGuardJs, type).toContain(`window.addEventListener('${type}'`)
    }
    expect(keyGuardJs).toMatch(/window\.addEventListener\('keypress', shioriSwallowTail, true\)/)
    expect(keyGuardJs).toMatch(/window\.addEventListener\('keyup', shioriSwallowTail, true\)/)
  })

  it('入口は content.js と同じサイトで動く', () => {
    // 片方にだけサービスを足すと、そのサイトだけコマ送りが効かない（または倍速が混ざる）。
    expect(guardEntry?.matches).toEqual(contentEntry?.matches)
  })

  it('動画が無いページではサイトの , / . を奪わない', () => {
    // 一覧・検索ページでサイト本来のキーを潰すと、拡張が壊しているとは気づけない。
    expect(keyGuardJs).toContain('if (!step(')
    expect(contentJs).toMatch(/const video = getVideo\(\)\s*\n\s*if \(!video\) return false/)
  })
})
