import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { AgentService } from './agent'
import { FakeAgentProvider, type FakeAgentSession } from './fake-agent-provider'
import { InterviewError, InterviewService } from './interview'
import { PositionService } from './position'
import { ResumeService } from './resume'
import { TopicService } from './topic'
import type { JdAnalysis } from '../../shared/types'

const JD = '要求：Java、Spring Boot、MySQL、分布式；本科及以上'

const analysis: JdAnalysis = {
  skills: ['Java', 'Spring Boot'],
  keywords: ['分布式'],
  requirements: ['本科及以上'],
  hardRequirements: ['Java 并发', '分布式经验'],
  parsedAt: '2026-08-01T00:00:00Z',
  jdFingerprint: 'fp'
}

const baseResume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机' }],
  skills: [{ category: '语言', items: ['Java'] }],
  projects: [{ name: '二手平台', techStack: ['Java', 'Spring Boot'], highlights: ['订单接口'] }]
}

/** 面试 fake：按阶段标记返回 JSON（{difficulty, question}），首轮开场返回文本。 */
function makeHarness(options: {
  style?: 'real' | 'coach' | 'strict'
  difficulties?: Array<'deep' | 'standard' | 'basic'>
} = {}): {
  svc: InterviewService
  provider: FakeAgentProvider
  jobId: string
  start: () => Promise<{ sessionId: string; interviewId: string; opening: string }>
  prompts: () => string[]
} {
  const db = openDatabase(':memory:')
  const positions = new PositionService(db)
  const resumes = new ResumeService(db)
  const topics = new TopicService(db, positions)
  const difficulties = options.difficulties ?? ['deep', 'standard', 'basic', 'deep']
  let difficultyIdx = 0

  const provider = new FakeAgentProvider({
    onPrompt: (prompt) => {
      if (prompt.includes('[面试开场]')) return '欢迎参加面试，请先做一下自我介绍。'
      if (prompt.includes('[反问阶段]')) return '好的，这就是我的问题。你有什么想问我的吗？'
      if (prompt.includes('[收尾]')) return '今天的面试到此结束，感谢参与。'
      const difficulty = difficulties[difficultyIdx % difficulties.length]
      difficultyIdx++
      return JSON.stringify({ difficulty, question: `关于「${prompt.slice(0, 20)}」的追问` })
    }
  })

  const svc = new InterviewService(db, positions, resumes, topics, new AgentService(provider))
  const job = positions.create({
    company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
  })
  db.prepare('UPDATE positions SET jd_analysis = ? WHERE id = ?').run(JSON.stringify(analysis), job.id)
  // 派生稿（targetJobId 关联职位）
  resumes.create({
    ...baseResume,
    meta: { title: '优化稿', baseResumeId: 'res-x', targetJobId: job.id }
  })
  // learned 清单条目
  topics.create({ title: 'Redis 持久化', note: '', jobId: job.id })
  topics.setStatus(topics.list()[0]!.id, 'learned')
  topics.create({ title: 'Kafka 原理', note: '', jobId: job.id })
  topics.setStatus(topics.list()[1]!.id, 'learned')

  const prompts: string[] = []
  provider.onPrompt = ((original: (p: string, s: FakeAgentSession) => string | Promise<string>) => (p: string, s: FakeAgentSession) => {
    prompts.push(p)
    return original(p, s)
  })(provider.onPrompt!)

  return {
    svc,
    provider,
    jobId: job.id,
    start: () => svc.start(job.id, options.style ?? 'real'),
    prompts: () => [...prompts]
  }
}

describe('InterviewService 会话编排（F-23/#37）', () => {
  it('start：注入 JD 分析/优化稿/learned 清单，开场白入 transcript；阶段=开场', async () => {
    const h = makeHarness()
    const started = await h.start()

    expect(started.opening).toContain('自我介绍')
    expect(h.prompts()[0]).toContain('[面试开场]')
    expect(h.prompts()[0]).toContain('Java 并发') // jd_analysis 注入
    expect(h.prompts()[0]).toContain('分布式')
    expect(h.prompts()[0]).toContain('二手平台') // 项目深挖素材
    expect(h.prompts()[0]).toContain('Redis 持久化') // learned 清单
    expect(h.prompts()[0]).toContain('Kafka 原理')
    expect(h.prompts()[0]).toContain('优化稿') // 优化简历注入
  })

  it('风格注入：real/coach/strict 文案在开场与追问 prompt 中', async () => {
    const real = makeHarness()
    await real.start()
    expect(real.prompts()[0]).toMatch(/真实面试官|追问细节/)

    const coach = makeHarness({ style: 'coach' })
    await coach.start()
    const coachPrompts = coach.prompts()
    expect(coachPrompts[0]).toMatch(/教练|鼓励|提示/)

    const strict = makeHarness({ style: 'strict' })
    await strict.start()
    expect(strict.prompts()[0]).toMatch(/严格|挑错/)
  })

  it('answer：技术面按 硬性要求 → 项目深挖 → learned 检验 阶段推进，动态难度随轮次变化', async () => {
    const h = makeHarness()
    const { sessionId } = await h.start()

    // 硬性要求 2 条 → 项目 1 个 → learned 2 条 = 5 轮技术面
    const replies: string[] = []
    for (let i = 0; i < 5; i++) {
      replies.push(await h.svc.answer(sessionId, `回答 ${i}`))
    }
    expect(replies).toHaveLength(5)
    // 各轮 prompt 含阶段标记：hard/project/learned
    const all = h.prompts()
    expect(all[1]).toContain('[技术面-硬性要求]')
    expect(all[2]).toContain('[技术面-硬性要求]')
    expect(all[3]).toContain('[技术面-项目深挖]')
    expect(all[4]).toContain('[技术面-learned 检验]')
    expect(all[5]).toContain('[技术面-learned 检验]')
  })

  it('阶段耗尽 → 反问阶段；用户回复后 → 收尾（end）', async () => {
    const h = makeHarness()
    const { sessionId } = await h.start()
    for (let i = 0; i < 5; i++) {
      await h.svc.answer(sessionId, `回答 ${i}`)
    }
    const questionTurn = await h.svc.answer(sessionId, '回答 5') // 反问引导
    expect(questionTurn).toContain('你有什么想问我的吗')

    const finalTurn = await h.svc.answer(sessionId, '我想问薪资待遇')
    expect(finalTurn).toContain('有什么想问我的吗') // 反问可多轮（再次询问）

    const closingTurn = await h.svc.answer(sessionId, '没有了，谢谢')
    expect(closingTurn).toContain('面试到此结束') // 第二轮反问后进入收尾
  })

  it('动态难度：agent 返回的 difficulty 决定下一轮追问深度（deep→深挖/basic→降级）', async () => {
    const h = makeHarness({ difficulties: ['deep', 'basic'] })
    const { sessionId } = await h.start()
    await h.svc.answer(sessionId, '答') // 第一轮（standard 起始）
    await h.svc.answer(sessionId, '答得好') // 第二轮：携带第一轮评判 deep
    const deepPrompt = h.prompts()[2]
    expect(deepPrompt).toContain('难度：deep') // 答得好 → 深挖

    await h.svc.answer(sessionId, '不会') // 第三轮：携带第二轮评判 basic
    const basicPrompt = h.prompts()[3]
    expect(basicPrompt).toContain('难度：basic') // 答得不好 → 降级
  })

  it('interrupt：打断当前生成并插队提示（abort + steer）', async () => {
    const h = makeHarness()
    const { sessionId } = await h.start()
    await h.svc.interrupt(sessionId)

    const session = h.provider.sessions[0]!
    expect(session.aborted).toBe(true)
    expect(session.steered.length).toBeGreaterThan(0)
  })

  it('transcript 落库：逐轮追加（含 user/assistant），end 后 status=ended', async () => {
    const h = makeHarness()
    const { sessionId, interviewId } = await h.start()
    await h.svc.answer(sessionId, '我的自我介绍')

    const ended = await h.svc.end(sessionId)
    expect(ended.status).toBe('ended')

    const row = h.svc.getInterview(interviewId)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('ended')
    const transcript = row!.transcript
    expect(transcript.length).toBeGreaterThanOrEqual(4) // 开场+自介+追问+收尾
    expect(transcript[0]!.role).toBe('assistant')
    expect(transcript[1]!.role).toBe('user')
    expect(transcript[1]!.text).toBe('我的自我介绍')
    expect(transcript.some((t) => t.role === 'assistant' && t.text.includes('结束'))).toBe(true)
  })

  it('history：已完成面试可查（#41 复盘数据源）', async () => {
    const h = makeHarness()
    const { sessionId } = await h.start()
    await h.svc.end(sessionId)
    expect(h.svc.history()).toHaveLength(1)
  })

  it('边界：不存在的会话 → 报错；职位不存在 → 报错', async () => {
    const h = makeHarness()
    await expect(h.svc.answer('no-session', 'x')).rejects.toThrowError(InterviewError)
    await expect(h.svc.end('no-session')).rejects.toThrowError(InterviewError)
    const db = openDatabase(':memory:')
    const svc2 = new InterviewService(
      db,
      new PositionService(db),
      new ResumeService(db),
      new TopicService(db, new PositionService(db)),
      new AgentService(new FakeAgentProvider())
    )
    await expect(svc2.start('no-job', 'real')).rejects.toThrowError(/职位不存在/)
  })
})
