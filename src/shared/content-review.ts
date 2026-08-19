import type { Resume, ResumeProject } from './types/resume'
import type {
  ContentIntegrationSummary,
  ContentOptimizeChange,
  ContentProjectDecision,
  ContentRewrite
} from './types'

/**
 * #90/T06 内容优化「确认、对比与整合」纯函数（shared：主进程整合/门禁与渲染层确认区共用）。
 *
 * 业务①（内容优化）确认阶段，与按 JD 优化（业务②）完全分离：
 * - 按项目整体接受/拒绝改写（US15）——拒绝的项目保留原文；
 * - 删除建议（US18）——LLM 判定无可补充内容的项目建议删除，用户确认删除 / 拒绝保留原文+警告；
 * - 推断-待确认门禁（US17）——source=inferred 的改动需显式勾选后才进入最终版；
 * - 「仍有未解决项目」标记（US19）——改写被拒/失败的项目保留原文，最终版带标记；
 * - 无改动不建版本（US20）——最终稿与原文无差异时不创建新版本。
 */

/** 项目决策中文标签（接受改写 / 保留原文；删除建议语义见模块注释）。 */
export const CONTENT_DECISION_LABELS: Record<ContentProjectDecision, string> = {
  accept: '接受改写',
  reject: '保留原文'
}

/** 改动来源标签（原文 / 用户回答 / 推断-待确认）。 */
export const CHANGE_SOURCE_LABELS: Record<ContentOptimizeChange['source'], string> = {
  original: '原文',
  'user-answer': '用户回答',
  inferred: '推断-待确认'
}

/** 项目在改写稿中的状态：deleted=删除建议（原文有、改写稿无）；changed=已改写；unchanged=无改动。 */
export type ReviewProjectState = 'deleted' | 'changed' | 'unchanged'

/** 项目当前决策（缺省接受）。 */
export function projectDecision(
  decisions: Record<string, ContentProjectDecision> | null | undefined,
  projectId: string
): ContentProjectDecision {
  return decisions?.[projectId] ?? 'accept'
}

/** 改写稿中项目状态（无 id 项目视为 unchanged——无法按稳定 id 匹配，由改写稿整体承担）。 */
export function reviewProjectState(
  original: Resume,
  rewrite: ContentRewrite,
  projectId: string
): ReviewProjectState {
  const originalProject = (original.projects ?? []).find((p) => p.id === projectId)
  if (originalProject === undefined) return 'unchanged' // 新增项目（仅改写稿存在）
  const rewritten = (rewrite.resume.projects ?? []).find((p) => p.id === projectId)
  if (rewritten === undefined) return 'deleted'
  return normalizeText(projectText(originalProject)) === normalizeText(projectText(rewritten))
    ? 'unchanged'
    : 'changed'
}

/**
 * US17 门禁：待勾选的推断-待确认改动。
 * source=inferred 且其项目决策为接受（或被拒项目的改动不会进入最终版 → 无需勾选）
 * 且 id 未在已确认集合中。改动缺 id（不应发生，服务层统一分配）→ 保守视为待勾选。
 * 删除记录（改写稿中已无该项目）不算「新增事实」——删除的确认走项目决策
 * （确认删除/保留原文，US18），不参与推断勾选门禁。
 */
export function pendingInferredChanges(
  rewrite: ContentRewrite,
  decisions: Record<string, ContentProjectDecision> | null | undefined,
  confirmed: readonly string[] | null | undefined
): ContentOptimizeChange[] {
  const confirmedSet = new Set(confirmed ?? [])
  const rewrittenProjectIds = new Set(
    (rewrite.resume.projects ?? [])
      .map((p) => p.id)
      .filter((id): id is string => id !== undefined)
  )
  return (rewrite.changes ?? []).filter((change) => {
    if (change.source !== 'inferred') return false
    if (change.projectId !== undefined && !rewrittenProjectIds.has(change.projectId)) return false
    if (change.id !== undefined && confirmedSet.has(change.id)) return false
    if (change.projectId !== undefined && projectDecision(decisions, change.projectId) === 'reject') {
      return false
    }
    return true
  })
}

/**
 * 整合汇总（US15/18/19）：标点修复、排序调整、删除确认、保留原文警告、「仍有未解决项目」。
 * 纯函数（输入原文 + 改写稿 + 决策），服务端确认时与渲染层实时预览共用。
 */
export function buildIntegrationSummary(
  original: Resume,
  rewrite: ContentRewrite,
  decisions: Record<string, ContentProjectDecision> | null | undefined
): ContentIntegrationSummary {
  const punctuationFixed: string[] = []
  const deletedProjects: string[] = []
  const keptWithWarning: string[] = []
  const unresolvedProjects: string[] = []

  for (const project of original.projects ?? []) {
    const id = project.id
    if (id === undefined) continue
    const rewritten = (rewrite.resume.projects ?? []).find((p) => p.id === id)
    const decision = projectDecision(decisions, id)
    if (rewritten === undefined) {
      // 删除建议：接受=确认删除；拒绝=保留原文 + 警告
      if (decision === 'accept') deletedProjects.push(id)
      else keptWithWarning.push(id)
      continue
    }
    const originalText = projectText(project)
    const rewrittenText = projectText(rewritten)
    if (normalizeText(originalText) === normalizeText(rewrittenText)) {
      // 语义一致但原文有差异 → 标点/格式修复（R2）
      if (originalText !== rewrittenText) punctuationFixed.push(id)
      continue
    }
    if (decision === 'reject') unresolvedProjects.push(id)
  }

  const orderingAdjustments = detectOrderingAdjustments(original, rewrite)
  return { punctuationFixed, orderingAdjustments, deletedProjects, keptWithWarning, unresolvedProjects }
}

/**
 * 排序调整检测（R3 实习前置 / 模块顺序）：直接对比原文与改写稿的
 * sectionOrder 与 experience 相对顺序，不依赖 LLM 的 change 记录措辞。
 */
function detectOrderingAdjustments(original: Resume, rewrite: ContentRewrite): string[] {
  const adjustments: string[] = []
  const originalOrder = JSON.stringify(original.sectionOrder ?? [])
  const rewrittenOrder = JSON.stringify(rewrite.resume.sectionOrder ?? [])
  if (originalOrder !== rewrittenOrder) adjustments.push('模块顺序调整（sectionOrder）')
  const experienceKey = (r: Resume): string =>
    (r.experience ?? []).map((e) => `${e.company ?? ''}|${e.title ?? ''}`).join('>')
  if (experienceKey(original) !== experienceKey(rewrite.resume)) {
    adjustments.push('实习/经历顺序调整（R3 实习前置）')
  }
  return adjustments
}

/**
 * 最终简历 = 改写稿 + 按项目决策整合：
 * - 接受（accept）：采用改写稿版本；删除建议接受 = 确认删除（不进入最终稿）；
 * - 拒绝（reject）：该项目保留原文；删除建议拒绝 = 保留原文（+ 警告，见 summary）；
 * - 新增项目（改写稿独有）：随改写稿进入（有 change 记录，可溯源）；
 * - 非项目节（basics/education/experience/skills/honors/sectionOrder 等）整体采用改写稿。
 * 顺序：改写稿项目顺序保留（被拒项目在原位置替换为原文）；被保留的删除建议项目追加末尾。
 */
export function buildFinalResume(
  original: Resume,
  rewrite: ContentRewrite,
  decisions: Record<string, ContentProjectDecision> | null | undefined
): Resume {
  const rewritten = rewrite.resume
  const rewrittenProjects = rewritten.projects ?? []
  const originalById = new Map(
    (original.projects ?? [])
      .filter((p) => p.id !== undefined)
      .map((p) => [p.id!, p] as const)
  )

  const finalProjects: ResumeProject[] = []
  const seen = new Set<string>()
  for (const project of rewrittenProjects) {
    const id = project.id
    if (id !== undefined) {
      seen.add(id)
      const originalProject = originalById.get(id)
      if (originalProject !== undefined && projectDecision(decisions, id) === 'reject') {
        finalProjects.push(originalProject)
        continue
      }
    }
    finalProjects.push(project)
  }
  // 删除建议被拒 → 保留原文（追加末尾；原位置在改写稿中不存在）
  for (const project of original.projects ?? []) {
    const id = project.id
    if (id === undefined || seen.has(id)) continue
    if (projectDecision(decisions, id) === 'accept') continue // 确认删除
    finalProjects.push(project)
  }

  return { ...rewritten, projects: finalProjects }
}

/** 最终稿与原文是否实际不同（不含 meta：新版本标题/时间由服务端管理；供「无改动不建版本」判定）。 */
export function resumesDiffer(a: Resume, b: Resume): boolean {
  const stripMeta = (r: Resume): Omit<Resume, 'meta'> => {
    const { meta: _meta, ...rest } = r
    return rest
  }
  return JSON.stringify(stripMeta(a)) !== JSON.stringify(stripMeta(b))
}

/** 宽松归一（与 rewrite-engine.normalizeText 同实现；shared 层避免依赖 main）。 */
function normalizeText(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(
      /[，。、,.;；:：!！?？()（）「」『』【】\[\]{}"'“”‘’\u2010-\u2015—_/\\]/g,
      ''
    )
    .toLowerCase()
}

/** 项目文本扁平化（id/name/描述/要点/技术栈等全部文本，供语义一致比较）。 */
function projectText(project: ResumeProject): string {
  return flattenValue(project as unknown as Record<string, unknown>)
}

function flattenValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => flattenValue(item)).join('\n')
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).map((v) => flattenValue(v)).join('\n')
  }
  return ''
}
