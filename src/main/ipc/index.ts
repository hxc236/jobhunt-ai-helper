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
import type { PositionService } from '../services/position'
import type { ResumeService } from '../services/resume'
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
  positions: PositionService
  resumes: ResumeService
}

/**
 * 注册全部 IPC handler（薄层：仅参数校验 + 转调服务）。
 * 主进程启动时调用一次；后续通道（EF-04 起）在此追加。
 */
export function registerIpcHandlers({ settings, agent, positions, resumes }: IpcDeps): void {
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

  // F-01（#17）：职位录入 —— 服务层负责校验/去重（dedupe_key），错误 message 透传渲染层提示
  handleRequest(IpcChannel.PositionsCreate, (request) => positions.create(request))
  // F-02（#18）：职位列表 —— 四维筛选 + days_left 倒计时（服务层计算，null=待核实）
  handleRequest(IpcChannel.PositionsList, (request) => positions.list(request))
  // F-03（#20）：职位详情/编辑/删除 —— get 详情页数据源；update patch 语义（校验/查重服务层完成）；
  // delete 级联删投递记录（applications 表由 #21 建，服务层探测兼容）
  handleRequest(IpcChannel.PositionsGet, (request) => positions.get(request.id))
  handleRequest(IpcChannel.PositionsUpdate, (request) => positions.update(request.id, request.patch))
  handleRequest(IpcChannel.PositionsDelete, (request) => positions.delete(request.id))

  // F-12（issue #19）：简历 CRUD —— 服务层负责 schema 校验与删除语义（基准删除不影响派生稿）
  handleRequest(IpcChannel.ResumesList, () => resumes.list())
  handleRequest(IpcChannel.ResumesCreate, (request) => resumes.create(request.resume))
  handleRequest(IpcChannel.ResumesUpdate, (request) => resumes.update(request.id, request.resume))
  handleRequest(IpcChannel.ResumesDelete, (request) => resumes.delete(request.id))
}
