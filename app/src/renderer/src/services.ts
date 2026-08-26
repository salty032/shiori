import { siteName } from './utils'

type SupportedService = {
  label: string
  hosts: string[]
}

export const SUPPORTED_SERVICES: SupportedService[] = [
  { label: 'YouTube', hosts: ['youtube.com'] },
  { label: 'Netflix', hosts: ['netflix.com'] },
  { label: 'Prime Video', hosts: ['amazon.co.jp', 'primevideo.com'] },
  { label: 'Disney+', hosts: ['disneyplus.com'] },
  { label: 'ABEMA', hosts: ['abema.tv'] },
  { label: 'U-NEXT', hosts: ['video.unext.jp'] },
  { label: 'niconico', hosts: ['nicovideo.jp'] },
  { label: 'DMM TV', hosts: ['tv.dmm.com'] },
  { label: 'dアニメストア', hosts: ['animestore.docomo.ne.jp'] },
  { label: 'Bilibili', hosts: ['bilibili.com', 'bilibili.tv'] },
]

export const DEFAULT_SERVICE_ORDER = SUPPORTED_SERVICES.map((service) => service.label)

// host（例: youtube.com）→ 表示名（例: YouTube）。未知ホストは host をそのまま返す。
export function serviceLabel(host: string): string {
  return siteName(`https://${host}`) ?? host
}
