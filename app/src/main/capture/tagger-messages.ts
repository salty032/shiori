// tagger-process.ts（メイン側）と tagger-host.ts（推論プロセス側）がやり取りするメッセージ。
// **両側ともこの型で送り、この型で受ける。** 片側だけ型があると、送る形を変えても型チェックが通る。
// tagger-host は別の出力に入るので、ここには型以外を置かない。

export type TaggerInMessage =
  | { type: 'load'; modelPath: string }
  | { type: 'run'; id: number; inputName: string; data: Float32Array; dims: number[] }

export type TaggerHostMessage =
  | { type: 'loaded'; inputNames: string[]; outputNames: string[] }
  | { type: 'load-error'; message: string }
  | { type: 'result'; id: number; data: Float32Array }
  | { type: 'run-error'; id: number; message: string }
