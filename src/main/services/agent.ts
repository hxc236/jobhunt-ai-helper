/**
 * AgentService（EF-04，issue #16）— pi SDK 会话封装 + provider 抽象 + 流式事件转发。
 *
 * 职责边界（docs/architecture.md「AgentService（底层）」）：
 * - session provider 抽象：真实 pi SDK（PiAgentProvider）与 fake（FakeAgentProvider）同面，
 *   业务服务（Optimize/Interview/Topic）只依赖本文件的类型，不接触 SDK；
 * - 任务类型 optimize / interview / learn 决定会话策略（ADR-0002：
 *   optimize 每次 inMemory、interview 长驻（steer/followUp）、learn 教学工作区 + continueRecent + /skill:teach）；
 * - 事件流转发：SDK 事件面收敛为 AgentEvent（text_delta / status / error / turn_end / tool_*），
 *   经 onEvent 注入面转给 IPC 层（agent:delta / agent:status 推送）；
 * - 未配置认证时抛 AgentNotConfiguredError（code=AGENT_NOT_CONFIGURED），
 *   作为分层降级依据（spec #13 Q3：agent 功能提示配置、手动功能照常）。
 */

/** 非敏感设置的窄接口（provider/model 选择持久化；完整实现为 SettingsService）。 */
export interface AgentSettingsStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/** agent 任务类型：决定会话策略（cwd / sessionManager / tools / 首条提示）。 */
export type AgentTaskType = 'optimize' | 'interview' | 'learn' | 'company_type' | 'agent_channel'

/** 归一化 agent 事件（SDK 事件面 → 业务/IPC 事件面）。 */
export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'error'; message: string }
  | { type: 'turn_end' }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }

/** 认证/配置状态（分层降级依据：configured=false 时上层展示引导，不调用会话）。 */
export interface AgentStatus {
  configured: boolean
  /** 当前选定的 provider id（如 deepseek / kimi-coding）。 */
  provider?: string
  /** 当前选定的模型 id；未显式选择时为 undefined（由 provider 取默认）。 */
  model?: string
}

/** 会话创建选项；未提供时按任务类型取默认策略。 */
export interface AgentSessionOptions {
  /** 会话工作目录（learn 默认教学工作区）。 */
  cwd?: string
  /** 工具白名单（learn 默认 read/write/edit/bash/ls/grep/find；optimize/interview 默认无工具）。 */
  tools?: string[]
  /** 跨会话续接（learn 默认 true：SessionManager.continueRecent）。 */
  continueRecent?: boolean
}

/**
 * AgentSession：业务层可见的会话表面（真实 SDK 与 fake 共同满足）。
 * 事件流经 subscribe 消费；AgentService 创建时自动把事件转发到全局 onEvent。
 */
export interface AgentSession {
  readonly id: string
  readonly task: AgentTaskType
  readonly cwd: string
  /** 发送提示并等待整轮完成；返回本轮最终回复全文。失败先发 error 事件再 reject。 */
  prompt(text: string): Promise<string>
  /** 打断当前生成并插队投递（面试打断）。 */
  steer(text: string): Promise<void>
  /** 当前生成完全结束后排队投递（面试补充说明）。 */
  followUp(text: string): Promise<void>
  /** 中止当前操作。 */
  abort(): Promise<void>
  /** 订阅事件流；返回退订函数。 */
  subscribe(listener: (event: AgentEvent) => void): () => void
  /** 释放会话资源（退订 + SDK dispose）。 */
  dispose(): void
}

/** provider 抽象：真实 pi SDK 与 fake 共同实现（构造注入，服务层不 import SDK）。 */
export interface AgentProvider {
  readonly name: string
  /** 当前认证/配置状态（同步读应用自有 auth.json）。 */
  getStatus(): AgentStatus
  /** 配置认证：写应用自有 auth.json + 记录 provider/model 选择（非敏感部分）。 */
  configureProvider(provider: string, apiKey: string, model?: string): Promise<void>
  /** 按任务类型创建会话；未配置认证时抛 AgentNotConfiguredError。 */
  createSession(task: AgentTaskType, options?: AgentSessionOptions): Promise<AgentSession>
  /** 释放全部资源（关闭 ModelRuntime / 会话）。 */
  dispose(): void
}

/** 未配置认证时的明确错误（分层降级依据；IPC 层可据此返回可读提示）。 */
export class AgentNotConfiguredError extends Error {
  readonly code = 'AGENT_NOT_CONFIGURED' as const
  constructor(message?: string) {
    super(message ?? 'agent 未配置：请先在设置中配置模型提供商与 API key')
    this.name = 'AgentNotConfiguredError'
  }
}

/** 判断错误是否为「未配置认证」。 */
export function isAgentNotConfiguredError(error: unknown): error is AgentNotConfiguredError {
  return error instanceof AgentNotConfiguredError
}

export interface AgentServiceOptions {
  /**
   * 事件转发目标（IPC 层注入）：所有会话的事件（text_delta/status/error…）
   * 带 sessionId 转发到该回调，供 agent:delta / agent:status 推送。
   */
  onEvent?: (sessionId: string, event: AgentEvent) => void
}

/**
 * AgentService（底层）：封装 provider 生命周期，向业务服务暴露会话创建。
 * 构造注入 provider（真实/fake）+ 可选事件转发目标。
 */
export class AgentService {
  readonly name: string
  private readonly sessions = new Set<AgentSession>()

  constructor(
    private readonly provider: AgentProvider,
    private readonly options: AgentServiceOptions = {}
  ) {
    this.name = provider.name
  }

  /** 认证/配置状态（分层降级判断入口）。 */
  getStatus(): AgentStatus {
    return this.provider.getStatus()
  }

  /** 配置模型认证（provider + API key 写应用自有 auth.json；model 可选）。 */
  async configureProvider(provider: string, apiKey: string, model?: string): Promise<void> {
    await this.provider.configureProvider(provider, apiKey, model)
  }

  /** 创建会话（任务类型决定策略）；自动把会话事件转发到全局 onEvent。 */
  async createSession(task: AgentTaskType, options?: AgentSessionOptions): Promise<AgentSession> {
    const session = await this.provider.createSession(task, options)
    this.sessions.add(session)
    if (this.options.onEvent !== undefined) {
      session.subscribe((event) => this.options.onEvent?.(session.id, event))
    }
    return session
  }

  /**
   * 学习会话（teach）：cwd=教学工作区、continueRecent 跨会话续接，
   * 首条提示自动带 `/skill:teach <topic>`（teach 为 disable-model-invocation，只能显式触发），
   * 并显式声明教学工作区路径（避免模型把技能 location 误当工作区写文件）。
   * 返回会话（事件流已可订阅）；首条提示的后台失败由契约保证先发 error 事件，此处仅吞掉拒绝。
   */
  async learnSession(topic: string, options?: AgentSessionOptions): Promise<AgentSession> {
    const session = await this.createSession('learn', options)
    const prompt = [
      `/skill:teach ${topic}`,
      '',
      `教学工作区（当前目录）：${session.cwd}。请将 MISSION.md/RESOURCES.md/NOTES.md/lessons/reference 等全部教学文件维护在该目录中。`
    ].join('\n')
    session.prompt(prompt).catch(() => {
      // prompt 失败先发 error 事件再 reject（AgentSession 契约），此处只防 unhandled rejection
    })
    return session
  }

  /** 释放全部会话与 provider 资源（应用退出前调用）。 */
  dispose(): void {
    for (const session of this.sessions) session.dispose()
    this.sessions.clear()
    this.provider.dispose()
  }
}

/** 设置键（非敏感部分）：当前选定的 provider / model。API key 只入 auth.json，不入 settings 表。 */
export const AGENT_PROVIDER_SETTING = 'agent.provider'
export const AGENT_MODEL_SETTING = 'agent.model'

/** 读设置中的字符串值（未设置/非字符串返回 undefined）。 */
export function readAgentSetting(
  settings: AgentSettingsStore | undefined,
  key: string
): string | undefined {
  if (settings === undefined) return undefined
  const value = settings.get(key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
