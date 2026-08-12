import { describe, expect, it } from 'vitest'
import {
  AgentNotConfiguredError,
  AgentService,
  isAgentNotConfiguredError,
  type AgentEvent,
  type AgentTaskType
} from './agent'
import { FakeAgentProvider, type FakeAgentSession } from './fake-agent-provider'

/** 事件序列辅助：把事件流按类型规约成断言友好的形状。 */
function eventTrace(events: AgentEvent[]): Array<{ type: string; [k: string]: unknown }> {
  return events.map((event) => ({ ...event }))
}

function makeService(options?: ConstructorParameters<typeof FakeAgentProvider>[0]) {
  const provider = new FakeAgentProvider(options)
  return { provider, service: new AgentService(provider) }
}

describe('AgentService — fake provider 会话全流程（AC-1）', () => {
  it('三种任务类型都能创建会话，任务/工作目录正确透传', async () => {
    const { service } = makeService()
    const cases: Array<[AgentTaskType, string | undefined]> = [
      ['optimize', undefined],
      ['interview', '/work/interview'],
      ['learn', '/work/learn']
    ]
    for (const [task, cwd] of cases) {
      const session = await service.createSession(task, cwd === undefined ? undefined : { cwd })
      expect(session.task).toBe(task)
      expect(session.cwd).toBe(cwd ?? 'fake-cwd')
      session.dispose()
    }
  })

  it('prompt 返回完整回复并记录提示', async () => {
    const { service } = makeService()
    const session = await service.createSession('optimize')
    const reply = await session.prompt('分析这段 JD')
    expect(reply).toBe('echo: 分析这段 JD')
    expect((session as FakeAgentSession).prompts).toEqual(['分析这段 JD'])
  })

  it('prompt 支持脚本化回复（onPrompt 钩子，可中途改写）', async () => {
    const { provider, service } = makeService()
    const session = await service.createSession('optimize')
    provider.onPrompt = () => '{"skills": ["ts"]}'
    await expect(session.prompt('第一轮')).resolves.toBe('{"skills": ["ts"]}')
    provider.onPrompt = (prompt) => `第二轮:${prompt}`
    await expect(session.prompt('继续')).resolves.toBe('第二轮:继续')
  })

  it('steer / followUp / abort 分别记录（面试长驻会话语义）', async () => {
    const { service } = makeService()
    const session = await service.createSession('interview')
    const fake = session as FakeAgentSession
    await session.steer('等等，我说错了我补充')
    await session.followUp('我答完了')
    await session.abort()
    expect(fake.steered).toEqual(['等等，我说错了我补充'])
    expect(fake.followUps).toEqual(['我答完了'])
    expect(fake.aborted).toBe(true)
  })

  it('dispose 后会话释放，AgentService.dispose 释放全部会话与 provider', async () => {
    const { provider, service } = makeService()
    const a = await service.createSession('optimize')
    const b = await service.createSession('interview')
    a.dispose()
    expect((a as FakeAgentSession).disposed).toBe(true)
    expect(provider.sessions.map((s) => s.id)).toEqual([b.id])

    service.dispose()
    expect((b as FakeAgentSession).disposed).toBe(true)
    expect(provider.sessions).toHaveLength(0)
  })

  it('prompt 失败：先发 error 事件再 reject（与真实 provider 契约一致）', async () => {
    const { service } = makeService()
    const session = await service.createSession('interview')
    const fake = session as FakeAgentSession
    fake.failNextPrompt = new Error('模型超时')
    await expect(session.prompt('hi')).rejects.toThrow('模型超时')
    const errors = fake.events.filter((event) => event.type === 'error')
    expect(errors).toEqual([{ type: 'error', message: '模型超时' }])
  })
})

describe('AgentService — 流式事件转发（AC-2）', () => {
  it('prompt 事件序列：running → text_delta* → turn_end → idle，delta 拼接等于回复', async () => {
    const { service } = makeService({ chunkSize: 4 })
    const session = await service.createSession('optimize')
    const fake = session as FakeAgentSession
    const reply = await session.prompt('0123456789')
    expect(reply).toBe('echo: 0123456789')
    expect(eventTrace(fake.events)).toEqual([
      { type: 'status', status: 'running' },
      { type: 'text_delta', delta: 'echo' },
      { type: 'text_delta', delta: ': 01' },
      { type: 'text_delta', delta: '2345' },
      { type: 'text_delta', delta: '6789' },
      { type: 'turn_end' },
      { type: 'status', status: 'idle' }
    ])
  })

  it('subscribe 收到与内部记录一致的事件流；退订后不再送达', async () => {
    const { service } = makeService()
    const session = await service.createSession('learn')
    const received: AgentEvent[] = []
    const unsubscribe = session.subscribe((event) => received.push(event))
    await session.prompt('hello')
    expect(received.map((event) => event.type)).toEqual([
      'status',
      'text_delta',
      'text_delta',
      'turn_end',
      'status'
    ])
    const before = received.length
    unsubscribe()
    await session.prompt('again')
    expect(received.length).toBe(before)
  })

  it('AgentService onEvent 注入面：事件带 sessionId 转发（IPC 推送依据）', async () => {
    const forwarded: Array<{ sessionId: string; event: AgentEvent }> = []
    const provider = new FakeAgentProvider()
    const service = new AgentService(provider, { onEvent: (sessionId, event) => forwarded.push({ sessionId, event }) })
    const session = await service.createSession('optimize')
    await session.prompt('转发我')
    expect(forwarded.map((f) => f.event.type)).toEqual([
      'status',
      'text_delta',
      'text_delta',
      'turn_end',
      'status'
    ])
    expect(forwarded.every((f) => f.sessionId === session.id)).toBe(true)
    const deltaEvents = forwarded.filter((f) => f.event.type === 'text_delta')
    expect(deltaEvents.map((f) => (f.event as { delta: string }).delta).join('')).toBe('echo: 转发我')
  })
})

describe('AgentService — learn 会话（teach 触发）', () => {
  it('learnSession 创建 learn 任务会话并自动触发 /skill:teach（带工作区声明）', async () => {
    const { service } = makeService()
    const session = await service.learnSession('TypeScript 泛型', { cwd: '/work/learn-ws' })
    expect(session.task).toBe('learn')
    expect(session.cwd).toBe('/work/learn-ws')
    const fake = session as FakeAgentSession
    expect(fake.prompts[0].startsWith('/skill:teach TypeScript 泛型')).toBe(true)
    expect(fake.prompts[0]).toContain('教学工作区（当前目录）：/work/learn-ws')
    // 事件流已可订阅（首条提示在返回前已开始）
    expect(fake.events.map((event) => event.type)).toContain('text_delta')
  })

  it('learnSession 首条提示失败：error 事件照常转发，不产生 unhandled rejection', async () => {
    const forwarded: AgentEvent[] = []
    const provider = new FakeAgentProvider()
    const service = new AgentService(provider, { onEvent: (_id, event) => forwarded.push(event) })
    provider.onPrompt = () => {
      throw new Error('模型不可用')
    }
    const session = await service.learnSession('JS')
    // 给后台 prompt 一个 tick 完成失败路径
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.dispose.bind(session)).not.toThrow()
    expect(forwarded.some((event) => event.type === 'error' && event.message === '模型不可用')).toBe(true)
  })
})

describe('AgentService — 未配置认证返回明确错误（AC-3，分层降级依据）', () => {
  it('未配置时 getStatus().configured=false，createSession 抛 AgentNotConfiguredError', async () => {
    const { provider, service } = makeService({ configured: false })
    expect(service.getStatus()).toEqual({ configured: false, provider: 'deepseek', model: 'deepseek-v4-flash' })
    const error = await service.createSession('optimize').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentNotConfiguredError)
    expect(isAgentNotConfiguredError(error)).toBe(true)
    expect((error as AgentNotConfiguredError).code).toBe('AGENT_NOT_CONFIGURED')
    expect((error as Error).message).toContain('未配置')
    expect(provider.sessions).toHaveLength(0)
  })

  it('configureProvider 后立即可用，且调用被记录（fake 同面）', async () => {
    const { provider, service } = makeService({ configured: false })
    await service.configureProvider('kimi-coding', 'sk-test', 'kimi-for-coding')
    expect(provider.configureCalls).toEqual([
      { provider: 'kimi-coding', apiKey: 'sk-test', model: 'kimi-for-coding' }
    ])
    expect(service.getStatus()).toEqual({
      configured: true,
      provider: 'kimi-coding',
      model: 'kimi-for-coding'
    })
    const session = await service.createSession('interview')
    expect(session.id).toBe('fake-1')
  })

  it('未配置时不创建任何会话；三种任务类型一致', async () => {
    const { service } = makeService({ configured: false })
    for (const task of ['optimize', 'interview', 'learn'] as const) {
      await expect(service.createSession(task)).rejects.toBeInstanceOf(AgentNotConfiguredError)
    }
  })
})
