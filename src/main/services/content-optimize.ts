import { randomUUID } from 'node:crypto'
import type { Db } from '../db/migrations'
import type { AgentService } from './agent'
import type { ResumeService } from './resume'
import type {
  ContentDiagnosis,
  ContentOptimizeStatus,
  ContentOptimizeTask,
  ContentRewrite
} from '../../shared/types'
import type { Resume } from '../../shared/types/resume'
import { extractJson } from './optimize'
import { assertValidResume } from './resume-schema'

/**
 * ContentOptimizeService（#90 业务① / T02）：简历内容优化异步任务骨架。
 *
 * 状态机（决策编码自 #90 设计会话）：
 *   created → diagnosing → awaiting_answers → rewriting → ready_for_review → confirmed
 *   failed：可手动重试回对应阶段（resume_to 记录失败时所在阶段）；
 *   cancelled：可续接（resume_to 记录取消前阶段）或作废（void）。
 *
 * 约定：
 * - 每份基准简历同一时间仅一个进行中任务（单基准单草稿约束，服务层拒绝重复 start）；
 * - LLM 轮次经全局串行队列（同一时间只跑一个轮次，跨任务排队）；
 * - 每轮超时 60s、重试 1 次，仍失败 → failed（保留已存状态，可手动重试）；
 * - 取消 = 当前 LLM 轮结束后停止（round 完成后检查取消标记），已得结果保留；
 * - 任务记录（诊断/追问/回答/确认）存 content_optimize_tasks 表，支持中断续接；
 * - 每轮新建 inMemory 会话（ADR-0002 会话策略，上下文全部文本注入，不维护跨轮会话）。
 *
 * T02 垂直切片：空诊断（全部「保持」→ 无需修改 → 不创建新版本）打通全链路。
 * 规则诊断引擎（R1–R4）由 T03 填充；改写轮由 T05 填充；本卡实现状态机 + 轮次骨架。
 */

/** 阶段进度文案。 */
export const CONTENT_PHASE_LABELS: Record<ContentOptimizeStatus, string> = {
  created: '已创建',
  diagnosing: '诊断中',
  awaiting_answers: '等待回答',
  rewriting: '改写中',
  ready_for_review: '可确认',
  confirmed: '已确认',
  failed: '失败',
  cancelled: '已取消'
}

/** 单轮 LLM 超时（毫秒）。 */
export const LLM_ROUND_TIMEOUT_MS = 60_000
/** 单轮失败后的重试次数（仍失败 → failed）。 */
export const LLM_ROUND_RETRIES = 1

/** 内容优化服务错误。 */
export class ContentOptimizeError extends Error {
  constructor(
    readonly code:
      | 'resume-not-found'
      | 'not-base-resume'
      | 'active-task-exists'
      | 'task-not-found'
      | 'bad-json'
      | 'invalid-state'
      | 'no-rewrite',
    message: string
  ) {
    super(message)
    this.name = 'ContentOptimizeError'
  }
}

/** 全局串行 LLM 轮次队列：保证同一时间只执行一个轮次（跨任务排队）。 */
export class LlmRoundQueue {
  private chain: Promise<unknown> = Promise.resolve()

  /** 入队执行；串行保证：上一个任务完成后才启动下一个。 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    // 链上吞错：错误由调用方处理，不阻塞后续轮次
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/** 全局共享轮次队列（服务默认实例；测试注入独立队列）。 */
export const globalRoundQueue = new LlmRoundQueue()

interface TaskRow {
  id: string
  resume_id: string
  status: ContentOptimizeStatus
  diagnosis_json: string
  answers_json: string
  rewrite_json: string
  progress: string
  error: string
  no_changes: number
  resume_to: string | null
  created_at: string
  updated_at: string
}

function parseRow(row: TaskRow): ContentOptimizeTask {
  return {
    id: row.id,
    resumeId: row.resume_id,
    status: row.status,
    diagnosis: parseOptionalJson<ContentDiagnosis>(row.diagnosis_json),
    answers: parseOptionalJson<Record<string, string>>(row.answers_json),
    rewrite: parseOptionalJson<ContentRewrite>(row.rewrite_json),
    progress: row.progress,
    error: row.error === '' ? null : row.error,
    noChanges: row.no_changes === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseOptionalJson<T>(raw: string): T | null {
  if (raw === 'null' || raw === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export interface ContentOptimizeServiceOptions {
  /** 任务变更事件（IPC 层接推送 contentOptimize:changed；测试注入收集）。 */
  emit?: (task: ContentOptimizeTask) => void
  /** LLM 轮次队列（默认全局共享队列；测试注入独立队列）。 */
  queue?: LlmRoundQueue
  /** 单轮超时 ms（测试注入短值）。 */
  roundTimeoutMs?: number
  /** 单轮重试次数（测试注入 0/1）。 */
  roundRetries?: number
}

interface TaskMutation {
  status?: ContentOptimizeStatus
  diagnosis?: ContentDiagnosis | null
  answers?: Record<string, string> | null
  rewrite?: ContentRewrite | null
  progress?: string
  error?: string | null
  noChanges?: boolean
  resumeTo?: string | null
}

export class ContentOptimizeService {
  private readonly emit: ContentOptimizeServiceOptions['emit']
  private readonly queue: LlmRoundQueue
  private readonly roundTimeoutMs: number
  private readonly roundRetries: number
  /** 进行中任务的取消标记（key = taskId）。 */
  private readonly cancelRequested = new Map<string, boolean>()

  constructor(
    private readonly db: Db,
    private readonly resumes: ResumeService,
    private readonly agent: AgentService,
    options: ContentOptimizeServiceOptions = {}
  ) {
    this.emit = options.emit
    this.queue = options.queue ?? globalRoundQueue
    this.roundTimeoutMs = options.roundTimeoutMs ?? LLM_ROUND_TIMEOUT_MS
    this.roundRetries = options.roundRetries ?? LLM_ROUND_RETRIES
  }

  // ---- 查询 ----

  /** 全部内容优化任务（按创建时间倒序）。 */
  list(): ContentOptimizeTask[] {
    const rows = this.db
      .prepare('SELECT * FROM content_optimize_tasks ORDER BY created_at DESC, id')
      .all() as TaskRow[]
    return rows.map(parseRow)
  }

  /** 单任务；不存在返回 undefined。 */
  get(taskId: string): ContentOptimizeTask | undefined {
    const row = this.db.prepare(SELECT_BY_ID).get(taskId) as TaskRow | undefined
    return row === undefined ? undefined : parseRow(row)
  }

  /** 某基准简历的任务列表。 */
  forResume(resumeId: string): ContentOptimizeTask[] {
    const rows = this.db.prepare(SELECT_BY_RESUME).all(resumeId) as TaskRow[]
    return rows.map(parseRow)
  }

  /**
   * 开始内容优化任务：校验基准简历 + 单基准单草稿约束，创建任务并启动诊断轮。
   * 异步轮次在后台执行；任务卡片经 emit 事件实时推送阶段流转。
   */
  start(resumeId: string): ContentOptimizeTask {
    const resume = this.resumes.get(resumeId)
    if (resume === undefined) {
      throw new ContentOptimizeError('resume-not-found', `简历不存在：${resumeId}`)
    }
    // #90-27：内容优化不接受「按 JD 生成的优化简历」作为输入（只对基准简历开放）
    if (resume.meta.baseResumeId != null || resume.meta.targetJobId != null) {
      throw new ContentOptimizeError('not-base-resume', '内容优化仅支持基准简历——请选择一份基准简历')
    }
    const active = this.forResume(resumeId).find(
      (t) => t.status !== 'confirmed' && t.status !== 'cancelled'
    )
    if (active !== undefined) {
      throw new ContentOptimizeError(
        'active-task-exists',
        '该基准简历已有进行中的内容优化任务（确认或取消后才能开始新的）'
      )
    }

    const now = new Date().toISOString()
    const taskId = `cot-${randomUUID()}`
    const task: ContentOptimizeTask = {
      id: taskId,
      resumeId,
      status: 'created',
      diagnosis: null,
      answers: null,
      rewrite: null,
      progress: CONTENT_PHASE_LABELS.created,
      error: null,
      noChanges: false,
      createdAt: now,
      updatedAt: now
    }
    this.db.prepare(INSERT).run(rowParams(task))
    this.publish(task)
    // 后台启动诊断轮（队列串行）
    void this.queue.enqueue(() => this.runDiagnosis(taskId))
    return task
  }

  /**
   * 提交追问回答：awaiting_answers → rewriting，随后执行改写轮。
   * T04 追问表单填充 answers；T02 空诊断路径不会到达此状态。
   */
  submitAnswers(taskId: string, answers: Record<string, string>): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status !== 'awaiting_answers') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可提交回答：${task.status}`)
    }
    const next = this.mutate(task, {
      answers,
      status: 'rewriting',
      progress: CONTENT_PHASE_LABELS.rewriting,
      resumeTo: 'rewriting'
    })
    void this.queue.enqueue(() => this.runRewrite(taskId))
    return next
  }

  /**
   * 确认内容优化稿：ready_for_review → confirmed。
   * 空诊断路径（noChanges）不创建新版本；有改写时生成新的基准简历（#90-21）。
   */
  confirm(taskId: string): { task: ContentOptimizeTask; createdResumeId: string | null } {
    const task = this.requireTask(taskId)
    if (task.status !== 'ready_for_review') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可确认：${task.status}`)
    }
    let createdResumeId: string | null = null
    if (task.noChanges) {
      // 空诊断：无需修改，不创建新版本
      this.mutate(task, { status: 'confirmed', progress: CONTENT_PHASE_LABELS.confirmed })
    } else {
      if (task.rewrite === null) {
        throw new ContentOptimizeError('no-rewrite', '缺少改写结果，无法确认')
      }
      // #90-10/#90-21：确认后的内容优化稿成为新的基准简历（baseResumeId=null，血缘记录在任务里）
      const created = this.resumes.create({
        ...task.rewrite.resume,
        meta: {
          ...task.rewrite.resume.meta,
          id: undefined,
          baseResumeId: null,
          targetJobId: null,
          title: task.rewrite.resume.meta?.title ?? `内容优化稿（${task.resumeId}）`
        }
      })
      createdResumeId = created.meta.id as string
      this.mutate(task, { status: 'confirmed', progress: CONTENT_PHASE_LABELS.confirmed })
    }
    const updated = this.requireTask(taskId)
    return { task: updated, createdResumeId }
  }

  /** 取消任务：当前 LLM 轮结束后停止（round 完成后检查标记），已得结果保留。 */
  cancel(taskId: string): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status === 'confirmed' || task.status === 'cancelled') return task
    if (isRoundPhase(task.status) || task.status === 'created') {
      // 轮次已入队/进行中：标记取消，轮次开始或结束时停止（保留已存状态）
      this.cancelRequested.set(taskId, true)
      return this.requireTask(taskId)
    }
    // 等待/确认阶段无轮次：直接取消（可续接）
    return this.mutate(task, {
      status: 'cancelled',
      progress: CONTENT_PHASE_LABELS.cancelled,
      resumeTo: task.status
    })
  }

  /** 失败重试：回到失败时所在阶段重新执行该轮。 */
  retry(taskId: string): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status !== 'failed') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可重试：${task.status}`)
    }
    const target = phaseFromResumeTo(this.readResumeTo(taskId), task)
    if (!isRoundPhase(target)) {
      throw new ContentOptimizeError('invalid-state', `无法确定重试阶段：${task.status}`)
    }
    const next = this.mutate(task, {
      status: target,
      error: null,
      progress: CONTENT_PHASE_LABELS[target],
      resumeTo: target
    })
    void this.queue.enqueue(() => this.runPhase(taskId, target))
    return next
  }

  /** 取消后续接：回到取消前阶段继续。 */
  resume(taskId: string): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status !== 'cancelled') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可续接：${task.status}`)
    }
    const target = phaseFromResumeTo(this.readResumeTo(taskId), task)
    if (!isRoundPhase(target)) {
      // 非轮次阶段（awaiting_answers / ready_for_review）：直接恢复状态，等待用户操作
      return this.mutate(task, { status: target, progress: CONTENT_PHASE_LABELS[target], resumeTo: null })
    }
    const next = this.mutate(task, { status: target, progress: CONTENT_PHASE_LABELS[target], resumeTo: target })
    void this.queue.enqueue(() => this.runPhase(taskId, target))
    return next
  }

  /** 作废（取消后放弃任务）：删除任务记录，释放单基准单草稿约束。 */
  voidTask(taskId: string): void {
    const task = this.requireTask(taskId)
    if (task.status !== 'cancelled') {
      throw new ContentOptimizeError('invalid-state', `仅已取消任务可作废：${task.status}`)
    }
    this.cancelRequested.delete(taskId)
    this.db.prepare('DELETE FROM content_optimize_tasks WHERE id = ?').run(taskId)
  }

  // ---- 内部：轮次执行 ----

  /** 诊断轮：LLM 规则诊断（T03 填充规则引擎；T02 只解析结构）。超时+重试，仍失败 → failed。 */
  private async runDiagnosis(taskId: string): Promise<void> {
    if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
    const task = this.requireTask(taskId)
    this.mutate(task, { status: 'diagnosing', progress: '诊断中…', resumeTo: 'diagnosing' })
    if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
    try {
      const diagnosis = await this.runLlmRound(
        task,
        (t) => this.buildDiagnosisPrompt(t),
        (reply) => this.parseDiagnosis(reply)
      )
      if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
      this.completeDiagnosis(taskId, diagnosis)
    } catch (err) {
      this.fail(taskId, err)
    }
  }

  /** 改写轮：T05 填充逐项目改写；T02 空诊断路径不会到达（无 rewrite 判定）。 */
  private async runRewrite(taskId: string): Promise<void> {
    if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
    const task = this.requireTask(taskId)
    this.mutate(task, { status: 'rewriting', progress: '改写中…', resumeTo: 'rewriting' })
    if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
    try {
      const rewrite = await this.runLlmRound(
        task,
        (t) => this.buildRewritePrompt(t),
        (reply) => this.parseRewrite(reply)
      )
      if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
      const current = this.requireTask(taskId)
      this.mutate(current, {
        rewrite,
        status: 'ready_for_review',
        noChanges: false,
        progress: CONTENT_PHASE_LABELS.ready_for_review,
        resumeTo: 'ready_for_review'
      })
    } catch (err) {
      this.fail(taskId, err)
    }
  }

  /** 统一阶段轮入口（retry/resume 复用）。 */
  private async runPhase(taskId: string, phase: 'diagnosing' | 'rewriting'): Promise<void> {
    if (phase === 'diagnosing') return this.runDiagnosis(taskId)
    return this.runRewrite(taskId)
  }

  /**
   * 执行单个 LLM 轮次：新建 inMemory 会话 → prompt → 解析。
   * 超时 / 失败重试 roundRetries 次，仍失败向上抛（由调用方标记 failed）。
   */
  private async runLlmRound<T>(
    task: ContentOptimizeTask,
    buildPrompt: (task: ContentOptimizeTask) => string,
    parse: (reply: string) => T
  ): Promise<T> {
    const session = await this.agent.createSession('content_optimize')
    try {
      const prompt = buildPrompt(task)
      let lastError: unknown = null
      for (let attempt = 0; attempt <= this.roundRetries; attempt++) {
        try {
          const reply = await withTimeout(session.prompt(prompt), this.roundTimeoutMs)
          return parse(reply)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError ?? new Error('LLM 轮次失败')
    } finally {
      session.dispose()
    }
  }

  /** 诊断完成分派：有追问 → awaiting_answers；有改写 → rewriting；全部保持 → 无需修改。 */
  private completeDiagnosis(taskId: string, diagnosis: ContentDiagnosis): void {
    const task = this.requireTask(taskId)
    const hasQuestions = diagnosis.questions.length > 0
    const needsRewrite = diagnosis.projects.some((p) => p.verdict === 'rewrite')
    if (hasQuestions) {
      this.mutate(task, {
        diagnosis,
        status: 'awaiting_answers',
        progress: `等待回答（${diagnosis.questions.length} 项追问）`,
        resumeTo: 'awaiting_answers'
      })
      return
    }
    if (needsRewrite) {
      this.mutate(task, {
        diagnosis,
        status: 'rewriting',
        progress: CONTENT_PHASE_LABELS.rewriting,
        resumeTo: 'rewriting'
      })
      void this.queue.enqueue(() => this.runRewrite(taskId))
      return
    }
    // 空诊断：全部保持 → 无需修改
    this.mutate(task, {
      diagnosis,
      status: 'ready_for_review',
      noChanges: true,
      progress: '无需修改',
      resumeTo: 'ready_for_review'
    })
  }

  private fail(taskId: string, err: unknown): void {
    const task = this.requireTask(taskId)
    const message = err instanceof Error ? err.message : String(err)
    const phase = isRoundPhase(task.status) ? task.status : phaseFromResumeTo(this.readResumeTo(taskId), task)
    this.mutate(task, {
      status: 'failed',
      error: message,
      progress: CONTENT_PHASE_LABELS.failed,
      resumeTo: phase
    })
  }

  private finishCancelled(taskId: string): void {
    this.cancelRequested.delete(taskId)
    const task = this.requireTask(taskId)
    this.mutate(task, {
      status: 'cancelled',
      progress: CONTENT_PHASE_LABELS.cancelled,
      resumeTo: this.readResumeTo(taskId) ?? 'diagnosing'
    })
  }

  private isCancelled(taskId: string): boolean {
    return this.cancelRequested.get(taskId) === true
  }

  private requireTask(taskId: string): ContentOptimizeTask {
    const task = this.get(taskId)
    if (task === undefined) {
      throw new ContentOptimizeError('task-not-found', `任务不存在：${taskId}`)
    }
    return task
  }

  /** 读取任务的 resume_to（DB 列；任务对象不携带，供重试/续接定位阶段）。 */
  private readResumeTo(taskId: string): string | null {
    const row = this.db.prepare('SELECT resume_to FROM content_optimize_tasks WHERE id = ?').get(taskId) as
      | { resume_to: string | null }
      | undefined
    return row?.resume_to ?? null
  }

  /** 持久化任务变更 + 推送事件。 */
  private mutate(task: ContentOptimizeTask, patch: TaskMutation): ContentOptimizeTask {
    const next: ContentOptimizeTask = {
      ...task,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.diagnosis !== undefined ? { diagnosis: patch.diagnosis } : {}),
      ...(patch.answers !== undefined ? { answers: patch.answers } : {}),
      ...(patch.rewrite !== undefined ? { rewrite: patch.rewrite } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.noChanges !== undefined ? { noChanges: patch.noChanges } : {}),
      updatedAt: new Date().toISOString()
    }
    const row = this.db.prepare(SELECT_BY_ID).get(next.id) as TaskRow | undefined
    if (row === undefined) {
      // 任务已删除（void）后不应再 mutate
      throw new ContentOptimizeError('task-not-found', `任务不存在：${next.id}`)
    }
    this.db
      .prepare(
        `UPDATE content_optimize_tasks
         SET status = ?, diagnosis_json = ?, answers_json = ?, rewrite_json = ?,
             progress = ?, error = ?, no_changes = ?, resume_to = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.status,
        JSON.stringify(next.diagnosis),
        JSON.stringify(next.answers),
        JSON.stringify(next.rewrite),
        next.progress,
        next.error ?? '',
        next.noChanges ? 1 : 0,
        patch.resumeTo === undefined ? row.resume_to : patch.resumeTo,
        next.updatedAt,
        next.id
      )
    this.publish(next)
    return next
  }

  private publish(task: ContentOptimizeTask): void {
    this.emit?.(task)
  }

  // ---- 提示词与解析（T02 骨架；T03 替换诊断提示词，T05 替换改写轮） ----

  /** 诊断轮提示词：结构对齐 #90 规则判定（规则 ID/作用对象/状态/证据/问题/建议/来源）。 */
  private buildDiagnosisPrompt(task: ContentOptimizeTask): string {
    const resume = this.resumes.get(task.resumeId)
    return [
      '[内容优化 1/2：规则诊断] 你是一名简历内容优化专家。以下为一份应届生中文简历（无 JD、无岗位方向）。',
      '按预设规则逐条对照：',
      'R1 有效内容（项目写清难点与解决行动）；R2 标点/结构化拆解/突出重点/可读性（全局）；R3 实习经历前置（无条件相对顺序）；R4 项目四要素（简介/难点/个人工作量/技术栈）+ 结果检查。',
      '每个维度判定为 pass（通过）/ improve（需改进）/ insufficient（信息不足）/ na（不适用）；每个项目判定为 keep（保持）/ rewrite（可直接改写）/ needs-info（需要补充信息）。',
      '需要用户补充的事实写入 questions（按项目分组：简介/难点/个人工作量/结果/技术栈，含原文证据与候选）。',
      '不输出总分/等级。只输出 JSON，不要多余文字：',
      JSON.stringify({
        rules: [
          { ruleId: 'R1', target: 'project:<projectId>', status: 'pass|improve|insufficient|na', evidence: '原文证据', issue: '问题说明', suggestion: '建议动作', factSource: 'original|user-answer|inferred' }
        ],
        projects: [{ projectId: '<projectId>', verdict: 'keep|rewrite|needs-info' }],
        questions: [
          { projectId: '<projectId>', field: '简介|难点|个人工作量|结果|技术栈', question: '追问问题', evidence: '原文证据', candidates: ['候选1', '候选2'] }
        ]
      }),
      '',
      `简历 JSON：\n${JSON.stringify(resume)}`
    ].join('\n')
  }

  /** 改写轮提示词：T05 逐项目改写；T02 保留骨架。 */
  private buildRewritePrompt(task: ContentOptimizeTask): string {
    return [
      '[内容优化 2/2：项目改写] 基于诊断与用户回答，逐项目一次改写（融合所有适用规则），输出 JSON：',
      '{ "resume": {简历对象，符合 resume.schema.json}, "changes": [{ "projectId": "proj-1", "section": "projects", "before": "原文", "after": "改后", "reason": "理由", "source": "original|user-answer|inferred" }] }',
      '',
      `诊断：${JSON.stringify(task.diagnosis)}`,
      `用户回答：${JSON.stringify(task.answers)}`,
      `简历 JSON：\n${JSON.stringify(this.resumes.get(task.resumeId))}`
    ].join('\n')
  }

  /** 解析诊断轮输出：JSON 结构校验（T03 起扩展规则字段）。 */
  private parseDiagnosis(reply: string): ContentDiagnosis {
    const parsed = extractJson(reply)
    if (!isRecord(parsed)) throw new ContentOptimizeError('bad-json', '诊断输出结构非法')
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.filter(isRecord).map((p) => ({
          projectId: String(p.projectId ?? ''),
          verdict: isVerdict(p.verdict) ? p.verdict : 'keep'
        }))
      : []
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter(isRecord).map((q) => ({
          projectId: String(q.projectId ?? ''),
          field: String(q.field ?? ''),
          question: String(q.question ?? ''),
          evidence: String(q.evidence ?? ''),
          candidates: Array.isArray(q.candidates) ? q.candidates.map((c) => String(c)) : []
        }))
      : []
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.filter(isRecord).map((r) => ({
          ruleId: String(r.ruleId ?? ''),
          target: String(r.target ?? ''),
          status: isRuleStatus(r.status) ? r.status : ('na' as const),
          evidence: String(r.evidence ?? ''),
          issue: String(r.issue ?? ''),
          suggestion: String(r.suggestion ?? ''),
          factSource: isFactSource(r.factSource) ? r.factSource : ('original' as const)
        }))
      : []
    return { rules, projects, questions }
  }

  /** 解析改写轮输出：JSON 结构 + resume 过 schema 校验。 */
  private parseRewrite(reply: string): ContentRewrite {
    const parsed = extractJson(reply)
    if (!isRecord(parsed) || !isRecord(parsed.resume)) {
      throw new ContentOptimizeError('bad-json', '改写输出结构非法（缺 resume 对象）')
    }
    assertValidResume(parsed.resume) // 非法抛 ResumeValidationError（含定位）
    const changes = Array.isArray(parsed.changes)
      ? parsed.changes.filter(isRecord).map((c) => ({
          ...(c.projectId !== undefined ? { projectId: String(c.projectId) } : {}),
          section: String(c.section ?? ''),
          before: String(c.before ?? ''),
          after: String(c.after ?? ''),
          reason: String(c.reason ?? ''),
          source: isChangeSource(c.source) ? c.source : ('original' as const)
        }))
      : []
    return { resume: parsed.resume as unknown as Resume, changes }
  }
}

/** 空诊断（T02 垂直切片：规则判定空、项目全部保持、无追问）。 */
export const EMPTY_DIAGNOSIS: ContentDiagnosis = {
  rules: [],
  projects: [],
  questions: []
}

const SELECT_BY_ID = 'SELECT * FROM content_optimize_tasks WHERE id = ?'
const SELECT_BY_RESUME = 'SELECT * FROM content_optimize_tasks WHERE resume_id = ?'
const INSERT = `
  INSERT INTO content_optimize_tasks (id, resume_id, status, diagnosis_json, answers_json, rewrite_json, progress, error, no_changes, resume_to, created_at, updated_at)
  VALUES (@id, @resumeId, @status, @diagnosis, @answers, @rewrite, @progress, @error, @noChanges, @resumeTo, @createdAt, @updatedAt)
`

function isRoundPhase(status: ContentOptimizeStatus): status is 'diagnosing' | 'rewriting' {
  return status === 'diagnosing' || status === 'rewriting'
}

/** 从 resume_to（或状态推断）取阶段轮目标。 */
function phaseFromResumeTo(
  resumeTo: string | null,
  task: ContentOptimizeTask
): 'diagnosing' | 'awaiting_answers' | 'rewriting' | 'ready_for_review' {
  const to = resumeTo
  if (to === 'awaiting_answers' || to === 'rewriting' || to === 'ready_for_review' || to === 'diagnosing') {
    return to
  }
  if (task.diagnosis !== null && task.diagnosis.questions.length > 0) return 'awaiting_answers'
  if (task.noChanges) return 'ready_for_review'
  return 'diagnosing'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVerdict(value: unknown): value is 'keep' | 'rewrite' | 'needs-info' {
  return value === 'keep' || value === 'rewrite' || value === 'needs-info'
}

function isRuleStatus(value: unknown): value is 'pass' | 'improve' | 'insufficient' | 'na' {
  return value === 'pass' || value === 'improve' || value === 'insufficient' || value === 'na'
}

function isFactSource(value: unknown): value is 'original' | 'user-answer' | 'inferred' {
  return value === 'original' || value === 'user-answer' || value === 'inferred'
}

function isChangeSource(value: unknown): value is 'original' | 'user-answer' | 'inferred' {
  return value === 'original' || value === 'user-answer' || value === 'inferred'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM 轮次超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function rowParams(task: ContentOptimizeTask) {
  return {
    id: task.id,
    resumeId: task.resumeId,
    status: task.status,
    diagnosis: JSON.stringify(task.diagnosis),
    answers: JSON.stringify(task.answers),
    rewrite: JSON.stringify(task.rewrite),
    progress: task.progress,
    error: task.error ?? '',
    noChanges: task.noChanges ? 1 : 0,
    resumeTo: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}
