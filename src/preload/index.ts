import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type PingResponse, type RendererApi } from '../shared/protocol'

/** 暴露给渲染进程的 api 表面（contextBridge 隔离，渲染层不接触 ipcRenderer）。 */
const api: RendererApi = {
  ping: () => ipcRenderer.invoke(IpcChannel.Ping) as Promise<PingResponse>
}

contextBridge.exposeInMainWorld('api', api)
