// video/ 配下から使う window.api。グローバル宣言（renderer/src/types.ts）が
// AppApi = ShioriApi & VideoApi なので、キャストは要らない。
// 参照をこの 1 か所に集めているのは、動画機能を持たない構成を切り出すときに
// 差し替える場所を 1 つにしておくため。
export const videoApi = window.api
