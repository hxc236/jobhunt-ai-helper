import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  IpcChannel,
  IpcEvent,
  type AgentStatusInfo,
  type IpcChannelName,
  type IpcRequest,
  type IpcResponse,
  type PingResponse
} from '../../shared/protocol'
import { ping } from '../services/ping'
import type { AgentService } from '../services/agent'
import type { SettingsService } from '../services/settings'
import { pushEvent } from './events'

/** 类型化 handler 注册：通道与请求/响应类型由 IpcProtocol 推导（无类型绕过）。 */
function handleRequest<C extends IpcChannelName>(
  channel: C,
  handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>
): void {
  ipcMain.handle(channel, (_event: IpcMainInvokeEvent, request: IpcRequest<C>) => handler(request))
}

export interface IpcDeps {
  settings: SettingsService
  agent: AgentService
}

/**
 * 注册全部 IPC handler（薄层：仅参数校验 + 转调服务）。
 * 主进程启动时调用一次；后续通道（EF-04 起）在此追加。
 */
export function registerIpcHandlers({ settings, agent }: IpcDeps): void {
  handleRequest(IpcChannel.Ping, (): PingResponse => ping())

  handleRequest(IpcChannel.SettingsGet, (request) => settings.get(request.key))
  handleRequest(IpcChannel.SettingsSet, (request) => {
    settings.set(request.key, request.value)
    // settings 变更广播：主 → 渲染事件推送（EF-03 验收：事件可达）
    pushEvent(IpcEvent.SettingsChanged, { key: request.key, value: request.value })
  })
  handleRequest(IpcChannel.SettingsGetAll, () => settings.getAll())

  // EF-04：agent 认证状态与配置（分层降级依据：get-status 未配置时渲染层引导）
  handleRequest(IpcChannel.SettingsGetStatus, (): AgentStatusInfo => agent.getStatus())
  handleRequest(IpcChannel.SettingsConfigureProvider, (request) =>
    agent.configureProvider(request.provider, request.apiKey, request.model)
  )
}
