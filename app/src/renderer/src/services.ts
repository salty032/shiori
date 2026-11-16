import { urlHost } from '../../shared/url-host'

export { SUPPORTED_SERVICES, DEFAULT_SERVICE_ORDER, SITE_NAME_MAP } from '../../shared/services'
import { SITE_NAME_MAP } from '../../shared/services'

// host（例: youtube.com）→ 表示名（例: YouTube）。未知ホストは host をそのまま返す。
export function serviceLabel(host: string): string {
  const normalized = urlHost(`https://${host}`)
  return normalized == null ? host : SITE_NAME_MAP[normalized] ?? normalized
}
