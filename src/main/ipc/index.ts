import { ipcMain } from 'electron'
import { IpcChannel, type PingResponse } from '../../shared/protocol'
import { ping } from '../services/ping'

/**
 * 注册全部 IPC handler（薄层：仅参数校验 + 转调服务）。
 * 主进程启动时调用一次；后续通道（EF-03 起）在此追加。
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.Ping, (): PingResponse => ping())
}
