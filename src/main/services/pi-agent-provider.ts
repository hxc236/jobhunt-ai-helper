import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
  type AgentSession as SdkAgentSession,
  type AgentSessionEvent,
  type Skill
} from '@earendil-works/pi-coding-agent'
import type { AgentSettingsStore } from './agent'
import {
  AGENT_MODEL_SETTING,
  AGENT_PROVIDER_SETTING,
  AgentNotConfiguredError,
  readAgentSetting,
  type AgentEvent,
  type AgentProvider,
  type AgentSession,
  type AgentSessionOptions,
  type AgentStatus,
  type AgentTaskType
} from './agent'

/**
 * 真实 pi SDK provider（EF-04）：createAgentSession 封装。
 *
 * 认证/配置隔离（ADR-0002 + 调研结论）：
 * - ModelRuntime.create({ authPath, modelsPath }) 指向应用自有目录（userData/pi），
 *   不读不写用户 ~/.pi/agent；API key 只落应用自有 auth.json（0600），不落 SQLite；
 * - agentDir 指向应用自有目录 + noExtensions：不加载用户全局扩展；
 * - learn 的 teach 技能经 skillsOverride 注入仓库内置副本（resources/teach），自包含；
 * - resume_import 关闭 skills/context/templates/themes，使用专用最小 system prompt。
 *
 * 会话策略（ADR-0002）：
 * - optimize：SessionManager.inMemory()，无工具（纯文本三轮）；
 * - interview：SessionManager.inMemory()，无工具（tools 收紧），长驻 + steer/followUp；
 * - learn：SessionManager.continueRecent(教学工作区, 应用自有 sessions 目录)，保留
 *   read/write/edit/bash/ls/grep/find（teach 技能依赖写 HTML/引用文件）；
 * - resume_import：SessionManager.inMemory()，无工具/无代码上下文，纯文本→JSON。
 */

/** 各任务类型默认策略。 */
interface TaskStrategy {
  tools?: string[]
  continueRecent: boolean
}

const TASK_STRATEGIES: Record<AgentTaskType, TaskStrategy> = {
  optimize: { continueRecent: false },
  interview: { continueRecent: false },
  learn: { tools: ['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find'], continueRecent: true },
  // 企业性质推断（issue #54）：inMemory 单次会话，无工具（联网搜索由服务层编排，不扩 agent 工具面）
  company_type: { continueRecent: false },
  // Agent 通道（issue #59）：决策循环单次会话，无工具（只输出动作 JSON，driver 执行）
  agent_channel: { continueRecent: false },
  // 简历导入（#77）：独立无工具内存态会话，只接收文本（不开放文件系统/工具）
  resume_import: { continueRecent: false },
  // 内容优化（#90）：每轮新建内存态会话，无工具（纯文本诊断/改写），ADR-0002
  content_optimize: { continueRecent: false }
}

/** auth.json 里 api_key 凭据的最小形状（与 pi 的 Credential 兼容）。 */
interface StoredApiKeyCredential {
  type: 'api_key'
  key?: string
}

export interface PiAgentProviderOptions {
  /** 应用自有数据目录（userData/pi）：auth.json / models.json / sessions / agentDir 均在其下。 */
  dataDir: string
  /** 仓库内置 teach 技能目录（resources/teach）。 */
  teachSkillDir: string
  /** 非敏感设置存取（provider/model 选择落 settings 表）。 */
  settings?: AgentSettingsStore
  /** 默认工作目录（optimize/interview 会话；未指定时用 process.cwd()）。 */
  defaultCwd?: string
}

export class PiAgentProvider implements AgentProvider {
  readonly name = 'pi-sdk'
  private readonly authPath: string
  private readonly modelsPath: string
  private readonly sessionsDir: string
  private readonly agentDir: string
  private readonly defaultCwd: string
  private runtimePromise: Promise<ModelRuntime> | undefined

  constructor(private readonly options: PiAgentProviderOptions) {
    this.authPath = join(options.dataDir, 'auth.json')
    this.modelsPath = join(options.dataDir, 'models.json')
    this.sessionsDir = join(options.dataDir, 'sessions')
    this.agentDir = join(options.dataDir, 'agent')
    this.defaultCwd = options.defaultCwd ?? process.cwd()
  }

  /** 认证/配置状态：读应用自有 auth.json + settings 中的 provider/model 选择。 */
  getStatus(): AgentStatus {
    const provider = readAgentSetting(this.options.settings, AGENT_PROVIDER_SETTING)
    const model = readAgentSetting(this.options.settings, AGENT_MODEL_SETTING)
    const credential = provider === undefined ? undefined : readStoredCredential(provider, this.authPath)
    const configured =
      credential !== undefined &&
      credential.type === 'api_key' &&
      typeof credential.key === 'string' &&
      credential.key.length > 0
    return { configured, provider, model }
  }

  /** 配置认证：API key 写应用自有 auth.json（pi 格式，0600）；provider/model 选择入 settings。 */
  async configureProvider(provider: string, apiKey: string, model?: string): Promise<void> {
    if (provider.trim().length === 0) throw new TypeError('provider 不能为空')
    if (apiKey.trim().length === 0) throw new TypeError('apiKey 不能为空')
    writeApiKeyCredential(this.authPath, provider, { type: 'api_key', key: apiKey.trim() })
    if (this.options.settings !== undefined) {
      this.options.settings.set(AGENT_PROVIDER_SETTING, provider.trim())
      if (model !== undefined && model.trim().length > 0) {
        this.options.settings.set(AGENT_MODEL_SETTING, model.trim())
      } else {
        // 未显式指定模型时清除旧选择，回落 provider 默认模型
        this.options.settings.set(AGENT_MODEL_SETTING, '')
      }
    }
  }

  async createSession(task: AgentTaskType, options?: AgentSessionOptions): Promise<AgentSession> {
    const status = this.getStatus()
    if (!status.configured || status.provider === undefined) {
      throw new AgentNotConfiguredError()
    }

    const runtime = await this.getRuntime()
    // 双保险：文件态已配置 + 运行时视图一致（hasConfiguredAuth 同步判断）
    if (!runtime.hasConfiguredAuth(status.provider)) {
      throw new AgentNotConfiguredError(`provider「${status.provider}」在模型运行时中未配置认证`)
    }

    const model = resolveModel(runtime, status.provider, status.model)
    if (model === undefined) {
      throw new AgentNotConfiguredError(
        `provider「${status.provider}」无可用模型（请检查 provider/model 配置）`
      )
    }

    const strategy = TASK_STRATEGIES[task]
    const cwd = options?.cwd ?? this.defaultCwd
    const continueRecent = options?.continueRecent ?? strategy.continueRecent
    const sessionManager = continueRecent
      ? SessionManager.continueRecent(cwd, this.sessionsDir)
      : SessionManager.inMemory()

    const resourceLoader = await createAppLoader({
      cwd,
      agentDir: this.agentDir,
      teachSkillDir: this.options.teachSkillDir,
      task
    })

    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      model,
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      // 简历导入是纯数据转换：关闭思考，避免长推理拖慢结构化。
      ...(task === 'resume_import' ? { thinkingLevel: 'off' as const } : {}),
      // optimize/interview 无工具（tools 收紧）；learn 保留 teach 依赖的工具
      ...(strategy.tools === undefined
        ? { noTools: 'all' as const }
        : { tools: options?.tools ?? strategy.tools })
    })

    return new PiAgentSession(session, task, cwd)
  }

  dispose(): void {
    // ModelRuntime 无显式 dispose；丢弃引用允许 GC（auth/sessions 均为文件态）
    this.runtimePromise = undefined
  }

  private getRuntime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({
      authPath: this.authPath,
      modelsPath: this.modelsPath,
      allowModelNetwork: false
    })
    return this.runtimePromise
  }
}

/** 解析会话模型：settings 显式模型优先，否则取 provider 目录第一个可用模型。 */
function resolveModel(runtime: ModelRuntime, providerId: string, preferredModelId?: string) {
  if (preferredModelId !== undefined) {
    const model = runtime.getModel(providerId, preferredModelId)
    if (model !== undefined) return model
  }
  return runtime.getModels(providerId)[0]
}

/** 应用自有 ResourceLoader：不加载用户全局扩展，注入内置 teach 技能。 */
async function createAppLoader(options: {
  cwd: string
  agentDir: string
  teachSkillDir: string
  task: AgentTaskType
}): Promise<DefaultResourceLoader> {
  const isolatedResumeImport = options.task === 'resume_import'
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noExtensions: true,
    ...(isolatedResumeImport
      ? {
          // 导入只做文本→JSON，不加载代码 Agent 的 AGENTS.md、skills、模板或主题。
          // 否则项目上下文和技能清单会显著放大请求，干扰纯结构化并拖慢首 token。
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt:
            '你是一个只做简历文本结构化的数据转换器。严格遵循用户给出的 JSON 字段和事实约束；不调用工具，不解释，只输出 JSON。'
        }
      : {
          skillsOverride: (current: ReturnType<DefaultResourceLoader['getSkills']>) => ({
            skills: [bundledTeachSkill(options.teachSkillDir), ...current.skills],
            diagnostics: current.diagnostics
          })
        })
  })
  await loader.reload()
  return loader
}

/** 仓库内置 teach 技能（resources/teach/SKILL.md + 相对资源）。 */
function bundledTeachSkill(teachSkillDir: string): Skill {
  const filePath = join(teachSkillDir, 'SKILL.md')
  return {
    name: 'teach',
    description: 'Teach the user a new skill or concept, within this workspace.',
    filePath,
    baseDir: teachSkillDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: 'app-bundled' }),
    disableModelInvocation: true
  }
}

/** 写 api_key 凭据到 auth.json（read-modify-write；权限 0600）。 */
function writeApiKeyCredential(
  authPath: string,
  provider: string,
  credential: StoredApiKeyCredential
): void {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
  } catch {
    // 文件不存在或损坏：从空对象重建
  }
  data[provider] = credential
  writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(authPath, 0o600)
  } catch {
    // 平台不支持时忽略
  }
}

/** PiAgentSession：把 SDK 会话收敛为业务 AgentSession（事件归一化 + 回复全文提取）。 */
export class PiAgentSession implements AgentSession {
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private readonly sdk: SdkAgentSession,
    readonly task: AgentTaskType,
    readonly cwd: string,
    readonly id = sdk.sessionId
  ) {
    this.unsubscribe = sdk.subscribe((event) => {
      const mapped = mapSdkEvent(event)
      if (mapped !== undefined) this.emit(mapped)
    })
  }

  async prompt(text: string): Promise<string> {
    this.emit({ type: 'status', status: 'running' })
    try {
      await this.sdk.prompt(text)
      return lastAssistantText(this.sdk)
    } catch (error) {
      this.emit({ type: 'error', message: errorMessage(error) })
      throw error
    } finally {
      this.emit({ type: 'status', status: 'idle' })
    }
  }

  async steer(text: string): Promise<void> {
    await this.sdk.steer(text)
  }

  async followUp(text: string): Promise<void> {
    await this.sdk.followUp(text)
  }

  async abort(): Promise<void> {
    await this.sdk.abort()
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
    this.unsubscribe()
    this.listeners.clear()
    this.sdk.dispose()
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** SDK 事件面 → 业务事件面；无关事件返回 undefined（不转发）。 */
function mapSdkEvent(event: AgentSessionEvent): AgentEvent | undefined {
  switch (event.type) {
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        return { type: 'text_delta', delta: event.assistantMessageEvent.delta }
      }
      return undefined
    case 'agent_start':
    case 'turn_start':
      return { type: 'status', status: 'running' }
    case 'agent_settled':
      return { type: 'status', status: 'idle' }
    case 'turn_end':
      return { type: 'turn_end' }
    case 'tool_execution_start':
      return { type: 'tool_start', name: event.toolName }
    case 'tool_execution_end':
      return { type: 'tool_end', name: event.toolName }
    default:
      return undefined
  }
}

/** 取会话中最后一条 assistant 消息的文本（prompt 的完整回复）。 */
function lastAssistantText(session: SdkAgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role !== 'assistant') continue
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
