// tagger-host.ts（utilityProcess）を、onnxruntime-node と同じ形で呼べるようにする。
// tagger.ts は ortModule.InferenceSession.create / Tensor / session.run / release しか
// 使わないので、その形だけを揃える。推論をメインで回さない理由は tagger-host.ts の冒頭。
//
// プロセスを終わらせればモデルのメモリは確実に戻るので、release は kill で済ませる。
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'

type HostMessage =
  | { type: 'loaded'; inputNames: string[]; outputNames: string[] }
  | { type: 'load-error'; message: string }
  | { type: 'result'; id: number; data: Float32Array }
  | { type: 'run-error'; id: number; message: string }

class Tensor {
  constructor(readonly type: 'float32', readonly data: Float32Array, readonly dims: number[]) {}
}

export class TaggerProcessSession {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (d: Float32Array) => void; reject: (e: Error) => void }>()
  private exited = false
  private exitListener: (() => void) | null = null

  private constructor(
    private readonly child: UtilityProcess,
    readonly inputNames: string[],
    readonly outputNames: string[]
  ) {
    child.on('message', (msg: HostMessage) => {
      if (msg.type !== 'result' && msg.type !== 'run-error') return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.type === 'result') p.resolve(msg.data)
      else p.reject(new Error(msg.message))
    })
    child.once('exit', (code) => {
      this.exited = true
      for (const p of this.pending.values()) p.reject(new Error(`Tagger process exited (code ${code})`))
      this.pending.clear()
      this.exitListener?.()
    })
  }

  static create(modelPath: string): Promise<TaggerProcessSession> {
    const child = utilityProcess.fork(join(__dirname, 'tagger-host.js'), [], { serviceName: 'Shiori Tagger' })
    return new Promise((resolve, reject) => {
      const onExit = (code: number): void => reject(new Error(`Tagger process exited while loading (code ${code})`))
      child.once('exit', onExit)
      child.once('message', (msg: HostMessage) => {
        child.off('exit', onExit)
        if (msg.type === 'loaded') {
          resolve(new TaggerProcessSession(child, msg.inputNames, msg.outputNames))
        } else {
          child.kill()
          reject(new Error(msg.type === 'load-error' ? msg.message : `Unexpected message: ${msg.type}`))
        }
      })
      child.postMessage({ type: 'load', modelPath })
    })
  }

  // プロセスが落ちたとき（クラッシュ・OOM）に呼ぶ。tagger.ts が session を捨てて、
  // 次のタグ付けで起動し直せるようにするため。
  onExit(listener: () => void): void {
    this.exitListener = listener
  }

  run(feeds: Record<string, Tensor>): Promise<Record<string, { data: Float32Array }>> {
    if (this.exited) return Promise.reject(new Error('Tagger process has exited'))
    const [inputName, tensor] = Object.entries(feeds)[0]
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (data) => resolve({ [this.outputNames[0]]: { data } }),
        reject
      })
      this.child.postMessage({ type: 'run', id, inputName, data: tensor.data, dims: tensor.dims })
    })
  }

  async release(): Promise<void> {
    if (this.exited) return
    this.exitListener = null
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    this.child.kill()
    await exited
  }
}

export const taggerProcessOrt = {
  InferenceSession: { create: (modelPath: string) => TaggerProcessSession.create(modelPath) },
  Tensor
}
