import type { AgentSession, AgentStatus } from './agent'
import type { CrawlDriver, DriverAction } from './crawl-driver'

/**
 * Agent 通道（issue #59）：采集运行异常/登录场景的自动介入通道。
 *
 * 决策循环（快照 → 现有 agent 层输出动作 → driver 执行 → 再快照）：
 * - 调用方（CrawlService 抓取重试耗尽后）调用 handleFetchFailure；
 * - 循环最多 MAX_ROUNDS 轮：driver.snapshot() 观察 → agent 输出 JSON 动作
 *   （click/type/wait/retry/handoff）→ driver.act() 执行；
 * - agent 输出 retry → 返回 true（调用方重试一次抓取）；
 *   agent 输出 handoff 或轮数耗尽 → 返回 false（交还用户：错误留痕带"需人工处理"标记）；
 * - agent 未配置/会话失败 → false（不阻塞采集主流程）。
 *
 * 边界：不绕过任何验证码/风控——通道只做正常浏览器交互（点击/输入/等待/重试），
 * 识别不了或解决不了的场景一律交还用户。
 */
export const AGENT_CHANNEL_MAX_ROUNDS = 5

/** Agent 通道接口（采集框架依赖此面；实现类可替换）。 */
export interface CrawlAgentChannel {
  /** 抓取失败介入：true = 已解决（可重试一次抓取）；false = 无法处理（交还用户）。 */
  handleFetchFailure(context: { url: string; error: string }): Promise<boolean>
}

export interface CrawlAgentChannelOptions {
  /** 最大决策轮数（缺省 AGENT_CHANNEL_MAX_ROUNDS）。 */
  maxRounds?: number
}

export class CrawlAgentChannelImpl implements CrawlAgentChannel {
  private readonly maxRounds: number

  constructor(
    private readonly driver: CrawlDriver,
    private readonly agent: {
      createSession(task: 'agent_channel', options?: unknown): Promise<AgentSession>
      getStatus(): AgentStatus
    },
    options: CrawlAgentChannelOptions = {}
  ) {
    this.maxRounds = options.maxRounds ?? AGENT_CHANNEL_MAX_ROUNDS
  }

  async handleFetchFailure(context: { url: string; error: string }): Promise<boolean> {
    if (!this.agent.getStatus().configured) return false

    let session: AgentSession | null = null
    try {
      session = await this.agent.createSession('agent_channel')
      for (let round = 0; round < this.maxRounds; round++) {
        let observation: string
        try {
          observation = await this.driver.snapshot(2000)
        } catch {
          return false // 页面不可观察（窗口没了等）→ 交还用户
        }
        const reply = await session.prompt(buildRoundPrompt(context, observation))
        const parsed = parseAction(reply)
        if (parsed === null) return false // 不可解析 → 交还用户
        if (parsed.kind === 'retry') return true
        if (parsed.kind === 'handoff') return false
        try {
          await this.driver.act(parsed.action)
        } catch {
          return false // 动作执行失败 → 交还用户
        }
      }
      return false // 轮数耗尽 → 交还用户
    } catch {
      return false // 会话失败/未配置 → 交还用户（不抛，不阻塞采集）
    } finally {
      session?.dispose()
    }
  }
}

/** 动作解析结果（判别联合：action=驱动动作；retry/handoff=控制动作）。 */
export type ParsedAction =
  | { kind: 'action'; action: DriverAction }
  | { kind: 'retry' }
  | { kind: 'handoff' }

/** 动作解析：agent 回复 JSON → 判别联合；不可解析 → null。 */
export function parseAction(reply: string): ParsedAction | null {
  const trimmed = reply.trim()
  // 容错：模型可能包 ```json 代码块
  const jsonText = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const action = parsed as { type?: unknown; selector?: unknown; text?: unknown; ms?: unknown }
  switch (action.type) {
    case 'retry':
      return { kind: 'retry' }
    case 'handoff':
      return { kind: 'handoff' }
    case 'click':
      return typeof action.selector === 'string' && action.selector !== ''
        ? { kind: 'action', action: { type: 'click', selector: action.selector } }
        : null
    case 'type':
      return typeof action.selector === 'string' && action.selector !== '' && typeof action.text === 'string'
        ? { kind: 'action', action: { type: 'type', selector: action.selector, text: action.text } }
        : null
    case 'wait': {
      const ms = Number(action.ms)
      return Number.isInteger(ms) && ms > 0 && ms <= 60_000
        ? { kind: 'action', action: { type: 'wait', ms } }
        : null
    }
    default:
      return null
  }
}

/** 每轮提示词：任务上下文 + 页面观察 → 只输出一个 JSON 动作。 */
function buildRoundPrompt(context: { url: string; error: string }, observation: string): string {
  return [
    '你是采集助手的浏览器操作员。一次抓取失败，请观察当前页面并给出下一个动作。',
    `抓取目标：${context.url}`,
    `失败原因：${context.error}`,
    `当前页面观察（DOM 文本）：\n${observation || '（空）'}`,
    '动作只能是以下 JSON 之一（只输出 JSON，不要解释）：',
    '{"type":"click","selector":"CSS 选择器"}',
    '{"type":"type","selector":"CSS 选择器","text":"输入文本"}',
    '{"type":"wait","ms":毫秒数}',
    '{"type":"retry"} —— 页面已恢复可抓取，请调用方重试',
    '{"type":"handoff"} —— 无法解决（如验证码/登录墙），交还用户',
    '规则：解决登录/风控提示优先；识别不了问题就输出 handoff，不要乱点。'
  ].join('\n')
}
