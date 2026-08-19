import type { ContentOptimizeTask } from '@shared/types'

/**
 * T07/#97：已归档任务摘要（确认后展示）。
 * - 已归档 = archivedAt 非空（确认即归档）；
 * - 有 createdResumeId → 已生成新基准简历（血缘）；
 * - noChanges → 无需修改，未创建新版本；
 * - 否则（全部拒绝/未应用改动，US20）→ 未应用改动，未创建新版本。
 * 非归档任务返回 null。
 */
export function archiveSummaryFor(task: ContentOptimizeTask): string | null {
  if (task.archivedAt === null || task.archivedAt === undefined) return null
  if (task.createdResumeId !== null && task.createdResumeId !== undefined) {
    return '已归档 · 已生成新基准简历'
  }
  if (task.noChanges) return '已归档 · 无需修改，未创建新版本'
  return '已归档 · 未应用改动，未创建新版本'
}
