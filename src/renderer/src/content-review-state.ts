import type { Resume, ResumeProject } from '@shared/types/resume'
import type {
  ContentOptimizeChange,
  ContentOptimizeTask,
  ContentProjectDecision
} from '@shared/types'
import {
  pendingInferredChanges,
  projectDecision,
  reviewProjectState,
  type ReviewProjectState
} from '@shared/content-review'

/**
 * 内容优化确认区草稿状态（T06/#96）：按项目接受/拒绝 + 推断-待确认勾选。
 *
 * 纯函数模块（与 content-answers-form / content-diagnosis-view 同模式），
 * 供 ResumesView 任务卡片 ready_for_review 状态渲染使用：
 * - 决策缺省全部接受（与 shared content-review.projectDecision 一致）；
 * - 草稿懒初始化：从任务已持久化的 decisions / inferredConfirmed 恢复
 *   （确认决策已落库，应用重启/任务卡刷新后不丢）；
 * - 改动即调 setReview 持久化（IPC），确认时服务端再强制校验门禁。
 */

/** 单项目确认组（渲染层逐项目对比/接受拒绝用）。 */
export interface ReviewProjectGroup {
  projectId: string
  state: ReviewProjectState
  /** 原文版本（删除建议/被拒时展示原文依据）。 */
  originalProject: ResumeProject | undefined
  /** 改写稿版本（删除建议时为空）。 */
  rewrittenProject: ResumeProject | undefined
  /** 该项目相关改动（含新增项目）。 */
  changes: ContentOptimizeChange[]
}

/** 按任务 id 的确认草稿。 */
export interface ReviewDraft {
  decisions: Record<string, ContentProjectDecision>
  inferredConfirmed: string[]
}

/** 懒初始化：从任务已持久化决策恢复；缺省全部接受。 */
export function emptyReviewDraft(task: ContentOptimizeTask): ReviewDraft {
  return {
    decisions: { ...(task.decisions ?? {}) },
    inferredConfirmed: [...(task.inferredConfirmed ?? [])]
  }
}

/** 项目当前决策（草稿内；缺省接受）。 */
export function reviewDecision(draft: ReviewDraft, projectId: string): ContentProjectDecision {
  return projectDecision(draft.decisions, projectId)
}

/** 设置项目决策（接受改写 / 保留原文；删除建议：接受=确认删除，拒绝=保留原文）。 */
export function setReviewDecision(
  draft: ReviewDraft,
  projectId: string,
  decision: ContentProjectDecision
): void {
  draft.decisions = { ...draft.decisions, [projectId]: decision }
}

/** 推断-待确认改动是否已勾选。 */
export function isInferredConfirmed(draft: ReviewDraft, changeId: string | undefined): boolean {
  return changeId !== undefined && draft.inferredConfirmed.includes(changeId)
}

/** 切换推断-待确认改动勾选。 */
export function toggleInferredConfirmed(draft: ReviewDraft, changeId: string | undefined): void {
  if (changeId === undefined) return
  if (draft.inferredConfirmed.includes(changeId)) {
    draft.inferredConfirmed = draft.inferredConfirmed.filter((id) => id !== changeId)
  } else {
    draft.inferredConfirmed = [...draft.inferredConfirmed, changeId]
  }
}

/** 待勾选的推断-待确认改动总数（确认按钮禁用/提示用）。 */
export function pendingInferredCount(task: ContentOptimizeTask, draft: ReviewDraft): number {
  if (task.rewrite === null) return 0
  return pendingInferredChanges(task.rewrite, draft.decisions, draft.inferredConfirmed).length
}

/**
 * 节级（非项目）改动：无 projectId 的 change（sectionOrder/experience 等节整体改动）。
 * 与项目组分开展示（「其他改动」区）；inferred 节级改动也需勾选后才能确认
 * （#96 review 修复：此前节级 inferred 改动被门禁计数但无勾选入口 → 确认死锁）。
 */
export function nonProjectChanges(task: ContentOptimizeTask): ContentOptimizeChange[] {
  if (task.rewrite === null) return []
  return (task.rewrite.changes ?? []).filter((c) => c.projectId === undefined)
}

/**
 * 逐项目确认组（原文 ∪ 改写稿，按改写稿顺序；被删除项目追加末尾）。
 * 新增项目（仅改写稿存在）也列出（state=unchanged），其改动随组展示。
 */
export function reviewGroups(
  original: Resume | undefined,
  task: ContentOptimizeTask
): ReviewProjectGroup[] {
  if (task.rewrite === null) return []
  const originalProjects = original?.projects ?? []
  const rewrittenProjects = task.rewrite.resume.projects ?? []
  const groups: ReviewProjectGroup[] = []
  const seen = new Set<string>()

  const changesByProject = new Map<string, ContentOptimizeChange[]>()
  for (const change of task.rewrite.changes ?? []) {
    if (change.projectId === undefined) continue
    const list = changesByProject.get(change.projectId) ?? []
    list.push(change)
    changesByProject.set(change.projectId, list)
  }

  for (const project of rewrittenProjects) {
    if (project.id === undefined) continue
    seen.add(project.id)
    groups.push({
      projectId: project.id,
      state: reviewProjectState(original ?? EMPTY_RESUME, task.rewrite, project.id),
      originalProject: originalProjects.find((p) => p.id === project.id),
      rewrittenProject: project,
      changes: changesByProject.get(project.id) ?? []
    })
  }
  for (const project of originalProjects) {
    if (project.id === undefined || seen.has(project.id)) continue
    groups.push({
      projectId: project.id,
      state: reviewProjectState(original ?? EMPTY_RESUME, task.rewrite, project.id),
      originalProject: project,
      rewrittenProject: undefined,
      changes: changesByProject.get(project.id) ?? []
    })
  }
  return groups
}

/** 原文缺失时的兜底空简历（无项目：删除/新增判定退化为改写稿视角）。 */
const EMPTY_RESUME: Resume = {
  meta: {},
  basics: { name: '' },
  education: [],
  projects: []
}
