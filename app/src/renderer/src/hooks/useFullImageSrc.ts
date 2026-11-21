import { useEffect, useState } from 'react'
import { mediaUrl } from '../utils'

// 画像の原本の URL を、読み込み（デコード）が終わってから返す。それまでは null で、呼び出し側は
// サムネを出しておく。矢印キーで続けて移ったときに、原本の読み込み待ちで表示が遅れる・白く
// 抜けるのを防ぐ（R-7）。ビューアと詳細パネルが同じことを別々に書いていたのをまとめた。
// 動画は <img> で読めず捨てられるだけなので読まない（null のまま）。
export function useFullImageSrc(id: number | null | undefined, isVideo: boolean): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (id == null || isVideo) return
    let canceled = false
    const preload = new Image()
    preload.onload = () => { if (!canceled) setSrc(mediaUrl(id)) }
    preload.src = mediaUrl(id)
    return () => { canceled = true }
  }, [id, isVideo])
  return src
}
