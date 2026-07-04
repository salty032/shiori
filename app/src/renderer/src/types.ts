export type {
  TagMode, SortOrder, ImageTagSource, ImageSource, ImageRow, ImageTag,
  SmartFolder, Settings, CaptureData, ExtensionTimecode, AppNotice,
  DeleteImageResult,
  ImageQuery, ImageListRequest,
} from '../../shared/types'

import type { ShioriApi } from '../../shared/api'

declare global {
  interface Window {
    // window.api の型は preload と共有の契約（ShioriApi）に一本化されている。
    // 実装（preload/index.ts）はこの型で縛られるため、両者がズレることはない。
    api: ShioriApi
  }
}
