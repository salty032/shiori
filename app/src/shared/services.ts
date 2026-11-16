// 対応サービスのホストと表示名。**アプリの一覧はここだけ**。画面（サイドバーの並びと表示名）が読み、
// 拡張の manifest に全部のホストが入っていることと、デモ素材の目録が表に無いホストを使っていないことは
// services.test.ts が確かめる（manifest はストアの審査を通る配布物なので、生成はしない）。
// サービスを足すときは、拡張側（manifest・content.js の表）にも足す。

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

// host → 表示名の表。**上の一覧から作る**（別々に書くと、片方だけに足したときサイドバーの並びと
// 表示名が食い違う）。
export const SITE_NAME_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  SUPPORTED_SERVICES.flatMap((service) => service.hosts.map((host) => [host, service.label]))
)
