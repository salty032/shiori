import { contextBridge } from 'electron'
import { buildCoreApi } from './api-core'
import { buildVideoApi } from './video-api'

contextBridge.exposeInMainWorld('api', { ...buildCoreApi(), ...buildVideoApi() })
