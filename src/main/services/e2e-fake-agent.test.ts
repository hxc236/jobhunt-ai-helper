import { describe, expect, it } from 'vitest'
import { AgentService } from './agent'
import { FakeAgentProvider } from './fake-agent-provider'
import { createContentOptimizeFakeProvider, extractResumeFromPrompt } from './e2e-fake-agent'

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
      const parsed = JSON.parse(rewrite) as { resume: unknown; changes: Array<{ projectId: string }> }
      expect(parsed.resume).toEqual(resume)
      expect(parsed.changes[0]?.projectId).toBe('proj-1')
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
