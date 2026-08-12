import { contextBridge, ipcRenderer } from 'electron'
import { createRendererApi, type IpcBridge } from './api'

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
contextBridge.exposeInMainWorld('api', createRendererApi(bridge))
