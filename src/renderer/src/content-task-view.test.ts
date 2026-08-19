import { describe, expect, it } from 'vitest'
import type { ContentOptimizeTask } from '@shared/types'
import { archiveSummaryFor } from './content-task-view'

function baseTask(): ContentOptimizeTask {
  return {
    id: 'cot-1',
    resumeId: 'res-1',
    status: 'confirmed',
    diagnosis: null,
    answers: null,
    rewrite: null,
    progress: '已确认',
    error: null,
    noChanges: false,
    decisions: null,
    inferredConfirmed: null,
    summary: null,
    createdResumeId: null,
    archivedAt: null,
    createdAt: 'now',
    updatedAt: 'now'
  }
}

describe('archiveSummaryFor（T07/#97 任务归档摘要）', () => {
  it('未归档（archivedAt=null）→ null', () => {
    expect(archiveSummaryFor(baseTask())).toBeNull()
  })

  it('已归档且生成新基准 → 「已归档 · 已生成新基准简历」', () => {
    const t = { ...baseTask(), archivedAt: '2026-08-20T00:00:00.000Z', createdResumeId: 'res-new' }
    expect(archiveSummaryFor(t)).toBe('已归档 · 已生成新基准简历')
  })

  it('已归档且 noChanges（空诊断）→ 「已归档 · 无需修改，未创建新版本」', () => {
    const t = { ...baseTask(), archivedAt: '2026-08-20T00:00:00.000Z', noChanges: true }
    expect(archiveSummaryFor(t)).toBe('已归档 · 无需修改，未创建新版本')
  })

  it('已归档且未应用改动（全部拒绝）→ 「已归档 · 未应用改动，未创建新版本」', () => {
    const t = {
      ...baseTask(),
      archivedAt: '2026-08-20T00:00:00.000Z',
      progress: '已确认（未应用改动）'
    }
    expect(archiveSummaryFor(t)).toBe('已归档 · 未应用改动，未创建新版本')
  })
})
