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
