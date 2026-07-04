import { useRef } from 'react'

// 空依存（mount 時 1 回だけ登録する）イベントハンドラから「常に最新の値」を読むための ref。
// グローバルキー/IPC 購読のように再購読したくない箇所で、クロージャの陳腐化を避ける。
// App 各所に散っていた `const xRef = useRef(x); xRef.current = x` を 1 箇所に集約したもの。
export function useLatestRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}
