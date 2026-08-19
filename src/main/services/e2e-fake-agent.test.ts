import { describe, expect, it } from 'vitest'
import { AgentService } from './agent'
import { FakeAgentProvider } from './fake-agent-provider'
import { createContentOptimizeFakeProvider, extractResumeFromPrompt, findCompetitionHonorIndex } from './e2e-fake-agent'

describe('E2E 假 agent（#90/T02：dev 模式开关）', () => {
  it('从诊断提示词提取简历 JSON（简历 JSON：标记之后）', () => {
    const prompt = [
      '[内容优化 1/2：规则诊断] ...',
      '简历 JSON：',
      JSON.stringify({ basics: { name: '张伟' }, projects: [{ id: 'proj-1', name: '平台' }] })
    ].join('\n')
    const resume = extractResumeFromPrompt(prompt)
    expect(resume?.basics?.name).toBe('张伟')
    expect(resume?.projects?.[0]?.id).toBe('proj-1')
  })

  it('无简历 JSON 标记时返回 null', () => {
    expect(extractResumeFromPrompt('no resume here')).toBeNull()
  })

  it('内容优化诊断轮返回「全部保持」空诊断（无需修改 → 不建版本）', async () => {
    const provider = createContentOptimizeFakeProvider()
    const agent = new AgentService(provider)
    const session = await agent.createSession('content_optimize')
    try {
      const reply = await session.prompt(
        [
          '[内容优化 1/2：规则诊断]',
          '简历 JSON：',
          JSON.stringify({
            basics: { name: '张伟' },
            projects: [{ id: 'proj-1', name: '平台' }, { id: 'proj-2', name: '工具' }]
          })
        ].join('\n')
      )
      const parsed = JSON.parse(reply) as { projects: Array<{ projectId: string; verdict: string }>; questions: unknown[] }
      expect(parsed.projects).toEqual([
        { projectId: 'proj-1', verdict: 'keep' },
        { projectId: 'proj-2', verdict: 'keep' }
      ])
      expect(parsed.questions).toEqual([])
    } finally {
      session.dispose()
    }
  })

  it('非内容优化任务回显（不触真实模型）', async () => {
    const provider = createContentOptimizeFakeProvider()
    const agent = new AgentService(provider)
    const session = await agent.createSession('optimize')
    try {
      const reply = await session.prompt('你好')
      expect(reply).toBe('echo: 你好')
    } finally {
      session.dispose()
    }
  })

  it('#94 追问场景：诊断返回带稳定 id 的追问（needs-info + questions），改写轮返回合法 ContentRewrite', async () => {
    const provider = createContentOptimizeFakeProvider({ scenario: 'questions' })
    const agent = new AgentService(provider)
    const resume = {
      basics: { name: '张伟' },
      projects: [{ id: 'proj-1', name: '平台', description: 'C2C 二手交易系统' }]
    }
    const session = await agent.createSession('content_optimize')
    try {
      const diag = JSON.parse(
        await session.prompt(
          ['[内容优化 1/2：规则诊断]', '简历 JSON：', JSON.stringify(resume)].join('\n')
        )
      ) as {
        projects: Array<{ projectId: string; verdict: string }>
        questions: Array<{ id: string; projectId: string; field: string; candidates: string[] }>
      }
      expect(diag.projects).toEqual([{ projectId: 'proj-1', verdict: 'needs-info' }])
      expect(diag.questions.length).toBe(2)
      expect(diag.questions[0]).toMatchObject({ id: 'q1', projectId: 'proj-1', field: '难点' })
      expect(diag.questions[0]!.candidates.length).toBeGreaterThan(0)

      const rewrite = await session.prompt(
        ['[内容优化 2/2：项目改写]', '简历 JSON：', JSON.stringify(resume)].join('\n')
      )
      const parsed = JSON.parse(rewrite) as {
        resume: { projects: Array<{ id: string; description: string }> }
        changes: Array<{ projectId: string; source: string }>
      }
      // T06：改写稿对项目做真实改动（含高并发难点与可量化结果），change 有来源与稳定归属
      expect(parsed.resume.projects[0]?.description).toContain('高并发难点与可量化结果')
      expect(parsed.changes[0]?.projectId).toBe('proj-1')
      expect(parsed.changes[0]?.source).toBe('user-answer')
    } finally {
      session.dispose()
    }
  })

  it('#94 追问场景可显式选择；默认仍为空诊断（向后兼容）', async () => {
    const provider = createContentOptimizeFakeProvider({ scenario: 'empty' })
    const agent = new AgentService(provider)
    const session = await agent.createSession('content_optimize')
    try {
      const reply = await session.prompt(
        ['[内容优化 1/2：规则诊断]', '简历 JSON：', JSON.stringify({ projects: [{ id: 'proj-1', name: '平台' }] })].join('\n')
      )
      const parsed = JSON.parse(reply) as { questions: unknown[] }
      expect(parsed.questions).toEqual([])
    } finally {
      session.dispose()
    }
  })

  it('FakeAgentProvider 默认回显与 failNextPrompt 兼容（底层假 agent 可注入脚本）', async () => {
    const provider = new FakeAgentProvider()
    const agent = new AgentService(provider)
    const session = await agent.createSession('content_optimize')
    try {
      expect(await session.prompt('hi')).toBe('echo: hi')
    } finally {
      session.dispose()
    }
  })
})

describe('E2E 假 agent 大赛提升场景（T08/#98）', () => {
  const resumeWithHonors = {
    basics: { name: '张伟' },
    projects: [{ id: 'proj-1', name: '平台' }],
    honors: ['全国大学生数学建模竞赛省一等奖', '校三好学生']
  }

  it('promotion 场景：honors 含大赛 → 诊断返回提升建议（honorIndex/缺失字段）', async () => {
    const provider = createContentOptimizeFakeProvider({ scenario: 'promotion' })
    const agent = new AgentService(provider)
    const session = await agent.createSession('content_optimize')
    try {
      const reply = await session.prompt(
        ['[内容优化 1/2：规则诊断]', '简历 JSON：', JSON.stringify(resumeWithHonors)].join('\n')
      )
      const parsed = JSON.parse(reply) as { promotions: Array<{ id: string; honorIndex: number; honorName: string; missingFields: string[] }> }
      expect(parsed.promotions).toHaveLength(1)
      expect(parsed.promotions[0]!.honorIndex).toBe(0)
      expect(parsed.promotions[0]!.honorName).toBe('全国大学生数学建模竞赛省一等奖')
      expect(parsed.promotions[0]!.missingFields).toEqual(['startDate', 'techStack', 'description'])
    } finally {
      session.dispose()
    }
  })

  it('promotion 场景：honors 已无大赛（提升完成）→ 全部保持空诊断（promotions 空）', async () => {
    const provider = createContentOptimizeFakeProvider({ scenario: 'promotion' })
    const agent = new AgentService(provider)
    const session = await agent.createSession('content_optimize')
    try {
      const reply = await session.prompt(
        [
          '[内容优化 1/2：规则诊断]',
          '简历 JSON：',
          JSON.stringify({
            basics: { name: '张伟' },
            projects: [{ id: 'proj-1', name: '平台' }, { id: 'proj-2', name: '全国大学生数学建模竞赛省一等奖' }],
            honors: ['校三好学生']
          })
        ].join('\n')
      )
      const parsed = JSON.parse(reply) as { projects: unknown[]; promotions: unknown[] }
      expect(parsed.promotions).toEqual([])
      expect(parsed.projects).toHaveLength(2)
    } finally {
      session.dispose()
    }
  })

  it('findCompetitionHonorIndex：识别大赛条目下标；无大赛返回 -1', () => {
    expect(findCompetitionHonorIndex(['校三好学生', '全国大学生数学建模竞赛省一等奖'])).toBe(1)
    expect(findCompetitionHonorIndex(['校三好学生', '优秀学生干部'])).toBe(-1)
    expect(findCompetitionHonorIndex(undefined)).toBe(-1)
  })
})
