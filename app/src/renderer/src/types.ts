export type {
  TagMode, SortOrder, ImageTagSource, ImageSource, ImageRow, ImageTag, TagWithCount,
  SmartFolder, Settings, CaptureData, ExtensionTimecode, AppNotice, StorageInfo,
  DeleteImageResult,
  ImageQuery, ImageListRequest,
} from '../../shared/types'

import type { AppApi } from '../../shared/api.video'

declare global {
  interface Window {
    // window.api の型は preload と共有の契約（AppApi = ShioriApi & VideoApi）に
    // 一本化されている。実装（preload/index.ts）も同じ型で縛られるため、
    // 片方から消せばもう片方のコンパイルが落ちる。
    api: AppApi
  }
}
