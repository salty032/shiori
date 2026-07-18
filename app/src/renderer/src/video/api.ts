import type { ShioriApi } from '../../../shared/api'
import type { VideoApi } from '../../../shared/api.video'

// window.api の型はコア ShioriApi のみ（capture 版が実体を持つため）。full 版では
// preload/index.full.ts が実際に動画メソッドも実装済みなので、video/ 配下からだけ
// ローカルにキャストして使う（コアの Window.api 型は変えない）。
export const videoApi = window.api as unknown as ShioriApi & VideoApi
