/**
 * IPC 协议（shared/protocol.ts）— 主/渲染进程共用。
 *
 * EF-01 脚手架阶段仅含一条示例通道（ping）；
 * EF-03 将在此扩展为类型化 channel 清单（settings:* / positions:* / resumes:* …）。
 */

/** 通道常量：ipcMain.handle / ipcRenderer.invoke 两侧共用，避免字符串散落。 */
export const IpcChannel = {
  Ping: 'ping'
} as const

/** ping 响应类型：渲染进程调用主进程 ping 的返回。 */
export type PingResponse = 'pong'

/**
 * 渲染进程可见的 api 表面（经 contextBridge 暴露为 `window.api`）。
 * 渲染层只通过该对象调用主进程，不裸调 ipcRenderer。
 */
export interface RendererApi {
  ping: () => Promise<PingResponse>
}
