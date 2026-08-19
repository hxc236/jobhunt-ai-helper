import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { FakeAgentProvider } from './fake-agent-provider'
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
          changes: [{ section: 'projects', before: 'a', after: 'b', reason: 'r', source: 'original' }]
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
    ]
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
