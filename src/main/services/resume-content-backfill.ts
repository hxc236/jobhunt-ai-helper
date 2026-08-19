import { randomUUID } from 'node:crypto'
import type { Resume, ResumeProject, ResumeSectionKey } from '../../shared/types/resume'
import { DEFAULT_SECTION_ORDER } from '../../shared/types/resume'

/**
 * 内容优化数据补齐（#91 prefactor）：存量简历首次进入内容优化时调用，纯函数。
 * - 项目缺失 `id` → 生成稳定 ID（`proj-<uuid>`，仅补缺，已有 ID 不动）；
 * - 简历缺失 `sectionOrder` → 由既有模块顺序推断（默认顺序中该简历实际存在的节）；
 * - 项目缺失 `highlights` → description 迁移为要点起点（按行拆条，≤4 条，技术栈不计）；
 * - 幂等：重复运行对已补齐字段不再生成（第二次运行返回 changed=false，结果与首次一致）。
 * - 只做补齐，不改写已有内容（description 保留，作为要点起点与旧消费者回退）。
 */

/** 项目 ID 前缀（与简历 `res-` 前缀区分）。 */
export const PROJECT_ID_PREFIX = 'proj-'

/** 内容优化要点上限（≤4 条，schema maxItems: 4 同步）。 */
export const MAX_PROJECT_HIGHLIGHTS = 4

export interface ContentBackfillResult {
  /** 补齐后的简历（无变化时为原引用不变）。 */
  resume: Resume
  /** 本次是否实际补了任何字段（id / highlights / sectionOrder）。 */
  changed: boolean
}

/** 生成单个项目稳定 ID。 */
export function generateProjectId(): string {
  return `${PROJECT_ID_PREFIX}${randomUUID()}`
}

/** description → 要点起点：按行拆条、trim、过滤空行、≤4 条。 */
export function descriptionToHighlights(description: string | undefined): string[] | undefined {
  if (description === undefined) return undefined
  const lines = description
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, MAX_PROJECT_HIGHLIGHTS)
  return lines.length > 0 ? lines : undefined
}

/** 由既有模块顺序推断 sectionOrder：默认顺序中该简历实际存在的节。 */
export function inferSectionOrder(resume: Resume): ResumeSectionKey[] {
  return DEFAULT_SECTION_ORDER.filter((section) => hasSectionContent(resume, section))
}

/** 该节是否有内容（空数组/空串/空对象视为无）。 */
function hasSectionContent(resume: Resume, section: ResumeSectionKey): boolean {
  const value = (resume as unknown as Record<string, unknown>)[section]
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value !== ''
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0
  return false
}

/** 补齐单个项目：id 缺失生成、highlights 缺失由 description 迁移。 */
function backfillProject(project: ResumeProject): { project: ResumeProject; changed: boolean } {
  let next = project
  let didChange = false
  if (next.id === undefined || next.id === '') {
    next = { ...next, id: generateProjectId() }
    didChange = true
  }
  if (next.highlights === undefined || next.highlights.length === 0) {
    // 空数组（schema 合法）视作未补齐：仍由 description 迁移；description 为空时 descriptionToHighlights 返回 undefined，保持幂等
    const highlights = descriptionToHighlights(next.description)
    if (highlights !== undefined) {
      next = { ...next, highlights }
      didChange = true
    }
  }
  return { project: next, changed: didChange }
}

/** 内容优化数据补齐（幂等；无缺失字段时返回原引用与 changed=false）。 */
export function backfillContentOptimizationData(resume: Resume): ContentBackfillResult {
  let changed = false
  let next = resume

  // 项目补齐
  if ((resume.projects ?? []).length > 0) {
    const projects: ResumeProject[] = (resume.projects ?? []).map((p) => {
      const result = backfillProject(p)
      if (result.changed) changed = true
      return result.project
    })
    if (changed) next = { ...next, projects }
  }

  // sectionOrder 补齐：缺省 → 由既有顺序推断
  if ((resume.sectionOrder ?? []).length === 0) {
    const inferred = inferSectionOrder(resume)
    if (inferred.length > 0) {
      changed = true
      next = { ...next, sectionOrder: inferred }
    }
  }

  return { resume: next, changed }
}
