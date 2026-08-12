import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentNotConfiguredError, AgentService, type AgentEvent, type AgentSettingsStore } from './agent'
import { PiAgentProvider } from './pi-agent-provider'

/**
 * 真实 pi SDK 手动冒烟（EF-04 AC-4）。默认跳过；显式运行：
 *
 *   AGENT_SMOKE=1 node scripts/test.mjs run src/main/services/agent.smoke.test.ts
 *
 * 认证来源（二选一）：
 *   - 环境变量：AGENT_SMOKE_API_KEY=sk-... AGENT_SMOKE_PROVIDER=deepseek AGENT_SMOKE_MODEL=deepseek-v4-flash
 *   - 未设置时复用本机 ~/.pi/agent/auth.json 中对应 provider 的 api_key
 *
 * 覆盖：未配置认证明确错误（AC-3 真实路径）→ configureProvider → 三种任务
 * 类型的真实会话（AC-2 真实事件流；learn 走内置 teach 技能 + 教学工作区）。
 */

const SMOKE_ENABLED = process.env['AGENT_SMOKE'] === '1'

/** 内存版 AgentSettingsStore（冒烟不依赖 SQLite）。 */
function makeSettingsStub(): AgentSettingsStore {
  const map = new Map<string, unknown>()
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value)
    }
  }
}

/** 冒烟用 API key：环境变量优先，否则读本机全局 auth.json。 */
function resolveApiKey(provider: string): string | undefined {
  const fromEnv = process.env['AGENT_SMOKE_API_KEY']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  try {
    const authPath = join(homedir(), '.pi', 'agent', 'auth.json')
    if (!existsSync(authPath)) return undefined
    const data = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, { type?: string; key?: string }>
    const credential = data[provider]
    return credential?.type === 'api_key' ? credential.key : undefined
  } catch {
    return undefined
  }
}

function makeSmokeService(dir: string) {
  const provider = new PiAgentProvider({
    dataDir: dir,
    teachSkillDir: join(process.cwd(), 'resources', 'teach'),
    settings: makeSettingsStub()
  })
  const deltas = new Map<string, string[]>()
  const service = new AgentService(provider, {
    onEvent: (sessionId, event) => {
      if (event.type === 'text_delta') {
        const list = deltas.get(sessionId) ?? []
        list.push(event.delta)
        deltas.set(sessionId, list)
      } else if (event.type === 'status') {
        console.log(`  [${sessionId}] status=${event.status}`)
      } else if (event.type === 'error') {
        console.log(`  [${sessionId}] error=${event.message}`)
      }
    }
  })
  return { service, deltas }
}

/** 等待会话产生首个活动（text_delta / tool_* / turn_end）或 error。 */
async function waitForFirstActivity(events: AgentEvent[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === 'text_delta' || e.type === 'tool_start' || e.type === 'error')) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`会话在 ${timeoutMs}ms 内无任何活动`)
}

describe.skipIf(!SMOKE_ENABLED)('AgentService 真实 SDK 冒烟（AGENT_SMOKE=1）', () => {
  it(
    '全流程：未配置错误 → configureProvider → optimize/interview/learn 三任务',
    { timeout: 300_000 },
    async () => {
      const providerId = process.env['AGENT_SMOKE_PROVIDER'] ?? 'deepseek'
      const modelId = process.env['AGENT_SMOKE_MODEL'] ?? 'deepseek-v4-flash'
      const apiKey = resolveApiKey(providerId)
      expect(apiKey, `未找到 ${providerId} 的 API key（AGENT_SMOKE_API_KEY 或 ~/.pi/agent/auth.json）`).toBeTruthy()

      const dir = mkdtempSync(join(tmpdir(), 'jobhunt-agent-smoke-'))
      try {
        const { service, deltas } = makeSmokeService(dir)

        // AC-3（真实路径）：未配置认证 → 明确错误
        expect(service.getStatus().configured).toBe(false)
        await expect(service.createSession('optimize')).rejects.toBeInstanceOf(AgentNotConfiguredError)

        // 配置认证（写应用自有 auth.json，不落 ~/.pi/agent）
        await service.configureProvider(providerId, apiKey as string, modelId)
        expect(service.getStatus()).toMatchObject({ configured: true, provider: providerId, model: modelId })

        // optimize：一次性会话
        console.log('[optimize]')
        const optimize = await service.createSession('optimize')
        const optimizeEvents: AgentEvent[] = []
        optimize.subscribe((event) => optimizeEvents.push(event))
        const reply = await optimize.prompt('只回复四个字：冒烟通过')
        expect(reply.length).toBeGreaterThan(0)
        expect((deltas.get(optimize.id) ?? []).join('')).toBe(reply)
        optimize.dispose()

        // interview：长驻会话
        console.log('[interview]')
        const interview = await service.createSession('interview')
        const interviewEvents: AgentEvent[] = []
        interview.subscribe((event) => interviewEvents.push(event))
        const answer = await interview.prompt('用一句话介绍你自己')
        expect(answer.length).toBeGreaterThan(0)
        interview.dispose()

        // learn：教学工作区 + 内置 teach 技能（首条提示自动 /skill:teach）。
        // teach 为多轮长任务（读格式文件/调研/写 MISSION 等），冒烟只要求真实活动（工具或流式文本）+ 无错误。
        console.log('[learn]')
        const workspace = join(dir, 'learn-workspace')
        const learn = await service.learnSession('什么是回调函数？', { cwd: workspace })
        const learnEvents: AgentEvent[] = []
        learn.subscribe((event) => learnEvents.push(event))
        await waitForFirstActivity(learnEvents, 120_000)
        expect(learnEvents.some((event) => event.type === 'error')).toBe(false)
        expect(
          learnEvents.some((event) => event.type === 'text_delta' || event.type === 'tool_start')
        ).toBe(true)
        learn.dispose()

        service.dispose()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
