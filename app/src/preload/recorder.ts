import { contextBridge, ipcRenderer } from 'electron'
import type { BenchRequest, PrepareData, RecorderApi, StartData } from '../shared/recorder-api'
import { RECORDER_CH } from '../shared/recorder-api'

// recorder:* はレコーダーウィンドウ専用の別契約（RecorderApi）で、ShioriApi の CH 定数の
// 対象外（main 側の検証も isTrustedRecorderSender と別方式）。名前は RECORDER_CH（同じ shared/recorder-api.ts）。
// 型注釈は飾りではない。レコーダー側も同じ RecorderApi を見るので、形がずれるとここで落ちる。
const recorderApi: RecorderApi = {
  // 画面キャプチャの立ち上げまで（記録は始めない）。**重いのはこちら**なので、落ち着き待ちの
  // 前に済ませる（recording.ts / recorder.ts の注記）。
  onPrepare: (cb: (data: PrepareData) => void) => {
    ipcRenderer.on(RECORDER_CH.prepare, (_e, data) => cb(data))
  },
  // 準備が済んだ合図。main はこれを受けてから、コマ通知が落ち着くのを待つ。
  reportReady: (sessionId: number) => {
    ipcRenderer.send(RECORDER_CH.ready, sessionId)
  },
  reportStartBoundary: (sessionId: number, confirmed: boolean) => {
    ipcRenderer.send(RECORDER_CH.startBoundary, sessionId, confirmed)
  },
  onStart: (cb: (data: StartData) => void) => {
    ipcRenderer.on(RECORDER_CH.start, (_e, data) => cb(data))
  },
  onStop: (cb: () => void) => {
    ipcRenderer.on(RECORDER_CH.stop, () => cb())
  },
  getCrop: (streamW: number, streamH: number) =>
    ipcRenderer.invoke(RECORDER_CH.getCrop, streamW, streamH),
  // drawnAt: 供給した各フレームが画面から取り込まれた時刻（epoch ミリ秒）。
  // 配信ページ側から届く素材のコマ時刻と突き合わせ、素材のコマとファイル内の
  // フレームを対応付けるために使う。
  // diag: 供給の実測値（診断ログ専用。main 側の capture-diag.ts が検証して使う）。
  sendDone: (webm, duration, sessionId, drawnAt, diag) => {
    ipcRenderer.send(RECORDER_CH.done, webm, duration, sessionId, drawnAt, diag)
  },
  // 録画が実際に止まった時点の合図。重い後処理（尺補正・ArrayBuffer 化・IPC 転送）の
  // 前に出し、main 側でプレーヤー UI の復帰だけを先に流させる。
  reportStopped: (sessionId: number) => {
    ipcRenderer.send(RECORDER_CH.stopped, sessionId)
  },
  reportError: (msg, sessionId) => {
    ipcRenderer.send(RECORDER_CH.error, msg, sessionId)
  },
  // 供給レートの計測（開発時のみ。main の supply-bench.ts が駆動する）。
  onBench: (cb: (data: BenchRequest) => void) => {
    ipcRenderer.on(RECORDER_CH.bench, (_e, data) => cb(data))
  },
  sendBenchResult: (results) => {
    ipcRenderer.send(RECORDER_CH.benchResult, results)
  }
}

contextBridge.exposeInMainWorld('recorderApi', recorderApi)
