import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { AgentService } from './agent'
import { FakeAgentProvider } from './fake-agent-provider'
import { LearnError, LearnService } from './learn'
import { PositionService } from './position'
import { TopicService } from './topic'
import type { JdAnalysis } from '../../shared/types'

function makeHarness(): {
  learn: LearnService
  provider: FakeAgentProvider
  topicId: string
} {
  const db = openDatabase(':memory:')
  const positions = new PositionService(db)
  const topics = new TopicService(db, positions)
  const provider = new FakeAgentProvider({ onPrompt: (p) => `reply: ${p.slice(0, 40)}` })
  const learn = new LearnService(new AgentService(provider), topics)

  const job = positions.create({
    company: '腾讯', company_type: '大厂', title: '后端', jd: 'x', recruit_season: '2026秋招'
  })
  const analysis: JdAnalysis = {
    skills: [], keywords: [], requirements: [], hardRequirements: [],
    parsedAt: 'x', jdFingerprint: 'fp'
  }
  db.prepare('UPDATE positions SET jd_analysis = ? WHERE id = ?').run(JSON.stringify(analysis), job.id)
  const topic = topics.create({ title: 'Redis 持久化原理', note: '重点' })
  return { learn, provider, topicId: topic.id }
}

describe('LearnService teach 会话（F-22/#36）', () => {
  it('start：创建 learn 任务会话，首条提示 /skill:teach <条目标题>（带工作区声明）', async () => {
    const { learn, provider, topicId } = makeHarness()
    const started = await learn.start(topicId)

    expect(started.resumed).toBe(false)
    expect(started.topicTitle).toBe('Redis 持久化原理')
    expect(provider.sessions).toHaveLength(1)
    const session = provider.sessions[0]!
    expect(session.task).toBe('learn')
    expect(session.prompts[0]!.startsWith('/skill:teach Redis 持久化原理')).toBe(true)
    expect(session.prompts[0]).toContain('教学工作区')
  })

  it('send：消息经会话 prompt 发送并返回整轮回复；agent 事件流（text_delta）可见', async () => {
    const { learn, provider, topicId } = makeHarness()
    const { sessionId } = await learn.start(topicId)

    const reply = await learn.send(sessionId, '讲一下 RDB 与 AOF 的区别')
    expect(reply).toContain('讲一下 RDB 与 AOF 的区别')
    const session = provider.sessions[0]!
    expect(session.events.some((e) => e.type === 'text_delta')).toBe(true) // 流式增量（UI 打字机）
  })

  it('同一主题再次 start → 复用进行中会话（resumed=true，不新建）', async () => {
    const { learn, provider, topicId } = makeHarness()
    await learn.start(topicId)
    const second = await learn.start(topicId)

    expect(second.resumed).toBe(true)
    expect(provider.sessions).toHaveLength(1)
  })

  it('不存在的条目/会话 → 明确报错；dispose 后可复用新建', async () => {
    const { learn, provider, topicId } = makeHarness()
    await expect(learn.start('no-such-topic')).rejects.toThrowError(LearnError)
    await expect(learn.send('no-such-session', 'hi')).rejects.toThrowError(/会话不存在/)

    const { sessionId } = await learn.start(topicId)
    learn.dispose(sessionId)
    const again = await learn.start(topicId)
    expect(again.resumed).toBe(false)
    // dispose 会从 provider.sessions 移除旧会话；重新创建后仅剩新会话
    expect(provider.sessions).toHaveLength(1)
  })

  it('未配置 agent → AgentNotConfiguredError（降级依据）', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const topics = new TopicService(db, positions)
    const provider = new FakeAgentProvider({ configured: false })
    const learn = new LearnService(new AgentService(provider), topics)
    const topic = topics.create({ title: 'x' })

    await expect(learn.start(topic.id)).rejects.toThrowError(/未配置/)
  })
})
