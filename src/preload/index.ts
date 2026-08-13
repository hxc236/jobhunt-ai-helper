import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createRendererApi, type IpcBridge } from './api'
import type { RendererApi } from '../shared/protocol'

/** 将 Electron ipcRenderer 收窄为 IpcBridge（其余能力不外泄给渲染进程）。 */
const bridge: IpcBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

/** 暴露给渲染进程的 api 表面（contextBridge 隔离，渲染层不接触 ipcRenderer）。 */
const api = createRendererApi(bridge)
// Electron 32+ 移除 File.path：本地文件路径须经 webUtils.getPathForFile（仅 preload 可用）
const exposed: RendererApi = {
  ...api,
  getPathForFile: (file) => webUtils.getPathForFile(file as File)
}
contextBridge.exposeInMainWorld('api', exposed)
