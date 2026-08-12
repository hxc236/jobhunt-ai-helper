import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { AgentService } from './agent'
import { FakeAgentProvider, type FakeAgentSession } from './fake-agent-provider'
import { InterviewError, InterviewService, parseReview } from './interview'
import { PositionService } from './position'
import { ResumeService } from './resume'
import { TopicService } from './topic'
import type { InterviewReview, JdAnalysis } from '../../shared/types'

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

  it('followUp：当前生成结束后排队投递补充说明', async () => {
    const h = makeHarness()
    const { sessionId } = await h.start()
    await h.svc.followUp(sessionId, '补充一点：我熟悉 Kafka')

    const session = h.provider.sessions[0]!
    expect(session.followUps).toEqual(['补充一点：我熟悉 Kafka'])
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


describe('InterviewService 复盘生成（F-25/#39）', () => {
  it('end 后自动生成复盘：4 维度/亮点/薄弱点（含参考回答）/下一步 校验通过并落库 interviews.review', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const resumes = new ResumeService(db)
    const topics = new TopicService(db, positions)
    const provider = new FakeAgentProvider({
      onPrompt: (prompt) => {
        if (prompt.includes('[面试开场]')) return '开场白'
        if (prompt.includes('[技术面')) {
          return JSON.stringify({ difficulty: 'standard', question: '问题' })
        }
        if (prompt.includes('[面试复盘]')) {
          return JSON.stringify({
            total: 82,
            dimensions: [
              { name: '技术深度', score: 80, comment: '基础扎实' },
              { name: '表达逻辑', score: 85, comment: '条理清晰' },
              { name: '应变', score: 75, comment: '追问时稍显紧张' },
              { name: '匹配度', score: 88, comment: '与 JD 高度匹配' }
            ],
            strengths: ['Java 基础好'],
            weaknesses: [{ item: '分布式经验不足', reference: '建议补充 CAP 与一致性协议' }],
            nextSteps: ['深入学习分布式']
          })
        }
        return 'reply'
      }
    })
    const svc = new InterviewService(db, positions, resumes, topics, new AgentService(provider))
    const job = positions.create({
      company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
    })
    db.prepare('UPDATE positions SET jd_analysis = ? WHERE id = ?').run(JSON.stringify(analysis), job.id)

    const { sessionId, interviewId } = await svc.start(job.id, 'real')
    await svc.answer(sessionId, '我熟悉 Java 与 Spring Boot')
    const record = await svc.end(sessionId)

    expect(record.status).toBe('ended')
    const stored = svc.getInterview(interviewId)
    const review = stored?.review as InterviewReview | null
    expect(review).not.toBeNull()
    expect(review!.total).toBe(82)
    expect(review!.dimensions).toHaveLength(4)
    expect(review!.dimensions.map((d) => d.name)).toEqual(['技术深度', '表达逻辑', '应变', '匹配度'])
    expect(review!.weaknesses[0]).toMatchObject({ item: '分布式经验不足', reference: expect.any(String) })
    expect(review!.nextSteps).toHaveLength(1)
  })

  it('复盘输出结构非法（维度缺失）→ 抛错；end 不因复盘失败而中断（review 为空）', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const resumes = new ResumeService(db)
    const topics = new TopicService(db, positions)
    const provider = new FakeAgentProvider({
      onPrompt: (prompt) => {
        if (prompt.includes('[面试开场]')) return '开场白'
        if (prompt.includes('[技术面')) return JSON.stringify({ difficulty: 'standard', question: 'q' })
        return JSON.stringify({ total: 50, dimensions: [] }) // 维度缺失
      }
    })
    const svc = new InterviewService(db, positions, resumes, topics, new AgentService(provider))
    const job = positions.create({
      company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
    })
    const { sessionId, interviewId } = await svc.start(job.id, 'real')
    await svc.answer(sessionId, '答')
    const record = await svc.end(sessionId) // 复盘失败不阻断
    expect(record.status).toBe('ended')
    expect(svc.getInterview(interviewId)?.review).toBeNull()
  })

  it('parseReview：维度数量/字段/未知维度校验', () => {
    const good = {
      total: 1, dimensions: [
        { name: '技术深度', score: 1, comment: 'a' },
        { name: '表达逻辑', score: 1, comment: 'a' },
        { name: '应变', score: 1, comment: 'a' },
        { name: '匹配度', score: 1, comment: 'a' }
      ], strengths: [], weaknesses: [], nextSteps: []
    }
    expect(parseReview(JSON.stringify(good)).dimensions).toHaveLength(4)
    expect(() => parseReview('{"total":1,"dimensions":[{"name":"技术深度","score":1,"comment":"a"}]}')).toThrowError(/4 个/)
    expect(() => parseReview('not json')).toThrowError(/JSON/)
    expect(() =>
      parseReview(
        JSON.stringify({ ...good, dimensions: [...good.dimensions.slice(0, 3), { name: '未知维度', score: 1, comment: 'a' }] })
      )
    ).toThrowError(/未知复盘维度/)
  })
})
