import { describe, expect, it } from 'vitest'
import type { ContentOptimizeTask, ContentRewrite } from '@shared/types'
import type { Resume } from '@shared/types/resume'
import {
  emptyReviewDraft,
  isInferredConfirmed,
  nonProjectChanges,
  pendingInferredCount,
  reviewDecision,
  reviewGroups,
  setReviewDecision,
  toggleInferredConfirmed
} from './content-review-state'

const RESUME: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟' },
  education: [{ school: '北理工', degree: '本科', major: '计算机' }],
  projects: [
    { id: 'p1', name: '二手交易平台', description: 'C2C 二手交易系统', techStack: ['Java'] },
    { id: 'p2', name: '大赛作品', description: '智能推荐系统', techStack: ['Python'] }
  ]
}

function taskWithRewrite(rewrite: ContentRewrite, extra?: Partial<ContentOptimizeTask>): ContentOptimizeTask {
  return {
    id: 'cot-1',
    resumeId: 'res-1',
    status: 'ready_for_review',
    diagnosis: null,
    answers: null,
    rewrite,
    progress: '可确认',
    error: null,
    noChanges: false,
    decisions: null,
    inferredConfirmed: null,
    summary: null,
    createdResumeId: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  }
}

const REWRITE: ContentRewrite = {
  resume: {
    ...RESUME,
    projects: [
      { ...RESUME.projects![0], description: 'C2C 二手交易系统（含高并发难点）' },
      RESUME.projects![1]
    ]
  },
  changes: [
    { id: 'chg-0', projectId: 'p1', section: 'projects', before: 'C2C 二手交易系统', after: 'C2C 二手交易系统（含高并发难点）', reason: 'R1', source: 'user-answer' },
    { id: 'chg-1', projectId: 'p1', section: 'highlights', before: '', after: '高并发秒杀压测优化', reason: '（推断-待确认）', source: 'inferred' }
  ]
}

describe('content-review-state — 草稿与决策', () => {
  it('懒初始化：从任务已持久化决策恢复；缺省全部接受', () => {
    const draft = emptyReviewDraft(taskWithRewrite(REWRITE))
    expect(reviewDecision(draft, 'p1')).toBe('accept')
    expect(reviewDecision(draft, 'p2')).toBe('accept')

    const restored = emptyReviewDraft(
      taskWithRewrite(REWRITE, { decisions: { p1: 'reject' }, inferredConfirmed: ['chg-1'] })
    )
    expect(reviewDecision(restored, 'p1')).toBe('reject')
    expect(isInferredConfirmed(restored, 'chg-1')).toBe(true)
  })

  it('设置决策 / 切换勾选：新对象引用（响应式变更可检测）', () => {
    const draft = emptyReviewDraft(taskWithRewrite(REWRITE))
    setReviewDecision(draft, 'p1', 'reject')
    expect(reviewDecision(draft, 'p1')).toBe('reject')
    expect(draft.decisions).toEqual({ p1: 'reject' })

    toggleInferredConfirmed(draft, 'chg-1')
    expect(isInferredConfirmed(draft, 'chg-1')).toBe(true)
    toggleInferredConfirmed(draft, 'chg-1')
    expect(isInferredConfirmed(draft, 'chg-1')).toBe(false)
    toggleInferredConfirmed(draft, undefined) // 缺 id 保守不动
    expect(draft.inferredConfirmed).toEqual([])
  })
})

describe('content-review-state — 门禁计数与项目组', () => {
  it('待勾选计数：inferred 未勾选计 1；勾选后 0；被拒项目不计', () => {
    const draft = emptyReviewDraft(taskWithRewrite(REWRITE))
    expect(pendingInferredCount(taskWithRewrite(REWRITE), draft)).toBe(1)
    toggleInferredConfirmed(draft, 'chg-1')
    expect(pendingInferredCount(taskWithRewrite(REWRITE), draft)).toBe(0)

    const rejected = emptyReviewDraft(taskWithRewrite(REWRITE))
    setReviewDecision(rejected, 'p1', 'reject')
    expect(pendingInferredCount(taskWithRewrite(REWRITE), rejected)).toBe(0)
  })

  it('逐项目组：改写稿顺序 + 原文删除项追加；改动按项目归属', () => {
    const groups = reviewGroups(RESUME, taskWithRewrite(REWRITE))
    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'p2'])
    const p1 = groups.find((g) => g.projectId === 'p1')!
    expect(p1.state).toBe('changed')
    expect(p1.changes.map((c) => c.id)).toEqual(['chg-0', 'chg-1'])
    const p2 = groups.find((g) => g.projectId === 'p2')!
    expect(p2.state).toBe('unchanged')
  })

  it('删除建议：改写稿缺失项目以 state=deleted 追加（rewrittenProject 为空）', () => {
    const deletionRewrite: ContentRewrite = {
      resume: { ...RESUME, projects: [RESUME.projects![0]] },
      changes: [{ id: 'chg-d', projectId: 'p2', section: 'projects', before: '大赛作品', after: '（建议删除）', reason: '建议删除', source: 'original' }]
    }
    const groups = reviewGroups(RESUME, taskWithRewrite(deletionRewrite))
    const p2 = groups.find((g) => g.projectId === 'p2')!
    expect(p2.state).toBe('deleted')
    expect(p2.rewrittenProject).toBeUndefined()
    expect(p2.originalProject?.description).toBe('智能推荐系统')
  })

  it('无改写任务 → 空项目组、0 待勾选', () => {
    const noRewrite = taskWithRewrite(REWRITE, { rewrite: null })
    expect(reviewGroups(RESUME, noRewrite)).toEqual([])
    expect(pendingInferredCount(noRewrite, emptyReviewDraft(noRewrite))).toBe(0)
  })

  it('节级（非项目）改动：nonProjectChanges 返回无 projectId 改动；inferred 节级勾选后可解除门禁（防确认死锁）', () => {
    const sectionRewrite: ContentRewrite = {
      resume: { ...REWRITE.resume },
      changes: [
        { id: 'chg-sec-1', section: 'experience', before: '', after: '某公司 实习', reason: '（推断-待确认）', source: 'inferred' },
        { id: 'chg-sec-2', section: 'sectionOrder', before: 'a', after: 'b', reason: 'R3', source: 'original' }
      ]
    }
    const task = taskWithRewrite(sectionRewrite)
    const draft = emptyReviewDraft(task)
    // 非项目改动单独列出（项目组不含节级改动）
    expect(nonProjectChanges(task).map((c) => c.id)).toEqual(['chg-sec-1', 'chg-sec-2'])
    expect(reviewGroups(RESUME, task).flatMap((g) => g.changes.map((c) => c.id))).toEqual([])
    // 门禁：inferred 节级改动待勾选 → 勾选后解除
    expect(pendingInferredCount(task, draft)).toBe(1)
    toggleInferredConfirmed(draft, 'chg-sec-1')
    expect(isInferredConfirmed(draft, 'chg-sec-1')).toBe(true)
    expect(pendingInferredCount(task, draft)).toBe(0)
  })
})
