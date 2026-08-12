import type { AgentService, AgentSession } from './agent'
import type { TopicService } from './topic'

/**
 * teach 聊天会话服务（F-22/#36）：learn 任务会话注册表。
 * - start(topicId)：按条目标题触发 agent.learnSession（cwd=教学工作区、
 *   continueRecent 跨次续接、/skill:teach 显式触发——策略在 AgentService，#16 已实现）；
 * - send(sessionId, text)：发送消息并等待整轮回复（流式增量经 agent:delta 事件
 *   由主进程全局转发，UI 打字机消费）；
 * - dispose(sessionId) / disposeAll。
 */

export class LearnError extends Error {
  constructor(
    readonly code: 'session-not-found' | 'topic-not-found',
    message: string
  ) {
    super(message)
    this.name = 'LearnError'
  }
}

export class LearnService {
  private readonly sessions = new Map<string, { session: AgentSession; topicTitle: string }>()

  constructor(
    private readonly agent: AgentService,
    private readonly topics: TopicService
  ) {}

  /** 按清单条目开启 teach 会话（同一条目已有进行中会话 → 复用并标记 resumed）。 */
  async start(topicId: string): Promise<{ sessionId: string; topicTitle: string; resumed: boolean }> {
    const topic = this.topics.list().find((t) => t.id === topicId)
    if (topic === undefined) throw new LearnError('topic-not-found', `学习条目不存在：${topicId}`)

    const existing = [...this.sessions.entries()].find(([, entry]) => entry.topicTitle === topic.title)
    if (existing !== undefined) {
      return { sessionId: existing[0], topicTitle: topic.title, resumed: true }
    }

    const session = await this.agent.learnSession(topic.title)
    const sessionId = `learn-${session.id}`
    this.sessions.set(sessionId, { session, topicTitle: topic.title })
    return { sessionId, topicTitle: topic.title, resumed: false }
  }

  /** 发送消息（agent 流式增量经全局 agent:delta 推送；返回整轮回复全文）。 */
  async send(sessionId: string, text: string): Promise<string> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) throw new LearnError('session-not-found', `会话不存在：${sessionId}`)
    return entry.session.prompt(text)
  }

  dispose(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry !== undefined) {
      entry.session.dispose()
      this.sessions.delete(sessionId)
    }
  }

  disposeAll(): void {
    for (const entry of this.sessions.values()) entry.session.dispose()
    this.sessions.clear()
  }
}
