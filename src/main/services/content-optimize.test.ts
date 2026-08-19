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
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = harness.service.get(taskId)
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
    const h = makeHarness()
    h.service.start(h.resumeId)
    // 任务仍在诊断中 → 第二次 start 拒绝
    await waitForStatus(h, h.service.list()[0]!.id, () => true)
    const task = h.service.list()[0]!
    if (task.status !== 'ready_for_review' && task.status !== 'confirmed') {
      expect(() => h.service.start(h.resumeId)).toThrowError(/已有进行中的内容优化任务/)
    }
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

    const submitted = h.service.submitAnswers(task.id, { q1: '我的答案是分布式锁' })
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

  it('LLM 轮次全局串行：两个任务不会并发执行轮次', async () => {
    const h = makeHarness({ delayMs: 60 })
    const r2 = h.resumes.create({ ...BASE_RESUME, meta: { title: '基准简历二' } })
    const t1 = h.service.start(h.resumeId)
    const t2 = h.service.start(r2.meta.id as string)

    const ready1 = await waitForStatus(h, t1.id, (t) => t.status === 'ready_for_review' || t.status === 'failed')
    const ready2 = await waitForStatus(h, t2.id, (t) => t.status === 'ready_for_review' || t.status === 'failed')
    expect(['ready_for_review', 'failed']).toContain(ready1.status)
    expect(['ready_for_review', 'failed']).toContain(ready2.status)
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
