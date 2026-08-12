import { describe, expect, it } from 'vitest'
import { AgentService } from './agent'
import { FakeAgentProvider } from './fake-agent-provider'
import { AGENT_CHANNEL_MAX_ROUNDS, CrawlAgentChannelImpl, parseAction } from './crawl-agent-channel'
import type { CrawlDriver, DriverAction } from './crawl-driver'

/** 记录型 fake driver：可编程快照/登录态；记录动作序列。 */
function makeFakeDriver(options: { snapshotText?: string; failAct?: boolean } = {}): CrawlDriver & {
  actions: DriverAction[]
} {
  const actions: DriverAction[] = []
  return {
    actions,
    async navigate() {},
    async snapshot() {
      return options.snapshotText ?? '页面快照'
    },
    async act(action) {
      if (options.failAct) throw new Error('act failed')
      actions.push(action)
    },
    async loginStatus() {
      return 'logged-out'
    },
    async dispose() {}
  }
}

function makeAgent(onPrompt: (prompt: string) => string, configured = true): AgentService {
  const provider = new FakeAgentProvider({ configured, onPrompt })
  return new AgentService(provider)
}

describe('parseAction（动作解析，纯函数）', () => {
  it('合法动作/控制动作解析；容错 ```json 包裹', () => {
    expect(parseAction('{"type":"click","selector":"#btn"}')).toEqual({
      kind: 'action',
      action: { type: 'click', selector: '#btn' }
    })
    expect(parseAction('{"type":"type","selector":"input","text":"前端"}')).toEqual({
      kind: 'action',
      action: { type: 'type', selector: 'input', text: '前端' }
    })
    expect(parseAction('{"type":"wait","ms":3000}')).toEqual({
      kind: 'action',
      action: { type: 'wait', ms: 3000 }
    })
    expect(parseAction('```json\n{"type":"retry"}\n```')).toEqual({ kind: 'retry' })
    expect(parseAction('{"type":"handoff"}')).toEqual({ kind: 'handoff' })
  })

  it('非法/缺字段/超限 → null', () => {
    expect(parseAction('不是 JSON')).toBeNull()
    expect(parseAction('{"type":"click"}')).toBeNull() // 缺 selector
    expect(parseAction('{"type":"wait","ms":999999}')).toBeNull() // 超限
    expect(parseAction('{"type":"nuke"}')).toBeNull()
  })
})

describe('CrawlAgentChannel.handleFetchFailure（issue #59）', () => {
  it('决策循环：快照 → 动作 → 执行 → 最终 retry → 返回 true', async () => {
    const driver = makeFakeDriver()
    let rounds = 0
    const agent = makeAgent(() => {
      rounds++
      return rounds < 3 ? '{"type":"wait","ms":1000}' : '{"type":"retry"}'
    })
    const channel = new CrawlAgentChannelImpl(driver, agent)

    await expect(channel.handleFetchFailure({ url: 'https://boss/u', error: 'code:37' })).resolves.toBe(true)
    expect(driver.actions).toHaveLength(2) // 两次 wait
    expect(rounds).toBe(3)
  })

  it('agent 输出 handoff → 返回 false（交还用户）', async () => {
    const driver = makeFakeDriver()
    const agent = makeAgent(() => '{"type":"handoff"}')
    const channel = new CrawlAgentChannelImpl(driver, agent)

    await expect(channel.handleFetchFailure({ url: 'u', error: '验证码' })).resolves.toBe(false)
    expect(driver.actions).toHaveLength(0)
  })

  it('轮数耗尽 → 返回 false；动作执行失败 → 返回 false', async () => {
    const driver = makeFakeDriver()
    const agent = makeAgent(() => '{"type":"wait","ms":100}')
    const channel = new CrawlAgentChannelImpl(driver, agent, { maxRounds: 2 })
    await expect(channel.handleFetchFailure({ url: 'u', error: 'e' })).resolves.toBe(false)
    expect(driver.actions).toHaveLength(2) // 轮数上限内执行的动作

    const failingDriver = makeFakeDriver({ failAct: true })
    const channel2 = new CrawlAgentChannelImpl(failingDriver, makeAgent(() => '{"type":"click","selector":"#x"}'))
    await expect(channel2.handleFetchFailure({ url: 'u', error: 'e' })).resolves.toBe(false)
  })

  it('agent 未配置 → false（不创建会话不阻塞）', async () => {
    const driver = makeFakeDriver()
    const agent = makeAgent(() => '{"type":"retry"}', false)
    const channel = new CrawlAgentChannelImpl(driver, agent)
    await expect(channel.handleFetchFailure({ url: 'u', error: 'e' })).resolves.toBe(false)
    expect(driver.actions).toHaveLength(0)
  })

  it('快照失败（页面不可观察）→ false', async () => {
    const driver: CrawlDriver = {
      async navigate() {},
      async snapshot() {
        throw new Error('window gone')
      },
      async act() {},
      async loginStatus() {
        return 'logged-out'
      },
      async dispose() {}
    }
    const channel = new CrawlAgentChannelImpl(driver, makeAgent(() => '{"type":"retry"}'))
    await expect(channel.handleFetchFailure({ url: 'u', error: 'e' })).resolves.toBe(false)
  })

  it('轮数上限常量存在（防死循环护栏）', () => {
    expect(AGENT_CHANNEL_MAX_ROUNDS).toBeGreaterThan(0)
    expect(AGENT_CHANNEL_MAX_ROUNDS).toBeLessThanOrEqual(10)
  })
})
