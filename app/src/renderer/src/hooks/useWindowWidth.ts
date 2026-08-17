import { useEffect, useState } from 'react'

// パネル幅の上限をウィンドウ幅から決めるために使う（layout.ts の panelLimits）。
// リサイズ中は連続で発火するが、返すのは数値ひとつで、同じ値なら React 側で再描画されない。
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    // 初回に一度読み直す。マウントまでの間にウィンドウが変わっていても取りこぼさない。
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}
