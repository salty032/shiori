import { usePanelResize } from './usePanelResize'
import { useWindowWidth } from './useWindowWidth'
import { DETAIL_MIN_WIDTH, DETAIL_MAX_WIDTH, DETAIL_DEFAULT_WIDTH, panelLimits } from '../layout'

// 右側のパネル（詳細パネルとタイムシート）の幅。**2 つは同じ幅を共有する**（保存先も同じ）。
// 入れ替わっても幅が変わらないので左の一覧が動かず、片方を広げればもう片方も同じ幅になる。
// 以前は同じ設定を両方のパネルに書いていて、片方だけ直すと入れ替えるたびに幅が跳ねた。
export function useDetailPanelWidth(): ReturnType<typeof usePanelResize> {
  const windowWidth = useWindowWidth()
  return usePanelResize({
    storageKey: 'shiori-detail-width',
    min: DETAIL_MIN_WIDTH,
    max: DETAIL_MAX_WIDTH,
    defaultWidth: DETAIL_DEFAULT_WIDTH,
    direction: 'left',
    limit: panelLimits(windowWidth).detail,
  })
}
