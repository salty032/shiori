import { contextBridge } from 'electron'
import type { AppApi } from '../shared/api.video'
import { buildCoreApi } from './api-core'
import { buildVideoApi } from './video-api'

// 型注釈は飾りではない。renderer 側のグローバル（renderer/src/types.ts）も AppApi なので、
// ここで公開する形が欠けると renderer ではなくこの行でコンパイルが落ちる。
const api: AppApi = { ...buildCoreApi(), ...buildVideoApi() }

contextBridge.exposeInMainWorld('api', api)
