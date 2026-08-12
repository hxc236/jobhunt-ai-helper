import {
  AgentNotConfiguredError,
  type AgentEvent,
  type AgentProvider,
  type AgentSession,
  type AgentSessionOptions,
  type AgentStatus,
  type AgentTaskType
} from './agent'

/**
 * FakeAgentProvider（EF-04 测试替身）：与 PiAgentProvider 同面，不触真实模型。
 *
 * 用途：
 * - 本 ticket 的会话全流程/事件转发/未配置错误测试；
 * - 后续业务服务（Optimize/Interview/Topic）测试的统一注入面（唯一 seam = services 层，
 *   见 docs/mvp-spec.md Testing Decisions）。
 *
 * 行为：
 * - 默认回显 `echo: <prompt>`（可经 onPrompt 钩子换成脚本化回复，如模拟 JSON 输出）；
 * - 事件序列与真实 provider 一致：status running → text_delta*（按 chunkSize 分块）→ turn_end → status idle；
 * - failNextPrompt 注入 prompt 失败（先发 error 事件再 reject，与真实行为一致）；
 * - 记录 prompts/steered/followUps/aborted/disposed/events，供断言。
 */

export interface FakeAgentProviderOptions {
  /** 初始是否已配置（默认 true；false 时 createSession 抛 AgentNotConfiguredError）。 */
  configured?: boolean
  /** 初始 provider id（默认 'deepseek'）。 */
  provider?: string
  /** 初始 model id。 */
  model?: string
  /** prompt → 回复 钩子（默认回显）。可事后改写 provider.onPrompt。 */
  onPrompt?: (prompt: string, session: FakeAgentSession) => string | Promise<string>
  /** delta 分块大小（默认 8 字符）。 */
  chunkSize?: number
  /** 回复前延迟 ms（模拟流式节奏；默认 0）。 */
  delayMs?: number
}

export class FakeAgentProvider implements AgentProvider {
  readonly name = 'fake'
  /** 已创建且未 dispose 的会话（供断言）。 */
  readonly sessions: FakeAgentSession[] = []
  /** configureProvider 调用记录。 */
  readonly configureCalls: Array<{ provider: string; apiKey: string; model?: string }> = []
  /** prompt → 回复 钩子（可中途改写）。 */
  onPrompt?: (prompt: string, session: FakeAgentSession) => string | Promise<string>
  readonly chunkSize: number
  readonly delayMs: number
  private status: AgentStatus
  private nextId = 0
  /** provider 是否已 dispose（供断言）。 */
  disposed = false

  constructor(options: FakeAgentProviderOptions = {}) {
    this.status = {
      configured: options.configured ?? true,
      provider: options.provider ?? 'deepseek',
      model: options.model ?? 'deepseek-v4-flash'
    }
    this.onPrompt = options.onPrompt
    this.chunkSize = options.chunkSize ?? 8
    this.delayMs = options.delayMs ?? 0
  }

  getStatus(): AgentStatus {
    return { ...this.status }
  }

  async configureProvider(provider: string, apiKey: string, model?: string): Promise<void> {
    this.configureCalls.push({ provider, apiKey, model })
    this.status = { configured: true, provider, ...(model !== undefined ? { model } : {}) }
  }

  async createSession(task: AgentTaskType, options?: AgentSessionOptions): Promise<AgentSession> {
    if (!this.status.configured || this.status.provider === undefined) {
      throw new AgentNotConfiguredError()
    }
    const session = new FakeAgentSession({
      id: `fake-${++this.nextId}`,
      task,
      cwd: options?.cwd ?? 'fake-cwd',
      provider: this,
      chunkSize: this.chunkSize,
      delayMs: this.delayMs
    })
    this.sessions.push(session)
    return session
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.sessions) session.dispose()
    this.sessions.length = 0
  }
}

export interface FakeAgentSessionOptions {
  id: string
  task: AgentTaskType
  cwd: string
  provider: FakeAgentProvider
  chunkSize: number
  delayMs: number
}

export class FakeAgentSession implements AgentSession {
  readonly id: string
  readonly task: AgentTaskType
  readonly cwd: string
  /** 全部 prompt 记录。 */
  readonly prompts: string[] = []
  /** steer 记录。 */
  readonly steered: string[] = []
  /** followUp 记录。 */
  readonly followUps: string[] = []
  /** abort 是否被调用。 */
  aborted = false
  disposed = false
  /** 事件流记录（含通过 subscribe 转发的同一事件流）。 */
  readonly events: AgentEvent[] = []
  /** 设置后下一次 prompt 失败（先发 error 事件再 reject）。 */
  failNextPrompt: Error | undefined
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly chunkSize: number
  private readonly delayMs: number
  private readonly provider: FakeAgentProvider

  constructor(options: FakeAgentSessionOptions) {
    this.id = options.id
    this.task = options.task
    this.cwd = options.cwd
    this.provider = options.provider
    this.chunkSize = options.chunkSize
    this.delayMs = options.delayMs
  }

  async prompt(text: string): Promise<string> {
    this.prompts.push(text)
    this.emit({ type: 'status', status: 'running' })
    if (this.failNextPrompt !== undefined) {
      const error = this.failNextPrompt
      this.failNextPrompt = undefined
      this.emit({ type: 'error', message: error.message })
      throw error
    }
    if (this.delayMs > 0) await sleep(this.delayMs)
    // 动态取 provider.onPrompt：允许测试在会话创建后中途改写回复脚本
    let reply: string
    try {
      reply = String(await (this.provider.onPrompt ?? ((prompt: string) => `echo: ${prompt}`))(text, this))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', message })
      throw error
    }
    for (let i = 0; i < reply.length; i += this.chunkSize) {
      this.emit({ type: 'text_delta', delta: reply.slice(i, i + this.chunkSize) })
    }
    this.emit({ type: 'turn_end' })
    this.emit({ type: 'status', status: 'idle' })
    return reply
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text)
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text)
  }

  async abort(): Promise<void> {
    this.aborted = true
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    const index = this.provider.sessions.indexOf(this)
    if (index >= 0) this.provider.sessions.splice(index, 1)
  }

  private emit(event: AgentEvent): void {
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
