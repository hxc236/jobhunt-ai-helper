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

import type {
  Application,
  ApplicationPatch,
  CrawlConditions,
  CrawlImportResult,
  CrawlPreset,
  CrawlPreview,
  CrawlRun,
  CrawlRunOptions,
  CrawlRunResult,
  Position,
  PositionFilters,
  PositionInput,
  PositionListItem,
  PositionPatch,
  OptimizationMode,
  OptimizeResult,
  AsrStatus,
  PositionSource,
  Topic,
  TopicGenerateInput,
  TopicInput,
  TopicStatus,
  ResumeDraft
} from './types'
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
  PositionsGet: 'positions:get',
  PositionsUpdate: 'positions:update',
  PositionsDelete: 'positions:delete',
  PositionsGetApplication: 'positions:get-application',
  PositionsSetApplication: 'positions:set-application',
  ResumesList: 'resumes:list',
  ResumesCreate: 'resumes:create',
  ResumesUpdate: 'resumes:update',
  ResumesDelete: 'resumes:delete',
  ResumesUploadParse: 'resumes:upload-parse',
  ResumesRenderHtml: 'resumes:render-html',
  ResumesExportPdf: 'resumes:export-pdf',
  OptimizeRun: 'optimize:run',
  TopicsList: 'topics:list',
  TopicsGenerate: 'topics:generate',
  TopicsCreate: 'topics:create',
  TopicsUpdate: 'topics:update',
  TopicsDelete: 'topics:delete',
  TopicsSetStatus: 'topics:set-status',
  TopicsCreateInterviewSuggestion: 'topics:create-interview-suggestion',
  LearnStart: 'learn:start',
  LearnSend: 'learn:send',
  InterviewStart: 'interview:start',
  InterviewAnswer: 'interview:answer',
  InterviewInterrupt: 'interview:interrupt',
  InterviewFollowUp: 'interview:follow-up',
  AsrGetStatus: 'asr:get-status',
  AsrTranscribe: 'asr:transcribe',
  InterviewEnd: 'interview:end',
  InterviewHistory: 'interview:history',
  CrawlRun: 'crawl:run',
  CrawlConfirmImport: 'crawl:confirm-import',
  CrawlPreview: 'crawl:preview',
  CrawlRuns: 'crawl:runs',
  CrawlGetRun: 'crawl:get-run',
  BossLoginOpen: 'boss-login:open',
  BossLoginStatus: 'boss-login:status',
  CrawlPresetsList: 'crawl-presets:list',
  CrawlPresetsCreate: 'crawl-presets:create',
  CrawlPresetsDelete: 'crawl-presets:delete',
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
  // F-03（#20）：职位详情 + 编辑/删除 —— get 返回完整职位卡（JD 全文/渠道链接）；
  // update 为 patch 语义（未传字段不变，可空字段 null/空串清空，键字段变化重算 dedupe）；
  // delete 级联删除投递记录（applications 表由 #21 建，删除路径已探测兼容）。
  [IpcChannel.PositionsGet]: { request: { id: string }; response: Position }
  [IpcChannel.PositionsUpdate]: { request: { id: string; patch: PositionPatch }; response: Position }
  [IpcChannel.PositionsDelete]: { request: { id: string }; response: void }
  // F-05（#21）：投递状态流转 —— get-application 无记录返回 null（详情页「未开始投递」引导）；
  // set-application 状态机校验（非法流转抛 transition），同状态调用 = 编辑渠道/投递日期。
  [IpcChannel.PositionsGetApplication]: { request: { positionId: string }; response: Application | null }
  [IpcChannel.PositionsSetApplication]: {
    request: { positionId: string; patch: ApplicationPatch }
    response: Application
  }
  // F-08（#22）：采集执行框架 —— run 返回留痕行 + 候选快照（#29 预览数据源）；
  // runs 为留痕列表；get-run 按 id 查单次运行。
  [IpcChannel.CrawlRun]: { request: { source: PositionSource; options: CrawlRunOptions }; response: CrawlRunResult }
  [IpcChannel.CrawlRuns]: { request: void; response: CrawlRun[] }
  [IpcChannel.CrawlGetRun]: { request: { id: number }; response: CrawlRun | null }
  // F-11（#29）：采集预览与确认导入 —— preview 预测入库动作 + 缺字段；confirm-import upsert
  [IpcChannel.CrawlPreview]: { request: { runId: number }; response: CrawlPreview }
  [IpcChannel.CrawlConfirmImport]: {
    request: { runId: number; sourceUrls: string[] }
    response: CrawlImportResult
  }
  // issue #51：BOSS 登录态 —— open 打开可见登录窗口（persist:boss 分区，扫码）；
  // status 检测登录态（分区内页面 fetch getUserInfo，code===0 = 已登录）。
  [IpcChannel.BossLoginOpen]: { request: void; response: void }
  [IpcChannel.BossLoginStatus]: { request: void; response: boolean }
  // issue #57：常用采集（crawl_presets 增删查）
  [IpcChannel.CrawlPresetsList]: { request: void; response: CrawlPreset[] }
  [IpcChannel.CrawlPresetsCreate]: {
    request: { name: string; conditions: CrawlConditions }
    response: CrawlPreset
  }
  [IpcChannel.CrawlPresetsDelete]: { request: { id: number }; response: void }
  // F-14（#26）：简历上传解析 —— docx/pdf → 文本 → 结构化草稿（置信度/待确认标记；扫描件降级）
  [IpcChannel.ResumesUploadParse]: { request: { filePath: string }; response: ResumeDraft }
  // F-15（#30）：A4 渲染与 PDF 导出 —— render-html 纯函数（iframe 预览）；
  // export-pdf 经隐藏窗口 printToPDF + 保存对话框，返回保存路径（取消 → null）。
  [IpcChannel.ResumesRenderHtml]: { request: { id: string }; response: string }
  [IpcChannel.ResumesExportPdf]: { request: { id: string }; response: string | null }
  // F-07/#32：优化流程 —— run 三轮编排（进度经 optimize:progress 事件推送；结果含优化稿+changes）
  [IpcChannel.OptimizeRun]: {
    request: { jobId: string; resumeId: string; mode: OptimizationMode }
    response: OptimizeResult
  }
  // F-19（#33）：学习清单 —— generate 从 jd_analysis 生成（优先级 1-5/来源/去重/降级）；
  // create/update/delete/set-status 人工 CRUD 与三态（todo/learning/learned）。
  [IpcChannel.TopicsList]: { request: { status?: TopicStatus; jobId?: string }; response: Topic[] }
  [IpcChannel.TopicsGenerate]: {
    request: { jobId: string; extras?: TopicGenerateInput }
    response: { created: Topic[]; skipped: number }
  }
  [IpcChannel.TopicsCreate]: { request: { input: TopicInput }; response: Topic }
  [IpcChannel.TopicsUpdate]: {
    request: { id: string; patch: { title?: string; note?: string; priority?: number } }
    response: Topic
  }
  [IpcChannel.TopicsDelete]: { request: { id: string }; response: void }
  [IpcChannel.TopicsSetStatus]: { request: { id: string; status: TopicStatus }; response: Topic }
  // F-27（#41）：复盘 suggestLearn 回填 —— 薄弱点入清单（source=interview，去重跳过返回 null）
  [IpcChannel.TopicsCreateInterviewSuggestion]: {
    request: { title: string; note: string; jobId: string | null }
    response: Topic | null
  }
  // F-22（#36）：teach 聊天会话 —— start 按条目开 learn 会话（/skill:teach + continueRecent），
  // send 发送消息（流式增量经 agent:delta 事件推送；返回整轮回复）。
  [IpcChannel.LearnStart]: {
    request: { topicId: string }
    response: { sessionId: string; topicTitle: string; resumed: boolean }
  }
  [IpcChannel.LearnSend]: { request: { sessionId: string; text: string }; response: string }
  // F-26（#40）：语音输入 —— get-status 就绪检查（未就绪 → 渲染层降级文字输入）；
  // transcribe 收渲染层 MediaRecorder 的 wav → 识别文本（PTT）。
  [IpcChannel.AsrGetStatus]: { request: void; response: AsrStatus }
  [IpcChannel.AsrTranscribe]: { request: { wav: number[] }; response: string }
  // F-23（#37）：面试会话 —— start 注入 JD 分析/优化稿/learned 清单；answer 阶段推进
  // （硬性要求→项目深挖→learned 检验→反问→收尾，动态难度）；interrupt 打断；end 收尾落 transcript。
  [IpcChannel.InterviewStart]: {
    request: { jobId: string; style: 'real' | 'coach' | 'strict' }
    response: { sessionId: string; interviewId: string; opening: string }
  }
  [IpcChannel.InterviewAnswer]: { request: { sessionId: string; text: string }; response: string }
  [IpcChannel.InterviewInterrupt]: { request: { sessionId: string }; response: void }
  [IpcChannel.InterviewFollowUp]: { request: { sessionId: string; text: string }; response: void }
  [IpcChannel.InterviewEnd]: {
    request: { sessionId: string }
    response: { id: string; job_id: string | null; status: string; transcript: Array<{ role: 'user' | 'assistant'; text: string; ts: string }> }
  }
  [IpcChannel.InterviewHistory]: {
    request: void
    response: Array<{
      id: string
      job_id: string | null
      style: string
      status: string
      transcript: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>
      review: unknown
      created_at: string
    }>
  }
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
  OptimizeProgress: 'optimize:progress', // #32：优化三轮进度
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
  [IpcEvent.OptimizeProgress]: { jobId: string; round: 1 | 2 | 3; phase: string }
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

/** 渲染进程可见的 positions api 表面（F-01 录入 + F-02 列表筛选/倒计时 + F-03 详情/编辑/删除 + F-05 投递状态）。 */
export interface PositionsApi {
  /** 创建职位卡；校验失败/重复录入时 reject（错误 message 含原因）。 */
  create: (input: PositionInput) => Promise<Position>
  /** 职位列表（F-02：企业性质/批次/状态/秋招季四维筛选可组合；days_left=倒计时，null=待核实；
   *  F-05：+ application_status 维度与行内投递状态）。 */
  list: (filters?: PositionFilters) => Promise<PositionListItem[]>
  /** 职位卡详情（F-03：完整 JD 全文/渠道链接；id 不存在 reject not-found）。 */
  get: (id: string) => Promise<Position>
  /** 编辑职位卡（F-03：patch 语义——未传字段不变；可空字段 null/空串清空；返回更新后职位卡）。 */
  update: (id: string, patch: PositionPatch) => Promise<Position>
  /** 删除职位卡（F-03：级联删除该职位投递记录）。 */
  delete: (id: string) => Promise<void>
  /** 投递记录（F-05：无记录返回 null，详情页显示「未开始投递」）。 */
  getApplication: (positionId: string) => Promise<Application | null>
  /** 投递状态操作（F-05：状态机校验；同状态调用 = 编辑渠道/投递日期；非法流转 reject transition）。 */
  setApplication: (positionId: string, patch: ApplicationPatch) => Promise<Application>
}

/** 渲染进程可见的 asr api 表面（F-26/#40：PTT 语音输入 + 降级）。 */
export interface AsrApi {
  getStatus: () => Promise<AsrStatus>
  /** PTT 松开后转写（wav PCM 16k 单声道；未就绪 reject ASR_NOT_READY）。 */
  transcribe: (wav: Uint8Array) => Promise<string>
}

/** 渲染进程可见的 interview api 表面（F-23/#37）。 */
export interface InterviewApi {
  start: (jobId: string, style: 'real' | 'coach' | 'strict') => Promise<{
    sessionId: string
    interviewId: string
    opening: string
  }>
  answer: (sessionId: string, text: string) => Promise<string>
  interrupt: (sessionId: string) => Promise<void>
  /** 补充说明（当前生成结束后排队投递）。 */
  followUp: (sessionId: string, text: string) => Promise<void>
  end: (sessionId: string) => Promise<{
    id: string
    job_id: string | null
    status: string
    transcript: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>
  }>
  history: () => Promise<
    Array<{
      id: string
      job_id: string | null
      style: string
      status: string
      transcript: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>
      review: unknown
      created_at: string
    }>
  >
}

/** 渲染进程可见的 learn api 表面（F-22/#36：teach 会话）。 */
export interface LearnApi {
  start: (topicId: string) => Promise<{ sessionId: string; topicTitle: string; resumed: boolean }>
  send: (sessionId: string, text: string) => Promise<string>
}

/** 渲染进程可见的 topics api 表面（F-19/#33：清单生成 + 人工 CRUD + 三态）。 */
export interface TopicsApi {
  list: (filters?: { status?: TopicStatus; jobId?: string }) => Promise<Topic[]>
  generate: (jobId: string, extras?: TopicGenerateInput) => Promise<{ created: Topic[]; skipped: number }>
  create: (input: TopicInput) => Promise<Topic>
  update: (id: string, patch: { title?: string; note?: string; priority?: number }) => Promise<Topic>
  delete: (id: string) => Promise<void>
  setStatus: (id: string, status: TopicStatus) => Promise<Topic>
  /** 复盘建议回填（source=interview；重复跳过返回 null）。 */
  createInterviewSuggestion: (title: string, note: string, jobId: string | null) => Promise<Topic | null>
}

/** 渲染进程可见的 optimize api 表面（#32：触发优化流程；进度经 optimize:progress 事件）。 */
export interface OptimizeApi {
  run: (jobId: string, resumeId: string, mode: OptimizationMode) => Promise<OptimizeResult>
}

/** 渲染进程可见的 crawls api 表面（F-08/#22：执行框架 + 留痕；F-11/#29：预览 + 确认导入）。 */
export interface CrawlApi {
  /** 执行一次采集（节流/重试/上限框架内完成；返回留痕 + 候选，供预览）。 */
  run: (source: PositionSource, options: CrawlRunOptions) => Promise<CrawlRunResult>
  /** 采集留痕列表（倒序）。 */
  runs: () => Promise<CrawlRun[]>
  /** 单次留痕（#29 预览用）。 */
  getRun: (id: number) => Promise<CrawlRun | null>
  /** 预览（F-11：新增/更新/缺字段统计 + 候选逐条动作预测）。 */
  preview: (runId: number) => Promise<CrawlPreview>
  /** 确认导入（F-11：勾选候选 upsert 入库——重复 URL 更新而非新建）。 */
  confirmImport: (runId: number, sourceUrls: string[]) => Promise<CrawlImportResult>
  /** BOSS 登录态（issue #51：扫码登录窗口 + 状态检测；薪资可见性的前提）。 */
  bossLogin: {
    /** 打开可见登录窗口（persist:boss 分区，登录态落盘）。 */
    open: () => Promise<void>
    /** 登录状态（分区内 getUserInfo code===0 = 已登录）。 */
    status: () => Promise<boolean>
  }
  /** 常用采集（issue #57：保存命名条件、复用、删除）。 */
  crawlPresets: {
    list: () => Promise<CrawlPreset[]>
    create: (name: string, conditions: CrawlConditions) => Promise<CrawlPreset>
    delete: (id: number) => Promise<void>
  }
}

/** 渲染进程可见的 resumes api 表面（F-12：多份基准简历 CRUD + 删除语义；F-14：上传解析）。 */
export interface ResumeApi {
  list: () => Promise<StoredResume[]>
  create: (resume: Resume) => Promise<StoredResume>
  update: (id: string, resume: Resume) => Promise<StoredResume>
  delete: (id: string) => Promise<void>
  /** 上传解析（F-14/#26）：docx/pdf → 草稿（扫描件 scanned 降级提示）。 */
  uploadParse: (filePath: string) => Promise<ResumeDraft>
  /** A4 渲染（F-15/#30）：完整 HTML 文档（含打印样式），iframe 预览。 */
  renderHtml: (id: string) => Promise<string>
  /** 导出 PDF（F-15/#30：保存对话框；取消返回 null）。 */
  exportPdf: (id: string) => Promise<string | null>
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
  crawls: CrawlApi
  optimize: OptimizeApi
  topics: TopicsApi
  learn: LearnApi
  interview: InterviewApi
  asr: AsrApi
  /** 订阅主进程事件推送；返回取消订阅函数。 */
  on: <E extends IpcEventName>(event: E, listener: (payload: IpcEventMap[E]) => void) => () => void
}
