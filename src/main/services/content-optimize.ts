import { randomUUID } from 'node:crypto'
import type { Db } from '../db/migrations'
import type { AgentService } from './agent'
import type { ResumeService } from './resume'
import { generateProjectId } from './resume-content-backfill'
import {
  CONTENT_CONFIRMED_NO_CHANGES_LABEL,
  CONTENT_STATUS_LABELS,
  type ContentDiagnosis,
  type ContentIntegrationSummary,
  type ContentOptimizeStatus,
  type ContentOptimizeTask,
  type ContentProjectDecision,
  type ContentPromotionMissingField,
  type ContentPromotionSuggestion,
  type ContentRewrite
} from '../../shared/types'
import type { Resume, ResumeProject } from '../../shared/types/resume'
import { normalizeText } from '../../shared/text-utils'
import { contentQuestionKeys } from '../../shared/content-answers'
import {
  isPromotionAnswerSentinel,
  promotionQuestionKey,
  promotionQuestionKeys
} from '../../shared/content-promotions'
import {
  buildFinalResume,
  buildIntegrationSummary,
  pendingInferredChanges,
  resumesDiffer
} from '../../shared/content-review'
import {
  buildDiagnosisPrompt as buildRulesDiagnosisPrompt,
  parseDiagnosis as parseDiagnosisReply
} from './diagnosis-engine'
import {
  buildRewritePrompt as buildRewriteEnginePrompt,
  parseRewrite as parseRewriteEngineReply,
  type RewriteRoundInput
} from './rewrite-engine'

/**
 * ContentOptimizeService（#90 业务① / T02）：简历内容优化异步任务骨架。
 *
 * 状态机（决策编码自 #90 设计会话）：
 *   created → diagnosing → awaiting_answers → rewriting → ready_for_review → confirmed
 *   failed：可手动重试回对应阶段（resume_to 记录失败时所在阶段）；
 *   cancelled：可续接（resume_to 记录取消前阶段）或作废（void）。
 *   #98/T08 大赛提升：awaiting_answers 确认提升（confirmPromotion）→ honors 大赛转项目 →
 *   回到 diagnosing 重新诊断（提升项目以真实项目 id 参与规则判定），再走正常状态流。
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
 *
 * 公开 API（IPC 接线见 src/main/ipc/index.ts）：
 *   start / list / get / forResume / submitAnswers / setReview / confirm /
 *   cancel / retry / resume / voidTask / confirmPromotion（T08） / hasCompletedContentOptimization（T07）。
 */

/** 阶段进度文案（单一来源 shared/types.ts CONTENT_STATUS_LABELS，服务端旧名兼容）。 */
export const CONTENT_PHASE_LABELS = CONTENT_STATUS_LABELS

/** 单轮 LLM 超时（毫秒）。 */
// 真实模型实测（#101）：deepseek 改写轮（提示词含诊断+回答+整份简历，长思考）常超 60s。
// 60s 对诊断轮够用、对改写轮不足——统一提高至 180s；重试 1 次语义不变。
export const LLM_ROUND_TIMEOUT_MS = 180_000
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
      | 'invalid-answers'
      | 'invalid-promotion'
      | 'no-rewrite'
      | 'invalid-decisions'
      | 'inferred-pending',
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
  decisions_json: string
  inferred_confirmed_json: string
  summary_json: string
  created_resume_id: string | null
  archived_at: string | null
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
    decisions: parseOptionalJson<Record<string, ContentProjectDecision>>(row.decisions_json),
    inferredConfirmed: parseOptionalJson<string[]>(row.inferred_confirmed_json),
    summary: parseOptionalJson<ContentIntegrationSummary>(row.summary_json),
    createdResumeId: row.created_resume_id,
    archivedAt: row.archived_at,
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
  decisions?: Record<string, ContentProjectDecision> | null
  inferredConfirmed?: string[] | null
  summary?: ContentIntegrationSummary | null
  createdResumeId?: string | null
  archivedAt?: string | null
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
   * 启动恢复（AC-3 支持中断续接）：上次运行在轮次阶段（diagnosing/rewriting）
   * 被杀掉的进行中任务，重新入队执行对应阶段轮（应用启动后调用）。
   * 非轮次阶段（created/awaiting_answers/ready_for_review/failed/cancelled/confirmed）
   * 不动——诊断/回答/确认均已持久化，等待用户操作或手动重试/续接即可。
   */
  recoverInFlight(): void {
    const rows = this.db
      .prepare("SELECT id, status FROM content_optimize_tasks WHERE status IN ('diagnosing', 'rewriting')")
      .all() as Array<{ id: string; status: ContentOptimizeStatus }>
    for (const row of rows) {
      const phase = row.status === 'rewriting' ? 'rewriting' : 'diagnosing'
      this.queue.enqueue(() => this.runPhase(row.id, phase))
    }
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
    // #91→T02 接线：首次进入内容优化自动补齐项目稳定 ID/≤4 条要点/sectionOrder（幂等，
    // 无缺失字段时 changed=false 不改动；补齐结果先落库再创建任务）。
    const backfill = this.resumes.prepareContentOptimization(resumeId)
    if (backfill.changed) {
      this.resumes.update(resumeId, backfill.resume)
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
      decisions: null,
      inferredConfirmed: null,
      summary: null,
      createdResumeId: null,
      archivedAt: null,
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
   * 校验：只接受已知问题键（容忍部分回答——未答项允许缺失；不属实/无法补充用哨兵值）。
   */
  submitAnswers(taskId: string, answers: Record<string, string>): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status !== 'awaiting_answers') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可提交回答：${task.status}`)
    }
    const questions = task.diagnosis?.questions ?? []
    this.validateAnswers(contentQuestionKeys(questions), answers, '问题', '回答')
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
   * 确认大赛提升为项目（T08/#98）：honors 中大赛条目 → 新项目（缺失字段由追问回答补齐）。
   *
   * 语义：
   * - 仅 awaiting_answers 可确认（诊断已产出提升建议）；
   * - 回答键必须是该提升建议的缺失字段键（promotion-<id>-<字段>），哨兵值
   *   （不属实/无法补充）不写入项目字段，键缺失 = 该字段不填；
   * - 应用提升：honors 移除该条目 → projects 追加新项目（稳定 id，字段来自回答），
   *   更新基准简历并持久化；提升回答并入任务 answers（改写轮可引用已确认事实）；
   * - 重新跑诊断轮：提升后的项目以真实项目 id 参与规则诊断（R1/R4 判定、追问、改写）。
   *   注意：重新诊断会替换诊断结果（含常规追问）——提升确认应在表单顶部优先完成。
   */
  confirmPromotion(taskId: string, promotionId: string, answers: Record<string, string>): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status !== 'awaiting_answers') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可确认提升：${task.status}`)
    }
    const promotion = (task.diagnosis?.promotions ?? []).find((p) => p.id === promotionId)
    if (promotion === undefined) {
      throw new ContentOptimizeError('invalid-promotion', `提升建议不存在：${promotionId}`)
    }
    // 回答键校验：只接受该建议缺失字段的追问键；值非空（哨兵允许）
    this.validateAnswers(promotionQuestionKeys(promotion), answers)
    const resume = this.resumes.get(task.resumeId)
    if (resume === undefined) {
      throw new ContentOptimizeError('resume-not-found', `简历不存在：${task.resumeId}`)
    }
    const honors = resume.honors ?? []
    const honor = honors[promotion.honorIndex]
    if (honor === undefined) {
      throw new ContentOptimizeError('invalid-promotion', `荣誉条目不存在：honors[${promotion.honorIndex}]`)
    }
    // #98 review：确认对象 = 建议针对的荣誉原文——下标位与实际名称不符（诊断后简历被改）时拒绝
    // （宽松比较：去标点空白/小写，容忍 LLM 转写差异）。
    if (normalizeText(honor) !== normalizeText(promotion.honorName)) {
      throw new ContentOptimizeError(
        'invalid-promotion',
        `荣誉名称与提升建议不符："${honor}" ≠ "${promotion.honorName}"`
      )
    }
    // 应用提升：honors 移除该条目，projects 追加新项目（字段由回答补齐，哨兵不写入）
    const project = buildPromotedProject(promotion, answers)
    const nextResume: Resume = {
      ...resume,
      honors: honors.filter((_, index) => index !== promotion.honorIndex),
      projects: [...(resume.projects ?? []), project]
    }
    this.resumes.update(task.resumeId, nextResume)
    // 提升回答并入任务 answers（改写轮可引用）；随后重新诊断（提升项目参与规则判定）
    const mergedAnswers = { ...(task.answers ?? {}), ...answers }
    const next = this.mutate(task, {
      answers: mergedAnswers,
      status: 'diagnosing',
      progress: '提升后重新诊断…',
      resumeTo: 'diagnosing'
    })
    void this.queue.enqueue(() => this.runDiagnosis(taskId))
    return next
  }

  /**
   * 保存按项目接受/拒绝决策 + 推断-待确认改动勾选（T06/#96）。
   * ready_for_review 且已有改写时可用（空诊断路径无改写，无需决策）；
   * 决策/勾选持久化，中断续接后仍保留（任务卡刷新后由渲染层从任务恢复）。
   * 校验：决策键必须是已知项目（原文 ∪ 改写稿）；勾选 id 必须是已知改动 id。
   */
  setReview(
    taskId: string,
    review: { decisions: Record<string, ContentProjectDecision>; inferredConfirmed: string[] }
  ): ContentOptimizeTask {
    const task = this.requireTask(taskId)
    if (task.status !== 'ready_for_review' || task.noChanges || task.rewrite === null) {
      throw new ContentOptimizeError('invalid-state', `当前状态不可设置确认决策：${task.status}`)
    }
    const original = this.resumes.get(task.resumeId)
    if (original === undefined) {
      throw new ContentOptimizeError('resume-not-found', `简历不存在：${task.resumeId}`)
    }
    const knownIds = new Set<string>([
      ...(original.projects ?? [])
        .map((p) => p.id)
        .filter((id): id is string => id !== undefined),
      ...(task.rewrite.resume.projects ?? [])
        .map((p) => p.id)
        .filter((id): id is string => id !== undefined)
    ])
    const unknownProjects = Object.keys(review.decisions).filter((id) => !knownIds.has(id))
    if (unknownProjects.length > 0) {
      throw new ContentOptimizeError('invalid-decisions', `包含未知项目：${unknownProjects.join(', ')}`)
    }
    const badValues = Object.values(review.decisions).filter(
      (value) => value !== 'accept' && value !== 'reject'
    )
    if (badValues.length > 0) {
      throw new ContentOptimizeError('invalid-decisions', `包含非法决策值：${badValues.join(', ')}`)
    }
    const knownChangeIds = new Set(
      (task.rewrite.changes ?? [])
        .map((c) => c.id)
        .filter((id): id is string => id !== undefined)
    )
    const unknownConfirmations = review.inferredConfirmed.filter((id) => !knownChangeIds.has(id))
    if (unknownConfirmations.length > 0) {
      throw new ContentOptimizeError('invalid-decisions', `包含未知改动 id：${unknownConfirmations.join(', ')}`)
    }
    return this.mutate(task, {
      decisions: review.decisions,
      inferredConfirmed: review.inferredConfirmed
    })
  }

  /**
   * 确认内容优化稿：ready_for_review → confirmed。
   * 空诊断路径（noChanges）不创建新版本；有改写时：
   * - US17 门禁：未勾选的推断-待确认改动 → 拒绝（inferred-pending，返回需勾选列表）；
   * - 整合（T06）：按项目决策整合最终稿（接受/拒绝/删除确认），拒绝项目保留原文；
   * - 标点/排序自动修复与「仍有未解决项目」汇总记入任务（summary），确认后展示；
   * - 最终稿与原文无差异（如全部拒绝）→ 不创建新版本（US20）；
   * - 有实际改动 → 生成新的基准简历（#90-21，保留旧基准，血缘记在任务里）。
   */
  confirm(taskId: string): { task: ContentOptimizeTask; createdResumeId: string | null } {
    const task = this.requireTask(taskId)
    if (task.status !== 'ready_for_review') {
      throw new ContentOptimizeError('invalid-state', `当前状态不可确认：${task.status}`)
    }
    let createdResumeId: string | null = null
    if (task.noChanges) {
      // 空诊断：无需修改，不创建新版本（仍归档）
      this.mutate(task, {
        status: 'confirmed',
        progress: CONTENT_PHASE_LABELS.confirmed,
        archivedAt: new Date().toISOString()
      })
    } else {
      if (task.rewrite === null) {
        throw new ContentOptimizeError('no-rewrite', '缺少改写结果，无法确认')
      }
      const decisions = task.decisions ?? {}
      const confirmed = task.inferredConfirmed ?? []
      const pending = pendingInferredChanges(task.rewrite, decisions, confirmed)
      if (pending.length > 0) {
        // US17：推断-待确认改动必须显式勾选后才进入最终版（错误码 + 需勾选列表）
        throw new ContentOptimizeError(
          'inferred-pending',
          `存在未勾选的推断-待确认改动：${pending
            .map((c) => c.id ?? '?')
            .join('、')}`
        )
      }
      const original = this.resumes.get(task.resumeId)
      if (original === undefined) {
        throw new ContentOptimizeError('resume-not-found', `简历不存在：${task.resumeId}`)
      }
      const finalResume = buildFinalResume(original, task.rewrite, decisions)
      const summary = buildIntegrationSummary(original, task.rewrite, decisions)
      if (!resumesDiffer(original, finalResume)) {
        // 未应用任何改动（如全部拒绝）：不创建新版本（US20），仍保留「仍有未解决项目」等汇总
        this.mutate(task, {
          status: 'confirmed',
          progress: CONTENT_CONFIRMED_NO_CHANGES_LABEL,
          summary,
          archivedAt: new Date().toISOString()
        })
      } else {
        // #90-10/#90-21：确认后的内容优化稿成为新的基准简历（baseResumeId=null，血缘记录在任务里）
        const created = this.resumes.create({
          ...finalResume,
          meta: {
            ...finalResume.meta,
            id: undefined,
            baseResumeId: null,
            targetJobId: null,
            title: finalResume.meta?.title ?? `内容优化稿（${task.resumeId}）`
          }
        })
        createdResumeId = created.meta.id as string
        this.mutate(task, {
          status: 'confirmed',
          progress: CONTENT_PHASE_LABELS.confirmed,
          summary,
          createdResumeId,
          archivedAt: new Date().toISOString()
        })
      }
    }
    const updated = this.requireTask(taskId)
    return { task: updated, createdResumeId }
  }

  /**
   * T07：某基准简历是否已完成过内容优化（有已确认/归档任务）。
   * 语义：用于「按 JD 优化入口对未做内容优化的基准显示建议先做内容优化」提示；
   * 派生稿（按 JD 优化稿）不属于内容优化对象，恒为 false。
   */
  hasCompletedContentOptimization(resumeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM content_optimize_tasks
         WHERE resume_id = ? AND status = 'confirmed' AND archived_at IS NOT NULL LIMIT 1`
      )
      .get(resumeId) as { x: number } | undefined
    return row !== undefined
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
        (reply) => this.parseRewrite(reply, task)
      )
      if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
      const current = this.requireTask(taskId)
      // T06：为每条改动分配稳定 id（推断-待确认勾选引用；改写轮内索引稳定）
      const rewriteWithIds: ContentRewrite = {
        ...rewrite,
        changes: rewrite.changes.map((change, index) => ({
          ...change,
          id: change.id ?? `chg-${index}`
        }))
      }
      this.mutate(current, {
        rewrite: rewriteWithIds,
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
    let session = await this.agent.createSession('content_optimize')
    try {
      const prompt = buildPrompt(task)
      let lastError: unknown = null
      for (let attempt = 0; attempt <= this.roundRetries; attempt++) {
        try {
          const reply = await withTimeout(session.prompt(prompt), this.roundTimeoutMs)
          return parse(reply)
        } catch (err) {
          lastError = err
          // #100：超时/失败后不得在同一个 session 上重试。
          // withTimeout 只是 Promise.race 超时，底层 prompt 可能仍在处理（pi SDK
          // isStreaming=true），复用同一 session 会抛
          // 「Agent is already processing. Specify streamingBehavior ...」。
          // 重试前先 abort 并丢弃旧会话，改用全新会话（每轮幂等，重跑无害）。
          if (attempt < this.roundRetries) {
            try {
              await session.abort()
            } catch {
              // abort 失败不阻塞重试（旧会话随后 dispose）
            }
            session.dispose()
            session = await this.agent.createSession('content_optimize')
          }
        }
      }
      throw lastError ?? new Error('LLM 轮次失败')
    } finally {
      session.dispose()
    }
  }

  /** 诊断完成分派：有追问或大赛提升建议 → awaiting_answers；有改写 → rewriting；全部保持 → 无需修改。 */
  private completeDiagnosis(taskId: string, diagnosis: ContentDiagnosis): void {
    const task = this.requireTask(taskId)
    const hasPromotions = diagnosis.promotions.length > 0
    const hasQuestions = diagnosis.questions.length > 0
    const needsRewrite = diagnosis.projects.some((p) => p.verdict === 'rewrite')
    if (hasQuestions || hasPromotions) {
      const parts: string[] = []
      if (hasPromotions) parts.push(`${diagnosis.promotions.length} 项大赛提升建议`)
      if (hasQuestions) parts.push(`${diagnosis.questions.length} 项追问`)
      this.mutate(task, {
        diagnosis,
        status: 'awaiting_answers',
        progress: `等待回答（${parts.join('、')}）`,
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
    // 取消在轮次进行中已置位：轮次已结束（无论成败），取消优先 → cancelled，
    // 避免 failed 状态下重试被遗留的取消标记立即再取消（取消 = 当前 LLM 轮结束后停止）。
    if (this.isCancelled(taskId)) return this.finishCancelled(taskId)
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

  /**
   * 回答校验（T04 追问 / T08 提升追问共用，单一实现）：
   * 只接受已知键（容忍部分回答——未答项允许缺失；不属实/无法补充用哨兵值），
   * 值去空白后非空（哨兵值与普通文本均非空）。
   * keyLabel/valueLabel 用于错误文案（追问=问题/回答，提升追问=回答），保持各调用点历史文案。
   */
  private validateAnswers(
    knownKeys: string[],
    answers: Record<string, string>,
    keyLabel = '回答',
    valueLabel = '回答'
  ): void {
    const known = new Set(knownKeys)
    const unknown = Object.keys(answers).filter((key) => !known.has(key))
    if (unknown.length > 0) {
      throw new ContentOptimizeError('invalid-answers', `包含未知${keyLabel}键：${unknown.join(', ')}`)
    }
    const emptyValues = Object.entries(answers)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key)
    if (emptyValues.length > 0) {
      throw new ContentOptimizeError('invalid-answers', `包含空${valueLabel}值：${emptyValues.join(', ')}`)
    }
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
      ...(patch.decisions !== undefined ? { decisions: patch.decisions } : {}),
      ...(patch.inferredConfirmed !== undefined ? { inferredConfirmed: patch.inferredConfirmed } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.createdResumeId !== undefined ? { createdResumeId: patch.createdResumeId } : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
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
             progress = ?, error = ?, no_changes = ?, resume_to = ?, updated_at = ?,
             decisions_json = ?, inferred_confirmed_json = ?, summary_json = ?,
             created_resume_id = ?, archived_at = ?
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
        JSON.stringify(next.decisions),
        JSON.stringify(next.inferredConfirmed),
        JSON.stringify(next.summary),
        next.createdResumeId,
        next.archivedAt,
        next.id
      )
    this.publish(next)
    return next
  }

  private publish(task: ContentOptimizeTask): void {
    this.emit?.(task)
  }

  // ---- 提示词与解析（T02 骨架；T03 规则诊断引擎，T05 替换改写轮） ----

  /** 诊断轮提示词：委托 diagnosis-engine 完整规则矩阵（R1–R4+结果，含质量维度定义）。 */
  private buildDiagnosisPrompt(task: ContentOptimizeTask): string {
    const resume = this.resumes.get(task.resumeId)
    return buildRulesDiagnosisPrompt(resume!)
  }

  /** 改写轮提示词：委托 rewrite-engine（T05 规则化逐项目改写 + 事实使用规则）。 */
  private buildRewritePrompt(task: ContentOptimizeTask): string {
    const resume = this.resumes.get(task.resumeId)
    const input: RewriteRoundInput = {
      resume: resume!,
      diagnosis: task.diagnosis,
      answers: task.answers
    }
    return buildRewriteEnginePrompt(input)
  }

  /** 解析诊断轮输出：委托 diagnosis-engine（JSON 结构校验 + 项目判定一致性推导）。 */
  private parseDiagnosis(reply: string): ContentDiagnosis {
    try {
      return parseDiagnosisReply(reply)
    } catch (err) {
      if (err instanceof ContentOptimizeError) throw err
      throw new ContentOptimizeError(
        'bad-json',
        err instanceof Error ? err.message : '诊断输出结构非法'
      )
    }
  }

  /** 解析改写轮输出：委托 rewrite-engine（JSON + schema + 事实溯源 + 一致性校验）。 */
  private parseRewrite(reply: string, task: ContentOptimizeTask): ContentRewrite {
    const resume = this.resumes.get(task.resumeId)
    try {
      return parseRewriteEngineReply(reply, {
        resume: resume!,
        diagnosis: task.diagnosis,
        answers: task.answers
      })
    } catch (err) {
      if (err instanceof ContentOptimizeError) throw err
      throw new ContentOptimizeError(
        'bad-json',
        err instanceof Error ? err.message : '改写输出结构非法'
      )
    }
  }
}

const SELECT_BY_ID = 'SELECT * FROM content_optimize_tasks WHERE id = ?'
const SELECT_BY_RESUME = 'SELECT * FROM content_optimize_tasks WHERE resume_id = ?'
const INSERT = `
  INSERT INTO content_optimize_tasks (id, resume_id, status, diagnosis_json, answers_json, rewrite_json, progress, error, no_changes, resume_to, decisions_json, inferred_confirmed_json, summary_json, created_resume_id, archived_at, created_at, updated_at)
  VALUES (@id, @resumeId, @status, @diagnosis, @answers, @rewrite, @progress, @error, @noChanges, @resumeTo, @decisions, @inferredConfirmed, @summary, @createdResumeId, @archivedAt, @createdAt, @updatedAt)
`

function isRoundPhase(status: ContentOptimizeStatus): status is 'diagnosing' | 'rewriting' {
  return status === 'diagnosing' || status === 'rewriting'
}

/**
 * 提升为项目（T08/#98）：由提升建议 + 用户回答构建新项目。
 * - 项目名 = 大赛名（honorName，来自荣誉原文）；稳定 id 由 backfill 同源生成；
 * - 缺失字段（时间/技术栈/描述）由回答补齐；哨兵（不属实/无法补充）与空回答不写入；
 * - 技术栈回答按常见分隔符拆分（,，、;；/），未答不填。
 */
function buildPromotedProject(
  promotion: ContentPromotionSuggestion,
  answers: Record<string, string>
): ResumeProject {
  const fieldValue = (field: ContentPromotionMissingField): string | undefined => {
    const raw = answers[promotionQuestionKey(promotion, field)]
    if (raw === undefined || isPromotionAnswerSentinel(raw)) return undefined
    const trimmed = raw.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const project: ResumeProject = { id: generateProjectId(), name: promotion.honorName }
  const startDate = fieldValue('startDate')
  if (startDate !== undefined) project.startDate = startDate
  const endDate = fieldValue('endDate')
  if (endDate !== undefined) project.endDate = endDate
  const techStack = fieldValue('techStack')
  if (techStack !== undefined) project.techStack = splitList(techStack)
  const description = fieldValue('description')
  if (description !== undefined) project.description = description
  return project
}

/** 技术栈回答拆分（逗号/顿号/分号/斜杠分隔，去空与重复）。 */
function splitList(value: string): string[] {
  const parts = value
    .split(/[,，、;；/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  return [...new Set(parts)]
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
    decisions: JSON.stringify(task.decisions),
    inferredConfirmed: JSON.stringify(task.inferredConfirmed),
    summary: JSON.stringify(task.summary),
    createdResumeId: task.createdResumeId,
    archivedAt: task.archivedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}
