import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { FakeAgentProvider, FakeAgentSession } from './fake-agent-provider'
import { extractResumeFromPrompt } from './e2e-fake-agent'
import { AgentService } from './agent'
import { ResumeService } from './resume'
import {
  ContentOptimizeError,
  ContentOptimizeService,
  LlmRoundQueue
} from './content-optimize'
import type {
  ContentDiagnosis,
  ContentOptimizeTask,
  ContentQuestion
} from '../../shared/types'
import type { Resume } from '../../shared/types/resume'

const BASE_RESUME: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟', phone: '13800001234', email: 'z@example.com' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
  skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
  projects: [{ name: '二手交易平台', description: 'C2C 二手交易\nSpring Boot 实现', techStack: ['Java', 'Spring Boot'] }]
}

/** 空诊断（全部保持）回复。 */
const EMPTY_DIAGNOSIS_REPLY = JSON.stringify({
  rules: [],
  projects: [{ projectId: 'proj-1', verdict: 'keep' }],
  questions: []
})

interface Harness {
  db: ReturnType<typeof openDatabase>
  provider: FakeAgentProvider
  service: ContentOptimizeService
  resumes: ResumeService
  resumeId: string
  emitEvents: ContentOptimizeTask[]
  queue: LlmRoundQueue
}

/** 可轮询查询任务状态的最小接口（真实服务或重启后的服务实例均可用）。 */
type TaskQuery = Pick<ContentOptimizeService, 'get'>

/** 构造测试环境：内存库 + 脚本化 fake agent + 独立轮次队列。 */
function makeHarness(options: {
  /** 诊断轮回复（默认空诊断）；可传函数按提示词动态回复。 */
  diagnosis?: (prompt: string) => string | Promise<string>
  /** 改写轮回复。 */
  rewrite?: (prompt: string) => string
  /** 诊断轮抛错（模拟 LLM 失败）。 */
  failDiagnosis?: Error
  /** 单轮超时（ms）。 */
  roundTimeoutMs?: number
  /** 单轮重试次数。 */
  roundRetries?: number
  /** 是否注入延迟（模拟轮次进行中，供取消测试）。 */
  delayMs?: number
} = {}): Harness {
  const db = openDatabase(':memory:')
  const resumes = new ResumeService(db)
  const stored = resumes.create(BASE_RESUME)
  const emitEvents: ContentOptimizeTask[] = []
  const provider = new FakeAgentProvider({
    delayMs: options.delayMs ?? 0,
    onPrompt: async (prompt) => {
      if (options.failDiagnosis !== undefined) throw options.failDiagnosis
      if (prompt.includes('[内容优化 1/2')) {
        if (options.diagnosis !== undefined) return options.diagnosis(prompt)
        return EMPTY_DIAGNOSIS_REPLY
      }
      if (prompt.includes('[内容优化 2/2')) {
        if (options.rewrite !== undefined) return options.rewrite(prompt)
        return JSON.stringify({
          resume: BASE_RESUME,
          changes: [
            { section: 'projects', before: 'C2C 二手交易', after: 'C2C 二手交易（含高并发难点与解决行动）', reason: 'R1 补充难点与解决行动', source: 'user-answer' }
          ]
        })
      }
      return `echo: ${prompt}`
    }
  })
  const agent = new AgentService(provider)
  const queue = new LlmRoundQueue()
  const service = new ContentOptimizeService(db, resumes, agent, {
    emit: (task) => emitEvents.push(task),
    queue,
    ...(options.roundTimeoutMs !== undefined ? { roundTimeoutMs: options.roundTimeoutMs } : {}),
    ...(options.roundRetries !== undefined ? { roundRetries: options.roundRetries } : {})
  })
  return { db, provider, service, resumes, resumeId: stored.meta.id as string, emitEvents, queue }
}

/** 等待任务到达目标状态（轮次是异步的）。 */
async function waitForStatus(
  harness: Harness,
  taskId: string,
  predicate: (t: ContentOptimizeTask) => boolean,
  timeoutMs = 2000
): Promise<ContentOptimizeTask> {
  return waitForTaskStatus(harness.service, taskId, predicate, timeoutMs)
}

/** 等待任务到达目标状态（对任意任务查询接口轮询，供重启/恢复场景用）。 */
async function waitForTaskStatus(
  query: TaskQuery,
  taskId: string,
  predicate: (t: ContentOptimizeTask) => boolean,
  timeoutMs = 5000
): Promise<ContentOptimizeTask> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = query.get(taskId)
    if (task !== undefined && predicate(task)) return task
    if (Date.now() > deadline) throw new Error(`等待任务状态超时：${taskId}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function withQuestions(): ContentDiagnosis {
  return {
    rules: [],
    projects: [{ projectId: 'proj-1', verdict: 'needs-info' }],
    questions: [
      { projectId: 'proj-1', field: '难点', question: '项目最大的技术难点是什么？', evidence: '原文证据', candidates: ['分布式锁'] }
    ],
    promotions: []
  }
}

describe('ContentOptimizeService — 任务状态机与持久化（T02/#92）', () => {
  it('触发内容优化 → 空诊断（全部保持）→ ready_for_review 无需修改 → 确认不创建新版本', async () => {
    const h = makeHarness()
    const task = h.service.start(h.resumeId)
    expect(task.status).toBe('created')
    expect(h.emitEvents.some((t) => t.id === task.id && t.status === 'created')).toBe(true)

    const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    expect(ready.noChanges).toBe(true)
    expect(ready.progress).toBe('无需修改')

    const before = h.resumes.list().length
    const { task: confirmed, createdResumeId } = h.service.confirm(task.id)
    expect(confirmed.status).toBe('confirmed')
    expect(createdResumeId).toBeNull()
    expect(h.resumes.list().length).toBe(before) // 空诊断不创建新版本
  })

  it('同一基准同一时间仅一个进行中任务（AC：单基准单草稿）', async () => {
    const h = makeHarness({ delayMs: 120 })
    const first = h.service.start(h.resumeId)
    // 等任务离开 created（进入进行中轮次/等待状态），确保第二次 start 被真实拒绝而非空转
    await waitForStatus(h, first.id, (t) => t.status !== 'created')
    const current = h.service.get(first.id)!
    expect(['created', 'diagnosing', 'awaiting_answers', 'rewriting', 'ready_for_review']).toContain(
      current.status
    )
    expect(() => h.service.start(h.resumeId)).toThrowError(/已有进行中的内容优化任务/)
  })

  it('非基准简历（按 JD 优化稿）拒绝触发', async () => {
    const h = makeHarness()
    const derived = h.resumes.create({
      ...BASE_RESUME,
      meta: { title: '优化稿', baseResumeId: 'res-base', targetJobId: 'job-1' }
    })
    expect(() => h.service.start(derived.meta.id as string)).toThrowError(ContentOptimizeError)
    expect(() => h.service.start(derived.meta.id as string)).toThrowError(/仅支持基准简历/)
  })

  it('取消：轮次结束后停止，已得诊断保留；续接后回到取消前阶段', async () => {
    const h = makeHarness({ delayMs: 120 })
    const task = h.service.start(h.resumeId)
    // 诊断轮进行中 → 取消
    h.service.cancel(task.id)
    const cancelled = await waitForStatus(h, task.id, (t) => t.status === 'cancelled')
    expect(cancelled.status).toBe('cancelled')

    // 续接：回到 diagnosing 重新诊断 → 最终 ready_for_review
    const resumed = h.service.resume(task.id)
    expect(resumed.status).toBe('diagnosing')
    const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    expect(ready.noChanges).toBe(true)
  })

  it('追问阶段（awaiting_answers）取消 → 立即取消（resumeTo=awaiting_answers）；续接恢复且不入队轮次', async () => {
    const h = makeHarness({ diagnosis: () => JSON.stringify(withQuestions()) })
    const task = h.service.start(h.resumeId)
    const awaiting = await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
    expect(awaiting.diagnosis?.questions.length).toBe(1)

    // 非轮次阶段取消：立即取消，记录 resumeTo=awaiting_answers（可直接续接）
    const cancelled = h.service.cancel(task.id)
    expect(cancelled.status).toBe('cancelled')
    const row = h.db
      .prepare('SELECT resume_to FROM content_optimize_tasks WHERE id = ?')
      .get(task.id) as { resume_to: string | null }
    expect(row.resume_to).toBe('awaiting_answers')

    // 续接：恢复 awaiting_answers，诊断保留，不再入队 LLM 轮次
    const resumed = h.service.resume(task.id)
    expect(resumed.status).toBe('awaiting_answers')
    expect(resumed.diagnosis?.questions.length).toBe(1)
    const eventsAfterResume = h.emitEvents.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    const persisted = h.service.get(task.id)
    expect(persisted?.status).toBe('awaiting_answers') // 无轮次自动推进
    expect(h.emitEvents.length).toBe(eventsAfterResume) // 未入队轮次（无新状态事件）
  })

  it('诊断轮失败 → failed 保留状态 → 手动重试成功', async () => {
    let fail = true
    const h = makeHarness({
      roundRetries: 0,
      diagnosis: () => {
        if (fail) throw new Error('LLM 诊断超时')
        return EMPTY_DIAGNOSIS_REPLY
      }
    })
    const task = h.service.start(h.resumeId)
    const failed = await waitForStatus(h, task.id, (t) => t.status === 'failed')
    expect(failed.error).toContain('LLM 诊断超时')

    fail = false
    const retried = h.service.retry(task.id)
    expect(retried.status).toBe('diagnosing')
    const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    expect(ready.noChanges).toBe(true)
  })

  it('诊断轮超时（超时 + 重试仍失败）→ failed', async () => {
    const h = makeHarness({
      roundTimeoutMs: 30,
      roundRetries: 1,
      delayMs: 500 // 每轮都超时
    })
    const task = h.service.start(h.resumeId)
    const failed = await waitForStatus(h, task.id, (t) => t.status === 'failed')
    expect(failed.error).toContain('超时')
  })

  it('诊断含追问 → awaiting_answers → submitAnswers 提交回答 → 改写轮 → ready_for_review', async () => {
    const h = makeHarness({ diagnosis: () => JSON.stringify(withQuestions()) })
    const task = h.service.start(h.resumeId)
    const awaiting = await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
    expect(awaiting.diagnosis?.questions.length).toBe(1)
    expect(awaiting.progress).toContain('等待回答')

    const submitted = h.service.submitAnswers(task.id, { q0: '我的答案是分布式锁' })
    expect(submitted.status).toBe('rewriting')
    // 改写轮（T05 骨架）：fake 返回合法 resume → ready_for_review
    const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    expect(ready.rewrite).not.toBeNull()
    expect(ready.noChanges).toBe(false)
    // 有改写的确认：创建新的基准简历（#90-21）
    const before = h.resumes.list().length
    const { createdResumeId } = h.service.confirm(task.id)
    expect(createdResumeId).not.toBeNull()
    expect(h.resumes.list().length).toBe(before + 1)
  })

  describe('submitAnswers 追问回答校验（#94/T04）', () => {
    it('部分回答可提交（未答项允许缺失），哨兵值（不属实/无法补充）原样存入', async () => {
      const h = makeHarness({
        diagnosis: () =>
          JSON.stringify({
            rules: [],
            projects: [{ projectId: 'proj-1', verdict: 'needs-info' }],
            questions: [
              { id: 'q1', projectId: 'proj-1', field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: ['分布式锁'] },
              { id: 'q2', projectId: 'proj-1', field: '结果', question: '结果？', evidence: 'e', candidates: [] }
            ]
          })
      })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')

      // 只答 q1（确认候选），q2 标记无法补充；q1 未答项不提交
      const submitted = h.service.submitAnswers(task.id, {
        q1: '分布式锁',
        q2: '[无法补充]'
      })
      expect(submitted.status).toBe('rewriting')
      const persisted = h.service.get(task.id)
      expect(persisted?.answers).toEqual({ q1: '分布式锁', q2: '[无法补充]' })
      const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
      expect(ready.answers).toEqual({ q1: '分布式锁', q2: '[无法补充]' })
    })

    it('包含未知问题键 → 拒绝（invalid-answers），任务状态不变', async () => {
      const h = makeHarness({ diagnosis: () => JSON.stringify(withQuestions()) })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
      expect(() => h.service.submitAnswers(task.id, { nope: 'x' })).toThrowError(ContentOptimizeError)
      expect(() => h.service.submitAnswers(task.id, { nope: 'x' })).toThrowError(/未知问题/)
      expect(h.service.get(task.id)?.status).toBe('awaiting_answers')
    })

    it('空回答（未答全部）允许提交 → 进入改写轮', async () => {
      const h = makeHarness({ diagnosis: () => JSON.stringify(withQuestions()) })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
      const submitted = h.service.submitAnswers(task.id, {})
      expect(submitted.status).toBe('rewriting')
      const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
      expect(ready.answers).toEqual({})
    })

    it('空/纯空白回答值 → 拒绝（invalid-answers），任务状态不变；哨兵值仍允许', async () => {
      const h = makeHarness({
        diagnosis: () =>
          JSON.stringify({
            rules: [],
            projects: [{ projectId: 'proj-1', verdict: 'needs-info' }],
            questions: [
              { id: 'q1', projectId: 'proj-1', field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: [] },
              { id: 'q2', projectId: 'proj-1', field: '结果', question: '结果？', evidence: 'e', candidates: [] }
            ]
          })
      })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')

      expect(() => h.service.submitAnswers(task.id, { q1: '   ' })).toThrowError(ContentOptimizeError)
      expect(() => h.service.submitAnswers(task.id, { q1: '   ' })).toThrowError(/空回答/)
      expect(() => h.service.submitAnswers(task.id, { q1: '' })).toThrowError(/空回答/)
      expect(h.service.get(task.id)?.status).toBe('awaiting_answers')

      // 哨兵值（不属实/无法补充）是合法非空字符串，仍可通过
      const submitted = h.service.submitAnswers(task.id, { q1: '[不属实]', q2: '[无法补充]' })
      expect(submitted.status).toBe('rewriting')
      const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
      expect(ready.answers).toEqual({ q1: '[不属实]', q2: '[无法补充]' })
    })
  })

  describe('改写轮（T05/#95 逐项目改写与事实溯源）', () => {
    it('改写回复 before 未命中原文 → 任务 failed（bad-json 可重试）', async () => {
      const h = makeHarness({
        diagnosis: () => JSON.stringify(withQuestions()),
        rewrite: () =>
          JSON.stringify({
            resume: BASE_RESUME,
            changes: [{ section: 'highlights', before: '完全不存在的内容', after: 'x', reason: 'r', source: 'original' }]
          })
      })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
      h.service.submitAnswers(task.id, { q0: '分布式锁' })
      const failed = await waitForStatus(h, task.id, (t) => t.status === 'failed')
      expect(failed.error).toContain('before')
      // 已存状态保留：诊断仍在（可重试回改写阶段）
      expect(failed.diagnosis).not.toBeNull()
    })

    it('改写回复含哨兵冲突（使用了被标记不属实的候选）→ 任务 failed', async () => {
      const h = makeHarness({
        diagnosis: (prompt) => {
          const resume = extractResumeFromPrompt(prompt)
          const pid = resume?.projects?.[0]?.id ?? 'proj-1'
          return JSON.stringify({
            rules: [],
            projects: [{ projectId: pid, verdict: 'rewrite' }],
            questions: [{ id: 'q1', projectId: pid, field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: ['分布式锁保证一致性'] }]
          })
        },
        rewrite: (prompt) => {
          const resume = extractResumeFromPrompt(prompt)
          const pid = resume?.projects?.[0]?.id ?? 'proj-1'
          return JSON.stringify({
            // 原简历原样 + 被拒候选被新增 → 哨兵校验拒绝
            resume: {
              ...resume,
              projects: (resume?.projects ?? []).map((p, i) =>
                i === 0 ? { ...p, highlights: [...(p.highlights ?? []), '分布式锁保证一致性'] } : p
              )
            },
            changes: [{ projectId: pid, section: 'highlights', before: 'C2C 二手交易', after: 'C2C 二手交易（分布式锁保证一致性）', reason: 'R1', source: 'user-answer' }]
          })
        }
      })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
      h.service.submitAnswers(task.id, { q1: '[不属实]' })
      const failed = await waitForStatus(h, task.id, (t) => t.status === 'failed')
      expect(failed.error).toContain('不属实')
    })

    it('改写成功 → ready_for_review 且 rewrite 持久化（含事实溯源来源）', async () => {
      const h = makeHarness({
        diagnosis: (prompt) => {
          const resume = extractResumeFromPrompt(prompt)
          const pid = resume?.projects?.[0]?.id ?? 'proj-1'
          return JSON.stringify({
            rules: [],
            projects: [{ projectId: pid, verdict: 'rewrite' }],
            questions: [{ id: 'q1', projectId: pid, field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: ['高并发难点'] }]
          })
        },
        rewrite: (prompt) => {
          const resume = extractResumeFromPrompt(prompt)
          const pid = resume?.projects?.[0]?.id ?? 'proj-1'
          return JSON.stringify({
            resume,
            changes: [{ projectId: pid, section: 'highlights', before: 'C2C 二手交易', after: 'C2C 二手交易（含高并发难点与解决行动）', reason: 'R1', source: 'user-answer' }]
          })
        }
      })
      const task = h.service.start(h.resumeId)
      await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')
      h.service.submitAnswers(task.id, { q1: '高并发难点' })
      const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
      expect(ready.rewrite).not.toBeNull()
      expect(ready.rewrite?.changes[0]?.source).toBe('user-answer')
      expect(ready.noChanges).toBe(false)
      // 重启后可从 DB 读回 rewrite（中断续接不丢已存结果）
      const restored = new ContentOptimizeService(h.db, h.resumes, new AgentService(h.provider), {
        queue: h.queue
      })
      expect(restored.get(task.id)?.rewrite).not.toBeNull()
    })
  })

  it('任务记录持久化：诊断/回答/状态可查询（中断续接基础）', async () => {
    const h = makeHarness({ diagnosis: () => JSON.stringify(withQuestions()) })
    const task = h.service.start(h.resumeId)
    await waitForStatus(h, task.id, (t) => t.status === 'awaiting_answers')

    // 重新构造服务（模拟应用重启）：从 DB 恢复任务
    const agent2 = new AgentService(h.provider)
    const service2 = new ContentOptimizeService(h.db, h.resumes, agent2, {
      emit: () => undefined,
      queue: new LlmRoundQueue()
    })
    const restored = service2.get(task.id)
    expect(restored?.status).toBe('awaiting_answers')
    expect(restored?.diagnosis?.questions[0]?.question).toContain('技术难点')
  })

  it('作废：已取消任务 void 后释放单基准单草稿约束', async () => {
    const h = makeHarness({ delayMs: 200 })
    const task = h.service.start(h.resumeId)
    h.service.cancel(task.id)
    await waitForStatus(h, task.id, (t) => t.status === 'cancelled')
    h.service.voidTask(task.id)
    expect(h.service.get(task.id)).toBeUndefined()
    // 可以重新开始
    const again = h.service.start(h.resumeId)
    expect(again.status).toBe('created')
  })

  it('LLM 轮次全局串行：两个任务不会并发执行轮次（断言无重叠）', async () => {
    let active = 0
    let maxActive = 0
    const h = makeHarness({
      delayMs: 30,
      diagnosis: async () => {
        // 并发计数：轮次执行期间进入/离开；若队列未串行，maxActive 会超过 1
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 40))
        active--
        return EMPTY_DIAGNOSIS_REPLY
      }
    })
    const r2 = h.resumes.create({ ...BASE_RESUME, meta: { title: '基准简历二' } })
    const t1 = h.service.start(h.resumeId)
    const t2 = h.service.start(r2.meta.id as string)

    const ready1 = await waitForStatus(h, t1.id, (t) => t.status === 'ready_for_review' || t.status === 'failed')
    const ready2 = await waitForStatus(h, t2.id, (t) => t.status === 'ready_for_review' || t.status === 'failed')
    expect(['ready_for_review', 'failed']).toContain(ready1.status)
    expect(['ready_for_review', 'failed']).toContain(ready2.status)
    // 串行保证：两个诊断轮次绝不能同时执行
    expect(maxActive).toBe(1)
  })

  it('取消在轮次中且轮次失败 → 取消优先（cancelled 而非 failed），重试路径不被遗留取消标记劫持', async () => {
    // 诊断轮先延迟再抛错：确保 cancel 落在轮次进行中，随后轮次失败走 fail() 路径
    const h = makeHarness({
      diagnosis: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        throw new Error('LLM 断连')
      }
    })
    const task = h.service.start(h.resumeId)
    await waitForStatus(h, task.id, (t) => t.status === 'diagnosing')
    // 诊断轮进行中 → 取消
    h.service.cancel(task.id)
    const cancelled = await waitForStatus(h, task.id, (t) => t.status === 'cancelled' || t.status === 'failed')
    // 取消已置位时，轮次结束后取消优先 → cancelled
    expect(cancelled.status).toBe('cancelled')
    // 不再处于 failed，不会出现「点重试却变成取消」的尴尬路径
    expect(h.service.get(task.id)?.error).toBeNull()
  })

  it('取消在轮次中且轮次成功 → 已得结果保留，取消后任务为 cancelled 可续接', async () => {
    const h = makeHarness({ delayMs: 120 })
    const task = h.service.start(h.resumeId)
    h.service.cancel(task.id)
    const cancelled = await waitForStatus(h, task.id, (t) => t.status === 'cancelled')
    expect(cancelled.status).toBe('cancelled')
  })

  it('开始任务时自动补齐存量简历：项目 id/highlights/sectionOrder 落库且幂等', async () => {
    const h = makeHarness()
    // 另一份未补齐形状的存量简历（无项目 id/highlights/sectionOrder）
    const legacy = h.resumes.create({ ...BASE_RESUME, meta: { title: '存量简历' } })
    const task = h.service.start(legacy.meta.id as string)
    await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')

    const stored = h.resumes.get(legacy.meta.id as string)!
    expect(stored.projects?.[0]?.id).toBeTruthy() // 稳定 ID 已生成
    expect(stored.projects?.[0]?.highlights?.length).toBeGreaterThan(0) // description 迁移为要点
    expect(stored.sectionOrder).toBeDefined() // 模块顺序已推断

    // 幂等：确认后再次触发不重复补齐（无缺失字段 → changed=false 不落库）
    h.service.confirm(task.id) // 空诊断路径：确认不创建新版本
    const second = h.service.start(legacy.meta.id as string)
    await waitForStatus(h, second.id, (t) => t.status === 'ready_for_review')
    const again = h.resumes.get(legacy.meta.id as string)!
    expect(again.projects?.[0]?.id).toBe(stored.projects?.[0]?.id)
  })

  it('启动恢复：轮次阶段任务（应用被杀中断）重新入队执行，非轮次阶段不动', async () => {
    const h = makeHarness({ delayMs: 60 })
    const task = h.service.start(h.resumeId)
    // 等任务进入 diagnosing 轮次（应用被杀时停留在该阶段）
    await waitForStatus(h, task.id, (t) => t.status === 'diagnosing')

    // 模拟应用重启：新服务实例 + 新队列（无进行中轮次），DB 保留 diagnosing 任务
    const service2 = new ContentOptimizeService(h.db, h.resumes, new AgentService(h.provider), {
      emit: () => undefined,
      queue: new LlmRoundQueue()
    })
    expect(service2.get(task.id)?.status).toBe('diagnosing')

    // 非轮次阶段的任务（如 confirmed）不应被重复驱动
    service2.recoverInFlight()
    // 轮次阶段任务被重新驱动 → 到达 ready_for_review
    const recovered = await waitForTaskStatus(service2, task.id, (t) => t.status === 'ready_for_review')
    expect(recovered.noChanges).toBe(true)
  })

  it('空诊断 E2E 路径的回复解析：全部保持 → 无需修改', async () => {
    const h = makeHarness()
    const task = h.service.start(h.resumeId)
    const ready = await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    expect(ready.diagnosis?.projects).toEqual([{ projectId: 'proj-1', verdict: 'keep' }])
    expect(ready.noChanges).toBe(true)
  })
})

describe('确认、对比与整合（T06/#96）', () => {
  /** 改写回复：p1 增加一条 highlights（source=inferred 推断-待确认）。 */
  function inferredRewriteReply(prompt: string): string {
    const resume = extractResumeFromPrompt(prompt)
    const pid = resume?.projects?.[0]?.id ?? 'proj-1'
    return JSON.stringify({
      resume: {
        ...resume,
        projects: (resume?.projects ?? []).map((p, i) =>
          i === 0 ? { ...p, highlights: ['高并发秒杀压测优化'] } : p
        )
      },
      changes: [
        {
          projectId: pid,
          section: 'highlights',
          before: '',
          after: '高并发秒杀压测优化',
          reason: 'R1 新增难点',
          source: 'inferred'
        }
      ]
    })
  }

  async function runToReview(h: Harness): Promise<string> {
    const task = h.service.start(h.resumeId)
    await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    return task.id
  }

  it('改写轮解析后为每条改动分配稳定 id（推断-待确认勾选引用）', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    const ready = h.service.get(taskId)!
    expect(ready.rewrite?.changes[0]?.id).toBe('chg-0')
    expect(ready.rewrite?.changes[0]?.source).toBe('inferred')
    expect(ready.rewrite?.changes[0]?.reason).toContain('待确认')
  })

  it('setReview：保存按项目决策 + 推断勾选并持久化（重启后仍可读回）', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!

    const updated = h.service.setReview(taskId, {
      decisions: { [pid]: 'reject' },
      inferredConfirmed: ['chg-0']
    })
    expect(updated.decisions?.[pid]).toBe('reject')
    expect(updated.inferredConfirmed).toEqual(['chg-0'])

    // 重启后从 DB 读回（中断续接不丢确认决策）
    const service2 = new ContentOptimizeService(h.db, h.resumes, new AgentService(h.provider), {
      emit: () => undefined,
      queue: new LlmRoundQueue()
    })
    const restored = service2.get(taskId)!
    expect(restored.decisions?.[pid]).toBe('reject')
    expect(restored.inferredConfirmed).toEqual(['chg-0'])
  })

  it('setReview 校验：非可确认状态/未知项目/非法决策值/未知改动 id 均拒绝', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!

    // 非 ready_for_review 状态拒绝
    const h2 = makeHarness({ diagnosis: () => JSON.stringify(withQuestions()) })
    const t2 = h2.service.start(h2.resumeId)
    await waitForStatus(h2, t2.id, (t) => t.status === 'awaiting_answers')
    expect(() => h2.service.setReview(t2.id, { decisions: {}, inferredConfirmed: [] })).toThrowError(
      ContentOptimizeError
    )
    expect(() => h2.service.setReview(t2.id, { decisions: {}, inferredConfirmed: [] })).toThrowError(
      /不可设置确认决策/
    )

    // 未知项目 / 非法决策值 / 未知改动 id
    expect(() => h.service.setReview(taskId, { decisions: { nope: 'accept' }, inferredConfirmed: [] })).toThrowError(
      /未知项目/
    )
    expect(() =>
      h.service.setReview(taskId, { decisions: { [pid]: 'maybe' as never }, inferredConfirmed: [] })
    ).toThrowError(/非法决策值/)
    expect(() =>
      h.service.setReview(taskId, { decisions: {}, inferredConfirmed: ['chg-99'] })
    ).toThrowError(/未知改动 id/)
  })

  it('US17 门禁：inferred 改动未勾选 → confirm 拒绝（inferred-pending）且状态不变；勾选后确认成功', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!

    // 未勾选 → 拒绝，任务仍可确认态
    expect(() => h.service.confirm(taskId)).toThrowError(ContentOptimizeError)
    expect(() => h.service.confirm(taskId)).toThrowError(/inferred-pending|推断-待确认/)
    expect(h.service.get(taskId)?.status).toBe('ready_for_review')

    // 勾选后 → 确认成功，创建新版本
    h.service.setReview(taskId, { decisions: {}, inferredConfirmed: ['chg-0'] })
    const before = h.resumes.list().length
    const { createdResumeId } = h.service.confirm(taskId)
    expect(createdResumeId).not.toBeNull()
    expect(h.resumes.list().length).toBe(before + 1)
    const confirmed = h.service.get(taskId)!
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.summary).not.toBeNull()
    expect(confirmed.summary?.unresolvedProjects).toEqual([])
    void pid
  })

  it('改写被拒 → 该项目保留原文，最终版标记「仍有未解决项目」（US19）；其他修改照常生效', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: (prompt) => {
        const resume = extractResumeFromPrompt(prompt)
        const pid = resume?.projects?.[0]?.id ?? 'proj-1'
        return JSON.stringify({
          resume: {
            ...resume,
            // 改写稿还带一个非项目改动（实习经历新增，R3），用于验证「其他修改照常生效」
            experience: [
              ...(resume?.experience ?? []),
              { company: '某公司', title: '实习生', highlights: ['完成订单模块'] }
            ],
            projects: (resume?.projects ?? []).map((p, i) =>
              i === 0 ? { ...p, description: 'C2C 二手交易（含高并发难点与解决行动）' } : p
            )
          },
          changes: [
            {
              projectId: pid,
              section: 'projects',
              before: 'C2C 二手交易',
              after: 'C2C 二手交易（含高并发难点与解决行动）',
              reason: 'R1 补充难点与解决行动',
              source: 'user-answer'
            }
          ]
        })
      }
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!
    h.service.setReview(taskId, { decisions: { [pid]: 'reject' }, inferredConfirmed: [] })

    const before = h.resumes.list().length
    const { createdResumeId } = h.service.confirm(taskId)
    const confirmed = h.service.get(taskId)!
    expect(confirmed.summary?.unresolvedProjects).toEqual([pid])
    expect(confirmed.summary?.keptWithWarning).toEqual([])
    // 其他（非项目）修改照常生效 → 创建新版本，且版本中 p1 为原文
    expect(createdResumeId).not.toBeNull()
    expect(h.resumes.list().length).toBe(before + 1)
    const createdResume = h.resumes.list().find((r) => r.meta.id === createdResumeId)!
    expect(createdResume.experience?.length).toBe(1) // 实习经历照常进入最终版
    const p1 = createdResume.projects?.find((p) => p.id === pid)
    expect(p1?.description).toContain('C2C 二手交易')
    expect(p1?.description).not.toContain('含高并发难点') // 原文保留
  })

  it('删除建议：确认删除 → 项目不进最终稿；拒绝 → 保留原文 + 警告', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: (prompt) => {
        const resume = extractResumeFromPrompt(prompt)
        const pid = resume?.projects?.[0]?.id ?? 'proj-1'
        return JSON.stringify({
          resume: {
            ...resume,
            projects: (resume?.projects ?? []).filter((p) => p.id !== pid)
          },
          changes: [
            {
              projectId: pid,
              section: 'projects',
              before: 'C2C 二手交易',
              after: '（建议删除）',
              reason: '无可补充的难点/结果，建议删除',
              source: 'original'
            }
          ]
        })
      }
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!

    // 拒绝删除 → 保留原文 + 警告（最终稿与原文一致 → 不建版本）
    h.service.setReview(taskId, { decisions: { [pid]: 'reject' }, inferredConfirmed: [] })
    const before = h.resumes.list().length
    const kept = h.service.confirm(taskId)
    expect(kept.createdResumeId).toBeNull()
    expect(h.service.get(taskId)?.summary?.keptWithWarning).toEqual([pid])
    expect(h.resumes.list().length).toBe(before) // 无实际改动不建版本（US20）

    // 确认删除 → 项目移除 → 创建新版本
    const h2 = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: (prompt) => {
        const resume = extractResumeFromPrompt(prompt)
        const pid = resume?.projects?.[0]?.id ?? 'proj-1'
        return JSON.stringify({
          resume: {
            ...resume,
            projects: (resume?.projects ?? []).filter((p) => p.id !== pid)
          },
          changes: [
            {
              projectId: pid,
              section: 'projects',
              before: 'C2C 二手交易',
              after: '（建议删除）',
              reason: '无可补充的难点/结果，建议删除',
              source: 'original'
            }
          ]
        })
      }
    })
    const taskId2 = await runToReview(h2)
    const pid2 = h2.service.get(taskId2)!.rewrite!.changes[0]!.projectId!
    h2.service.setReview(taskId2, { decisions: { [pid2]: 'accept' }, inferredConfirmed: [] })
    const before2 = h2.resumes.list().length
    const deleted = h2.service.confirm(taskId2)
    expect(deleted.createdResumeId).not.toBeNull()
    expect(h2.service.get(taskId2)?.summary?.deletedProjects).toEqual([pid2])
    expect(h2.resumes.list().length).toBe(before2 + 1)
    const createdResume = h2.resumes.list().find((r) => r.meta.id === deleted.createdResumeId)!
    expect(createdResume.projects?.some((p) => p.id === pid2)).toBe(false)
  })

  it('全部拒绝（无实际改动）→ 不创建新版本，进度标记「未应用改动」（US20）', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!
    h.service.setReview(taskId, { decisions: { [pid]: 'reject' }, inferredConfirmed: [] })

    const before = h.resumes.list().length
    const { createdResumeId } = h.service.confirm(taskId)
    expect(createdResumeId).toBeNull()
    expect(h.resumes.list().length).toBe(before)
    const confirmed = h.service.get(taskId)!
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.progress).toContain('未应用改动')
    expect(confirmed.summary?.unresolvedProjects).toEqual([pid])
  })
})

describe('确认入库与血缘（T07/#97）', () => {
  /** 改写回复：p1 增加一条 highlights（source=inferred 推断-待确认）。 */
  function inferredRewriteReply(prompt: string): string {
    const resume = extractResumeFromPrompt(prompt)
    const pid = resume?.projects?.[0]?.id ?? 'proj-1'
    return JSON.stringify({
      resume: {
        ...resume,
        projects: (resume?.projects ?? []).map((p, i) =>
          i === 0 ? { ...p, highlights: ['高并发秒杀压测优化'] } : p
        )
      },
      changes: [
        {
          projectId: pid,
          section: 'highlights',
          before: '',
          after: '高并发秒杀压测优化',
          reason: 'R1 新增难点',
          source: 'inferred'
        }
      ]
    })
  }

  async function runToReview(h: Harness): Promise<string> {
    const task = h.service.start(h.resumeId)
    await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    return task.id
  }

  it('确认（改写路径）：血缘 createdResumeId + archivedAt 持久化，新基准 baseResumeId=null，重启可读回', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    h.service.setReview(taskId, { decisions: {}, inferredConfirmed: ['chg-0'] })

    const { createdResumeId } = h.service.confirm(taskId)
    expect(createdResumeId).not.toBeNull()
    const confirmed = h.service.get(taskId)!
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.createdResumeId).toBe(createdResumeId)
    expect(confirmed.archivedAt).not.toBeNull()

    // 血缘不进简历 JSON：新基准是 baseResumeId=null 的普通基准（AC1/AC5）
    const createdResume = h.resumes.list().find((r) => r.meta.id === createdResumeId)!
    expect(createdResume.meta.baseResumeId).toBeNull()
    expect(createdResume.meta.targetJobId).toBeNull()
    expect(createdResume.meta).not.toHaveProperty('contentOptimizeTaskId')

    // 重启后从 DB 读回（血缘随任务持久化，AC2）
    const service2 = new ContentOptimizeService(h.db, h.resumes, new AgentService(h.provider), {
      emit: () => undefined,
      queue: new LlmRoundQueue()
    })
    const restored = service2.get(taskId)!
    expect(restored.createdResumeId).toBe(createdResumeId)
    expect(restored.archivedAt).not.toBeNull()
  })

  it('确认（noChanges 空诊断路径）：归档但不创建新版本，createdResumeId=null', async () => {
    const h = makeHarness() // 默认空诊断（全部保持）
    const task = h.service.start(h.resumeId)
    await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    const before = h.resumes.list().length

    const { createdResumeId } = h.service.confirm(task.id)
    expect(createdResumeId).toBeNull()
    expect(h.resumes.list().length).toBe(before)
    const confirmed = h.service.get(task.id)!
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.archivedAt).not.toBeNull()
    expect(confirmed.createdResumeId).toBeNull()
  })

  it('确认（全部拒绝/无实际改动路径）：归档但不创建新版本，createdResumeId=null', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    const pid = h.service.get(taskId)!.rewrite!.changes[0]!.projectId!
    h.service.setReview(taskId, { decisions: { [pid]: 'reject' }, inferredConfirmed: [] })

    const before = h.resumes.list().length
    const { createdResumeId } = h.service.confirm(taskId)
    expect(createdResumeId).toBeNull()
    expect(h.resumes.list().length).toBe(before)
    const confirmed = h.service.get(taskId)!
    expect(confirmed.archivedAt).not.toBeNull()
    expect(confirmed.createdResumeId).toBeNull()
  })

  it('hasCompletedContentOptimization：确认前 false；两种确认路径后均 true；未知简历 false', async () => {
    const h = makeHarness()
    expect(h.service.hasCompletedContentOptimization(h.resumeId)).toBe(false)
    expect(h.service.hasCompletedContentOptimization('res-missing')).toBe(false)

    // noChanges 路径
    const task = h.service.start(h.resumeId)
    await waitForStatus(h, task.id, (t) => t.status === 'ready_for_review')
    h.service.confirm(task.id)
    expect(h.service.hasCompletedContentOptimization(h.resumeId)).toBe(true)

    // 改写路径
    const h2 = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h2)
    h2.service.setReview(taskId, { decisions: {}, inferredConfirmed: ['chg-0'] })
    const { createdResumeId } = h2.service.confirm(taskId)
    expect(h2.service.hasCompletedContentOptimization(h2.resumeId)).toBe(true)
    // 新基准本身尚未做内容优化 → false（AC4 语义：新基准未优化过）
    expect(h2.service.hasCompletedContentOptimization(createdResumeId!)).toBe(false)
  })

  it('内容优化生成的新基准可再次作为内容优化输入（baseResumeId=null，单基准单草稿约束收尾）', async () => {
    const h = makeHarness({
      diagnosis: () =>
        JSON.stringify({
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: []
        }),
      rewrite: inferredRewriteReply
    })
    const taskId = await runToReview(h)
    h.service.setReview(taskId, { decisions: {}, inferredConfirmed: ['chg-0'] })
    const { createdResumeId } = h.service.confirm(taskId)

    // 新基准可再开内容优化任务（不抛 not-base-resume / active-task-exists）
    const task2 = h.service.start(createdResumeId!)
    expect(task2.status).toBe('created')
    // 旧基准也可以再开新任务（已归档不阻塞）
    const task3 = h.service.start(h.resumeId)
    expect(task3.status).toBe('created')
  })
})

describe('LLM 轮次超时重试（#100 bug 回归）', () => {
  /**
   * #100：超时后不得在同一个 session 上重试。
   * 复现用户症状：真实 pi SDK 中 `session.prompt()` 未结束时 isStreaming=true，
   * 再次调用同一 session 的 prompt 抛
   * 「Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.」
   * 这里用挂起的首次调用 + 同 session 第二次调用抛 SDK 错误来模拟。
   */
  it('超时重试切换到新 session，不再触发 SDK already-processing（修复前 failed，修复后正常完成）', async () => {
    const h = makeHarness({ roundTimeoutMs: 80, roundRetries: 1 })

    // 包装 createSession：捕获所有会话引用（dispose 会把自己从 provider.sessions
    // 移除，不能依赖该数组），并同步注入故障——第一个会话的 prompt 模拟 pi SDK 语义：
    // 第一次调用挂起（长思考，永不 resolve → withTimeout 超时）；
    // 同 session 第二次调用抛 SDK「Agent is already processing」。
    // （注：必须在 createSession 内注入，避免与轮次执行的竞态——fake 无延迟时
    //   诊断轮可能在等待循环的第一次 await 前就跑完。）
    const origCreate = h.provider.createSession.bind(h.provider)
    const created: FakeAgentSession[] = []
    let faultInjected = false
    h.provider.createSession = async (task, options) => {
      const s = (await origCreate(task, options)) as FakeAgentSession
      created.push(s)
      if (!faultInjected) {
        faultInjected = true
        let firstCall = true
        ;(s as unknown as { prompt: (text: string) => Promise<string> }).prompt = async () => {
          if (firstCall) {
            firstCall = false
            // 永不 resolve：模拟单轮 LLM 处理超过超时阈值的场景
            return new Promise<string>(() => {})
          }
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
          )
        }
      }
      return s
    }

    const task = h.service.start(h.resumeId)
    const done = await waitForStatus(
      h,
      task.id,
      (t) => t.status === 'ready_for_review' || t.status === 'failed',
      3000
    )
    // 修复后：重试在新建 session 上执行 → 空诊断 → ready_for_review（无需修改）
    expect(done.status).toBe('ready_for_review')
    expect(done.error).toBeNull()
    // 重试确实新建了 session（不复用同一 session）
    expect(created.length).toBeGreaterThanOrEqual(2)
  })

  it('超时重试仍遵守语义：重试也用尽后任务 failed 且保留错误（非 SDK already-processing 竞态）', async () => {
    // 所有 session 都挂起（永不 resolve）→ 超时重试 1 次后仍失败 → failed
    const h = makeHarness({ roundTimeoutMs: 60, roundRetries: 1 })
    const provider = h.provider
    const origCreate = provider.createSession.bind(provider)
    const created: FakeAgentSession[] = []
    provider.createSession = async (task, options) => {
      const s = (await origCreate(task, options)) as FakeAgentSession
      created.push(s)
      ;(s as unknown as { prompt: (text: string) => Promise<string> }).prompt = () =>
        new Promise<string>(() => {})
      return s
    }
    const task = h.service.start(h.resumeId)
    const done = await waitForStatus(h, task.id, (t) => t.status === 'failed', 3000)
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/超时/) // 超时语义保持（60s/1 重试）
    expect(done.error).not.toMatch(/already processing/)
    expect(created.length).toBeGreaterThanOrEqual(2) // 重试确实换了 session
  })
})
describe('ContentQuestion 类型约束', () => {
  it('question 结构：projectId/field/question/evidence/candidates', () => {
    const q: ContentQuestion = {
      projectId: 'proj-1',
      field: '难点',
      question: '最大难点？',
      evidence: '原文',
      candidates: ['分布式锁']
    }
    expect(q.field).toBe('难点')
    expect(q.candidates.length).toBe(1)
  })
})

describe('大赛提升为项目（T08/#98）', () => {
  /** 带大赛荣誉的简历（h1=大赛；h2=普通荣誉）。 */
  function baseWithHonors(): Resume {
    return {
      ...BASE_RESUME,
      honors: ['全国大学生数学建模竞赛省一等奖', '校三好学生']
    }
  }

  /** 诊断回复：返回大赛提升建议（第 1 轮）。 */
  const PROMOTION_DIAGNOSIS = (prompt: string): string => {
    const resume = extractResumeFromPrompt(prompt)
    const projects = (resume?.projects ?? []).map((p) => ({ projectId: p.id ?? '', verdict: 'keep' as const }))
    return JSON.stringify({
      rules: [],
      projects,
      questions: [],
      promotions: [
        { id: 'promo-0', honorIndex: 0, honorName: '全国大学生数学建模竞赛省一等奖', evidence: '原文：竞赛省一等奖', missingFields: ['startDate', 'techStack', 'description'] }
      ]
    })
  }

  it('诊断含提升建议 → awaiting_answers（等待回答含提升计数）', async () => {
    const harness = makeHarness({ diagnosis: PROMOTION_DIAGNOSIS })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')
    expect(task.diagnosis?.promotions).toHaveLength(1)
    expect(task.progress).toContain('大赛提升建议')
  })

  it('confirmPromotion：honors 移除大赛 → projects 追加新项目（字段来自回答），随后重新诊断', async () => {
    const harness = makeHarness({ diagnosis: PROMOTION_DIAGNOSIS })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')
    const promotionId = task.diagnosis!.promotions[0]!.id

    const next = harness.service.confirmPromotion(task.id, promotionId, {
      'promotion-promo-0-startDate': '2023-04',
      'promotion-promo-0-techStack': 'Python、Pandas',
      'promotion-promo-0-description': '为高校数学建模竞赛优化求解方案'
    })
    // 状态回到 diagnosing（重新诊断轮已入队）
    expect(next.status).toBe('diagnosing')
    expect(next.progress).toContain('重新诊断')
    // 提升回答并入任务 answers
    expect(next.answers?.['promotion-promo-0-startDate']).toBe('2023-04')
    // 简历已更新：honors 移除大赛；projects 追加提升项目
    const updated = harness.resumes.get(harness.resumeId)!
    expect(updated.honors).toEqual(['校三好学生'])
    const promoted = updated.projects?.find((p) => p.name === '全国大学生数学建模竞赛省一等奖')
    expect(promoted).toBeDefined()
    expect(promoted!.id).toBeDefined()
    expect(promoted!.startDate).toBe('2023-04')
    expect(promoted!.techStack).toEqual(['Python', 'Pandas'])
    expect(promoted!.description).toBe('为高校数学建模竞赛优化求解方案')
    // 原项目保留
    expect(updated.projects).toHaveLength(2)
  })

  it('confirmPromotion 哨兵（不属实/无法补充）不写入项目字段；未答字段缺失', async () => {
    const harness = makeHarness({ diagnosis: PROMOTION_DIAGNOSIS })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')
    harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, {
      'promotion-promo-0-startDate': '[不属实]',
      'promotion-promo-0-description': '[无法补充]'
    })
    const updated = harness.resumes.get(harness.resumeId)!
    const promoted = updated.projects?.find((p) => p.name === '全国大学生数学建模竞赛省一等奖')
    expect(promoted!.startDate).toBeUndefined()
    expect(promoted!.description).toBeUndefined()
    expect(promoted!.techStack).toBeUndefined()
  })

  it('confirmPromotion 校验：非 awaiting_answers / 未知建议 / 未知回答键 / 空回答值 / 下标越界', async () => {
    const harness = makeHarness({ diagnosis: PROMOTION_DIAGNOSIS })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')

    // 未知回答键
    expect(() =>
      harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, { 'promotion-promo-0-nope': 'x' })
    ).toThrowError(ContentOptimizeError)
    // 空回答值
    expect(() =>
      harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, { 'promotion-promo-0-startDate': '  ' })
    ).toThrowError(ContentOptimizeError)
    // 未知提升建议
    expect(() => harness.service.confirmPromotion(task.id, 'promo-missing', {})).toThrowError(ContentOptimizeError)

    // 错误状态：提交回答后（rewriting 由改写轮接管前）再确认提升 → 拒绝
    await harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, {})
    expect(() =>
      harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, {})
    ).toThrowError(ContentOptimizeError)
  })

  it('#98 review：honorName 与实际荣誉不符（诊断后简历被改）→ 拒绝提升（invalid-promotion）', async () => {
    const harness = makeHarness({ diagnosis: PROMOTION_DIAGNOSIS })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')

    // 诊断后用户改了荣誉文本（下标仍为 0，但名称不再是大赛）
    harness.resumes.update(harness.resumeId, { ...baseWithHonors(), honors: ['优秀志愿者', '校三好学生'] })
    expect(() =>
      harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, {
        'promotion-promo-0-startDate': '2023-04'
      })
    ).toThrowError(/荣誉名称与提升建议不符/)
    // 简历未被改动
    expect(harness.resumes.get(harness.resumeId)!.projects).toHaveLength(1)
    expect(harness.resumes.get(harness.resumeId)!.honors).toEqual(['优秀志愿者', '校三好学生'])
  })

  it('#98 review：honorName 宽松匹配（标点/空白差异）不误拒', async () => {
    const harness = makeHarness({ diagnosis: PROMOTION_DIAGNOSIS })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')

    // 荣誉原文带标点/全角空格，与建议名有差异但宽松等价
    harness.resumes.update(harness.resumeId, {
      ...baseWithHonors(),
      honors: ['全国大学生数学建模竞赛省一等奖（2023）', '校三好学生']
    })
    // 建议名与原文不完全一致（不同文本）→ 仍拒绝，保证匹配是有意义的
    expect(() =>
      harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, {})
    ).toThrowError(/荣誉名称与提升建议不符/)
  })

  it('AC3：提升后的项目参与规则诊断与改写（重新诊断产出该项目规则 → 改写轮引用）', async () => {
    let diagnosisRound = 0
    const harness = makeHarness({
      diagnosis: (prompt: string) => {
        diagnosisRound += 1
        const resume = extractResumeFromPrompt(prompt)
        const projects = (resume?.projects ?? []).map((p) => ({ projectId: p.id ?? '', verdict: 'keep' as const }))
        if (diagnosisRound === 1) {
          return JSON.stringify({
            rules: [],
            projects,
            questions: [],
            promotions: [
              { id: 'promo-0', honorIndex: 0, honorName: '全国大学生数学建模竞赛省一等奖', evidence: '原文：竞赛省一等奖', missingFields: ['description'] }
            ]
          })
        }
        // 第 2 轮：提升项目已入库（projects 含提升项），按项目规则判定 rewrite
        const promotedId = resume?.projects?.find((p) => p.name === '全国大学生数学建模竞赛省一等奖')?.id
        expect(promotedId).toBeDefined()
        return JSON.stringify({
          rules: [
            { ruleId: 'R1', target: `project:${promotedId}`, status: 'improve', evidence: '原文：竞赛省一等奖', issue: '缺难点与解决行动', suggestion: '补充解决行动', factSource: 'original' }
          ],
          projects: [
            ...projects,
            { projectId: promotedId, verdict: 'rewrite' }
          ],
          questions: [],
          promotions: []
        })
      },
      rewrite: (prompt: string) => {
        const resume = extractResumeFromPrompt(prompt)
        const promotedId = resume?.projects?.find((p) => p.name === '全国大学生数学建模竞赛省一等奖')?.id ?? ''
        const rewritten = {
          ...resume,
          projects: (resume?.projects ?? []).map((p) =>
            p.name === '全国大学生数学建模竞赛省一等奖'
              ? { ...p, highlights: ['参赛并获省一等奖', '优化求解方案提升效率'] }
              : p
          )
        }
        return JSON.stringify({
          resume: rewritten,
          changes: [
            {
              projectId: promotedId,
              section: 'highlights',
              before: '全国大学生数学建模竞赛省一等奖',
              after: '参赛并获省一等奖；优化求解方案提升效率',
              reason: 'R1 补充解决行动',
              source: 'original'
            }
          ]
        })
      }
    })
    harness.resumes.update(harness.resumeId, baseWithHonors())
    const created = harness.service.start(harness.resumeId)
    const task = await waitForStatus(harness, created.id, (t) => t.status === 'awaiting_answers')
    await harness.service.confirmPromotion(task.id, task.diagnosis!.promotions[0]!.id, {
      'promotion-promo-0-description': '为高校数学建模竞赛优化求解方案'
    })
    // 重新诊断产出提升项目规则 → rewrite → 改写轮 → ready_for_review
    const reviewed = await waitForStatus(harness, created.id, (t) => t.status === 'ready_for_review')
    const promotedId = reviewed.rewrite?.resume.projects?.find(
      (p) => p.name === '全国大学生数学建模竞赛省一等奖'
    )?.id
    expect(promotedId).toBeDefined()
    expect(reviewed.rewrite?.changes.some((c) => c.projectId === promotedId && c.section === 'highlights')).toBe(true)
  })
})
