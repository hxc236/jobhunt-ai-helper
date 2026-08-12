import type { Resume } from '@shared/types/resume'
import type { OptimizeChange } from '@shared/types'

/**
 * 优化稿对比确认（F-20/#34）：纯函数模块。
 * - diffResumeSections：基准 vs 优化稿 按节对比（JSON 深度相等），输出改动节 + 理由
 *   （从 changes[] 按节名匹配；changes 未覆盖的改动节 reason 为空）——「对比视图高亮正确」依据；
 * - buildDerivedResume：确认入库的派生稿（meta.baseResumeId/targetJobId 关联职位卡）。
 */

export interface SectionDiff {
  section: string
  changed: boolean
  reason?: string
}

/** 参与对比的简历节（顺序即展示顺序）。 */
const SECTIONS = [
  'basics',
  'education',
  'skills',
  'projects',
  'experience',
  'certificates',
  'selfAssessment'
] as const

export function diffResumeSections(base: Resume, optimized: Resume, changes: OptimizeChange[]): SectionDiff[] {
  const reasonBySection = new Map<string, string>()
  for (const c of changes) {
    if (!reasonBySection.has(c.section)) reasonBySection.set(c.section, c.reason)
  }
  return SECTIONS.map((section) => {
    const before = (base as unknown as Record<string, unknown>)[section]
    const after = (optimized as unknown as Record<string, unknown>)[section]
    const changed = JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)
    return { section, changed, reason: changed ? reasonBySection.get(section) : undefined }
  })
}

/** 确认入库的派生稿：meta.baseResumeId/targetJobId 关联，title 可指定（缺省 基准名+职位名）。 */
export function buildDerivedResume(
  baseResumeId: string,
  targetJobId: string,
  optimizedResume: Resume,
  title: string,
  baseTitle?: string
): Resume {
  return {
    ...optimizedResume,
    meta: {
      ...optimizedResume.meta,
      title: title.trim() !== '' ? title.trim() : `${baseTitle ?? '优化稿'}-${targetJobId.slice(0, 8)}`,
      baseResumeId,
      targetJobId
    }
  }
}
