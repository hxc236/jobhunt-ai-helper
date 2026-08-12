/**
 * IPC 协议（shared/protocol.ts）— 主/渲染进程共用，是类型化 IPC 的唯一事实来源。
 *
 * EF-02/EF-03（issue #15）：db 层 + IPC 协议框架。
 * - IpcChannel：通道常量（invoke/handle 两侧共用，避免字符串散落）；
 * - IpcProtocol：已实现通道 → 请求/响应类型映射。「无类型绕过」的保证：
 *   preload api 客户端与主进程 handler 注册都从该映射推导类型，渲染层不出现裸 channel 字符串；
 * - IpcEvent / IpcEventMap：主 → 渲染事件推送契约。
 *
 * 未实现通道（positions:* 等）的常量按 docs/architecture.md 契约列全，
 * 作为后续服务 ticket（EF-04 起）的协议预留；请求/响应类型随各 ticket 逐个补齐。
 */

import type { Position, PositionFilters, PositionInput, PositionListItem } from './types'
import type { Resume, StoredResume } from './types/resume'

/** 请求-响应通道常量。 */
export const IpcChannel = {
  Ping: 'ping',
  // settings（EF-03 本 ticket 实现）
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  SettingsGetAll: 'settings:get-all',
  // ---- 以下为协议预留（docs/architecture.md 契约），随服务 ticket 逐个实现 ----
  SettingsGetStatus: 'settings:get-status',
  SettingsConfigureProvider: 'settings:configure-provider',
  PositionsList: 'positions:list',
  PositionsCreate: 'positions:create',
  PositionsUpdate: 'positions:update',
  PositionsSetApplication: 'positions:set-application',
  ResumesList: 'resumes:list',
  ResumesCreate: 'resumes:create',
  ResumesUpdate: 'resumes:update',
  ResumesDelete: 'resumes:delete',
  ResumesUploadParse: 'resumes:upload-parse',
  ResumesRenderHtml: 'resumes:render-html',
  ResumesExportPdf: 'resumes:export-pdf',
  OptimizeRun: 'optimize:run',
  TopicsGenerate: 'topics:generate',
  TopicsUpdate: 'topics:update',
  InterviewStart: 'interview:start',
  InterviewAnswer: 'interview:answer',
  InterviewInterrupt: 'interview:interrupt',
  InterviewEnd: 'interview:end',
  InterviewHistory: 'interview:history',
  CrawlRun: 'crawl:run',
  CrawlConfirmImport: 'crawl:confirm-import',
  CrawlRuns: 'crawl:runs',
  AsrStart: 'asr:start',
  AsrStop: 'asr:stop'
} as const

/** ping 响应类型：渲染进程调用主进程 ping 的返回。 */
export type PingResponse = 'pong'

/**
 * agent 认证/配置状态（settings:get-status 响应；分层降级依据：
 * configured=false 时渲染层展示引导卡片，agent 功能不发起会话）。
 */
export interface AgentStatusInfo {
  configured: boolean
  /** 当前选定的 provider id（如 deepseek / kimi-coding）。 */
  provider?: string
  /** 当前选定的模型 id。 */
  model?: string
}

/**
 * 已实现通道的类型映射：channel → { request, response }。
 * preload invoke、渲染 api 客户端、主进程 handler 均从此映射推导类型。
 */
export interface IpcProtocol {
  [IpcChannel.Ping]: { request: void; response: PingResponse }
  [IpcChannel.SettingsGet]: { request: { key: string }; response: unknown }
  [IpcChannel.SettingsSet]: { request: { key: string; value: unknown }; response: void }
  [IpcChannel.SettingsGetAll]: { request: void; response: Record<string, unknown> }
  // EF-04：agent 认证状态与配置（写应用自有 auth.json，经 ModelRuntime）
  [IpcChannel.SettingsGetStatus]: { request: void; response: AgentStatusInfo }
  [IpcChannel.SettingsConfigureProvider]: {
    request: { provider: string; apiKey: string; model?: string }
    response: void
  }
  // F-01（#17）：职位卡创建（校验失败/重复录入抛 PositionError，message 透传渲染层）
  [IpcChannel.PositionsCreate]: { request: PositionInput; response: Position }
  // F-02（#18）：职位列表（四维筛选 + 倒计时）—— filters 缺省维度 = 不过滤
  [IpcChannel.PositionsList]: { request: PositionFilters; response: PositionListItem[] }
  // F-12（issue #19）：简历 CRUD —— 入库前服务层做 resume.schema.json 校验；
  // 删除语义：删除基准简历不影响已存派生稿（独立副本）。
  [IpcChannel.ResumesList]: { request: void; response: StoredResume[] }
  [IpcChannel.ResumesCreate]: { request: { resume: Resume }; response: StoredResume }
  [IpcChannel.ResumesUpdate]: { request: { id: string; resume: Resume }; response: StoredResume }
  [IpcChannel.ResumesDelete]: { request: { id: string }; response: void }
}

export type IpcChannelName = keyof IpcProtocol
export type IpcRequest<C extends IpcChannelName> = IpcProtocol[C]['request']
export type IpcResponse<C extends IpcChannelName> = IpcProtocol[C]['response']

/** 类型化 invoke 签名：void 请求不带参数，其余请求带单个对象。 */
export type IpcInvoker = <C extends IpcChannelName>(
  channel: C,
  ...args: IpcRequest<C> extends void ? [] : [IpcRequest<C>]
) => Promise<IpcResponse<C>>

/** 事件推送通道常量（主 → 渲染）。 */
export const IpcEvent = {
  SettingsChanged: 'settings:changed', // EF-03 本 ticket 实现
  AgentDelta: 'agent:delta', // EF-04 起：agent 流式文本
  AgentStatus: 'agent:status',
  InterviewTurnEnd: 'interview:turn-end',
  CrawlProgress: 'crawl:progress'
} as const

/** agent 会话状态（agent:status 载荷）。 */
export type AgentStatusValue = 'running' | 'idle' | 'error'

/** 事件 → 载荷类型映射。 */
export interface IpcEventMap {
  [IpcEvent.SettingsChanged]: { key: string; value: unknown }
  [IpcEvent.AgentDelta]: { sessionId: string; delta: string }
  [IpcEvent.AgentStatus]: { sessionId: string; status: AgentStatusValue; detail?: string }
  [IpcEvent.InterviewTurnEnd]: { sessionId: string }
  [IpcEvent.CrawlProgress]: { runId: number; done: number; total: number }
}

export type IpcEventName = keyof IpcEventMap

/** 渲染进程可见的 settings api 表面。 */
export interface SettingsApi {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  getAll: () => Promise<Record<string, unknown>>
  /** agent 认证/配置状态（未配置时渲染层降级引导）。 */
  getStatus: () => Promise<AgentStatusInfo>
  /** 配置模型认证（provider + API key 写应用自有 auth.json；model 可选）。 */
  configureProvider: (provider: string, apiKey: string, model?: string) => Promise<void>
}

/** 渲染进程可见的 positions api 表面（F-01 录入 + F-02 列表筛选/倒计时）。 */
export interface PositionsApi {
  /** 创建职位卡；校验失败/重复录入时 reject（错误 message 含原因）。 */
  create: (input: PositionInput) => Promise<Position>
  /** 职位列表（F-02：企业性质/批次/状态/秋招季四维筛选可组合；days_left=倒计时，null=待核实）。 */
  list: (filters?: PositionFilters) => Promise<PositionListItem[]>
}

/** 渲染进程可见的 resumes api 表面（F-12：多份基准简历 CRUD + 删除语义）。 */
export interface ResumeApi {
  list: () => Promise<StoredResume[]>
  create: (resume: Resume) => Promise<StoredResume>
  update: (id: string, resume: Resume) => Promise<StoredResume>
  delete: (id: string) => Promise<void>
}

/**
 * 渲染进程可见的 api 表面（经 contextBridge 暴露为 `window.api`）。
 * 渲染层只通过该对象调用主进程，不裸调 ipcRenderer。
 */
export interface RendererApi {
  ping: () => Promise<PingResponse>
  settings: SettingsApi
  positions: PositionsApi
  resumes: ResumeApi
  /** 订阅主进程事件推送；返回取消订阅函数。 */
  on: <E extends IpcEventName>(event: E, listener: (payload: IpcEventMap[E]) => void) => () => void
}
