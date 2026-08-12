import { randomUUID } from 'node:crypto'
import type { Db } from '../db/migrations'
import type { PositionService } from './position'
import type { JdAnalysis, Topic, TopicInput, TopicSource, TopicStatus, TopicGenerateInput } from '../../shared/types'
import { TOPIC_SOURCES, TOPIC_STATUSES } from '../../shared/types'

/**
 * 学习清单服务（F-19/#33）。
 * - generateFromJob(jobId, extras?)：从 positions.jd_analysis 缓存生成清单——
 *   hardRequirements → 优先级 1（hard）、skills → 优先级 2（mentioned）；
 *   extras.gaps → 优先级 3（gap）、extras.techStack → 优先级 4（project）；
 *   extras 缺省时降级为仅 JD 分析来源；同职位同 title 去重（跳过）；
 * - 人工 CRUD：create（manual，优先级 5）/ update / delete / setStatus 三态 todo→learning→learned。
 */

/** 清单生成结果。 */
export interface TopicGenerateResult {
  created: Topic[]
  /** 去重跳过的条数。 */
  skipped: number
}

export class TopicError extends Error {
  constructor(
    readonly code: 'validation' | 'not-found',
    message: string
  ) {
    super(message)
    this.name = 'TopicError'
  }
}

export interface TopicFilters {
  status?: TopicStatus
  jobId?: string
}

const LIST_SELECT = 'SELECT * FROM topics'
const LIST_ORDER = 'ORDER BY priority ASC, created_at ASC'

export class TopicService {
  constructor(
    private readonly db: Db,
    private readonly positions: PositionService,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /**
   * 从职位 JD 分析生成学习清单（jd_analysis 缓存由 #28 优化流程写入）。
   * 无 jd_analysis / 无 extras → 降级（空或仅 JD 分析来源），不报错。
   */
  generateFromJob(jobId: string, extras: TopicGenerateInput = {}): TopicGenerateResult {
    this.positions.get(jobId) // 职位不存在 → not-found
    const row = this.db.prepare('SELECT jd_analysis FROM positions WHERE id = ?').get(jobId) as
      | { jd_analysis: string | null }
      | undefined
    const analysis = parseAnalysis(row?.jd_analysis)

    const createdIds: string[] = []
    let skipped = 0
    const now = this.now()

    const insert = (title: string, priority: number, source: TopicSource): void => {
      const trimmed = title.trim()
      if (trimmed === '') return
      const existing = this.db
        .prepare('SELECT id FROM topics WHERE title = ? AND job_id = ?')
        .get(trimmed, jobId)
      if (existing !== undefined) {
        skipped++
        return
      }
      const id = `topic-${randomUUID()}`
      this.db
        .prepare(
          `INSERT INTO topics (id, title, status, priority, source, job_id, note, created_at, updated_at)
           VALUES (?, ?, 'todo', ?, ?, ?, '', ?, ?)`
        )
        .run(id, trimmed, priority, source, jobId, now, now)
      createdIds.push(id)
    }

    if (analysis !== null) {
      for (const item of analysis.hardRequirements) insert(item, 1, 'hard')
      for (const item of analysis.skills) insert(item, 2, 'mentioned')
    }
    for (const gap of extras.gaps ?? []) insert(gap, 3, 'gap')
    for (const tech of extras.techStack ?? []) insert(tech, 4, 'project')

    return { created: createdIds.map((id) => this.get(id)), skipped }
  }

  /** 全部条目（按优先级升序）；可按状态/职位筛选。 */
  list(filters: TopicFilters = {}): Topic[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filters.status !== undefined) {
      clauses.push('status = ?')
      params.push(filters.status)
    }
    if (filters.jobId !== undefined) {
      clauses.push('job_id = ?')
      params.push(filters.jobId)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    return this.db.prepare(`${LIST_SELECT}${where} ${LIST_ORDER}`).all(...params) as Topic[]
  }

  /** 人工创建条目（manual，优先级 5）。 */
  create(input: TopicInput): Topic {
    const title = input.title.trim()
    if (title === '') throw new TopicError('validation', '条目标题必填')
    const now = this.now()
    const id = `topic-${randomUUID()}`
    this.db
      .prepare(
        `INSERT INTO topics (id, title, status, priority, source, job_id, note, created_at, updated_at)
         VALUES (?, ?, 'todo', 5, 'manual', ?, ?, ?, ?)`
      )
      .run(id, title, input.jobId ?? null, input.note?.trim() ?? '', now, now)
    return this.get(id)
  }

  /** 编辑条目（title/note/priority）。 */
  update(id: string, patch: { title?: string; note?: string; priority?: number }): Topic {
    const existing = this.get(id) // not-found
    const title = patch.title?.trim() ?? existing.title
    if (title === '') throw new TopicError('validation', '条目标题必填')
    const priority = patch.priority ?? existing.priority
    if (priority < 1 || priority > 5) throw new TopicError('validation', '优先级必须是 1-5')
    this.db
      .prepare('UPDATE topics SET title = ?, note = ?, priority = ?, updated_at = ? WHERE id = ?')
      .run(title, patch.note?.trim() ?? existing.note, priority, this.now(), id)
    return this.get(id)
  }

  /** 三态流转（todo → learning → learned）。 */
  setStatus(id: string, status: TopicStatus): Topic {
    this.get(id) // not-found
    if (!(TOPIC_STATUSES as readonly string[]).includes(status)) {
      throw new TopicError('validation', `状态只能是：${TOPIC_STATUSES.join('/')}`)
    }
    this.db
      .prepare('UPDATE topics SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.now(), id)
    return this.get(id)
  }

  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM topics WHERE id = ?').run(id)
    if (result.changes === 0) throw new TopicError('not-found', `条目不存在：${id}`)
  }

  private get(id: string): Topic {
    const row = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as Topic | undefined
    if (row === undefined) throw new TopicError('not-found', `条目不存在：${id}`)
    return row
  }
}

/** 解析 jd_analysis 缓存；非法/缺失 → null（降级）。 */
function parseAnalysis(json: string | null | undefined): JdAnalysis | null {
  if (json === null || json === undefined) return null
  try {
    const parsed = JSON.parse(json) as JdAnalysis
    if (!Array.isArray(parsed.skills) || !Array.isArray(parsed.hardRequirements)) return null
    return parsed
  } catch {
    return null
  }
}

export { TOPIC_SOURCES, TOPIC_STATUSES }
export type { TopicSource, TopicStatus }
