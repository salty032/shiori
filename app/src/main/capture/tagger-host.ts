// WD Tagger の推論だけを受け持つ utilityProcess（tagger-process.ts が起動する）。
//
// **メインプロセスで推論しない理由。** onnxruntime-node はモデルの読み込みも推論も
// 呼んだスレッドで同期に走る（run は setImmediate で包んであるだけ）。メインで回すと
// その間イベントループが止まり、グローバルホットキーの受付・拡張とのやり取り・
// 画面への通知がまとめて待たされる（実測で推論 1 枚約 0.25 秒・読み込み約 0.6 秒）。
// 撮った直後にもう 1 枚押すと、ちょうどこの推論に当たる。
import * as ort from 'onnxruntime-node'

type InMessage =
  | { type: 'load'; modelPath: string }
  | { type: 'run'; id: number; inputName: string; data: Float32Array; dims: number[] }

let session: ort.InferenceSession | null = null

process.parentPort.on('message', async (event) => {
  const msg = event.data as InMessage
  if (msg.type === 'load') {
    try {
      session = await ort.InferenceSession.create(msg.modelPath)
      process.parentPort.postMessage({
        type: 'loaded',
        inputNames: [...session.inputNames],
        outputNames: [...session.outputNames]
      })
    } catch (err) {
      process.parentPort.postMessage({ type: 'load-error', message: String(err) })
    }
    return
  }
  if (msg.type === 'run') {
    try {
      if (!session) throw new Error('Model not loaded in tagger process')
      const tensor = new ort.Tensor('float32', msg.data, msg.dims)
      const output = await session.run({ [msg.inputName]: tensor })
      const data = output[session.outputNames[0]].data as Float32Array
      process.parentPort.postMessage({ type: 'result', id: msg.id, data })
    } catch (err) {
      process.parentPort.postMessage({ type: 'run-error', id: msg.id, message: String(err) })
    }
  }
})
