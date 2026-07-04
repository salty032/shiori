import { contextBridge } from 'electron'
import { buildCoreApi } from './api-core'

contextBridge.exposeInMainWorld('api', buildCoreApi())
