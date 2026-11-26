// 同じ失敗を、直るまで一度だけ知らせる。
//
// ホットキーは起動時に登録し、他のアプリに握られていたら Shiori のウィンドウを触るたびに取り直す。
// 取り直しのたびに「登録できませんでした」を出すと、起動時のぶんと重なって二重に出た（録画の Alt+D は
// 抑える仕組みが無く、静止画の Alt+S は起動時の失敗を「知らせた」に数えていなかった）。
// 起動時と取り直しで同じ 1 つを使い、登録できたら次の失敗をまた知らせる。
export function notifyUntilFixed(send: (message: string) => void): {
  onError: (message: string) => void
  result: (ok: boolean) => void
} {
  let notified = false
  return {
    onError: (message) => {
      if (notified) return
      notified = true
      send(message)
    },
    result: (ok) => {
      if (ok) notified = false
    },
  }
}
