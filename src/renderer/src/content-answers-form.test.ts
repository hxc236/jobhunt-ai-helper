import { describe, expect, it } from 'vitest'
import {
  ANSWER_ACTION_LABELS,
  answerCounts,
  applyCandidate,
  buildAnswersRecord,
  draftAnswerText,
  emptyDrafts,
  setAnswerAction,
  type AnswerDraft
} from './content-answers-form'
import {
  CONTENT_ANSWER_CANNOT,
  CONTENT_ANSWER_DENIED,
  contentQuestionKey,
  contentQuestionKeys
} from '@shared/content-answers'
import type { ContentQuestion } from '@shared/types'

const QUESTIONS: ContentQuestion[] = [
  {
    id: 'q1',
    projectId: 'proj-1',
    field: '难点',
    question: '项目最大的技术难点是什么？',
    evidence: '原文证据',
    candidates: ['分布式锁', '高并发压测']
  },
  {
    id: 'q2',
    projectId: 'proj-1',
    field: '结果',
    question: '项目最终达成了什么结果？',
    evidence: '原文未提及',
    candidates: ['接口 P95 < 200ms']
  },
  {
    id: 'q3',
    projectId: 'proj-2',
    field: '简介',
    question: '项目面向什么场景？',
    evidence: '无',
    candidates: []
  }
]

describe('content-answers-form（#94 追问批量问答表单逻辑）', () => {
  it('问题稳定键：优先显式 id，缺失时按序号派生（诊断持久化，任务内稳定）', () => {
    expect(contentQuestionKey(QUESTIONS[0]!, 0)).toBe('q1')
    expect(contentQuestionKey(QUESTIONS[1]!, 1)).toBe('q2')
    expect(contentQuestionKey({ projectId: 'p', field: 'f', question: 'q', evidence: '', candidates: [] }, 2)).toBe('q2')
    expect(contentQuestionKeys(QUESTIONS)).toEqual(['q1', 'q2', 'q3'])
  })

  it('emptyDrafts：每题一个未答草稿（action=none，候选默认第一个）', () => {
    const drafts = emptyDrafts(QUESTIONS)
    expect(Object.keys(drafts)).toEqual(['q1', 'q2', 'q3'])
    expect(drafts.q1).toEqual({ action: 'none', candidateIndex: 0, text: '' })
    expect(drafts.q2).toEqual({ action: 'none', candidateIndex: 0, text: '' })
    expect(drafts.q3).toEqual({ action: 'none', candidateIndex: 0, text: '' })
  })

  it('四选一 + 自由输入标签', () => {
    expect(ANSWER_ACTION_LABELS).toEqual({
      confirm: '确认属实',
      edit: '编辑后确认',
      deny: '不属实',
      cannot: '无法补充',
      free: '自由输入'
    })
  })

  it('确认属实 → 答案=所选候选原文', () => {
    const d: AnswerDraft = { action: 'none', candidateIndex: 0, text: '' }
    applyCandidate(d, QUESTIONS[0]!, 1)
    expect(d.action).toBe('confirm')
    expect(d.text).toBe('高并发压测')
    expect(draftAnswerText(d, QUESTIONS[0]!)).toBe('高并发压测')
  })

  it('确认属实但候选为空 → 视为未答', () => {
    const d: AnswerDraft = { action: 'confirm', candidateIndex: 0, text: '' }
    expect(draftAnswerText(d, QUESTIONS[2]!)).toBeNull()
  })

  it('编辑后确认 → 答案=编辑后的文本（trim）', () => {
    const d: AnswerDraft = { action: 'edit', candidateIndex: 0, text: '  双写一致性  ' }
    expect(draftAnswerText(d, QUESTIONS[0]!)).toBe('双写一致性')
  })

  it('编辑为空文本 → 视为未答', () => {
    const d: AnswerDraft = { action: 'edit', candidateIndex: 0, text: '   ' }
    expect(draftAnswerText(d, QUESTIONS[0]!)).toBeNull()
  })

  it('不属实 / 无法补充 → 哨兵值（与未答区分）', () => {
    const deny: AnswerDraft = { action: 'deny', candidateIndex: 0, text: '' }
    expect(draftAnswerText(deny, QUESTIONS[0]!)).toBe(CONTENT_ANSWER_DENIED)
    const cannot: AnswerDraft = { action: 'cannot', candidateIndex: 0, text: '' }
    expect(draftAnswerText(cannot, QUESTIONS[0]!)).toBe(CONTENT_ANSWER_CANNOT)
  })

  it('自由输入（none + 文本）→ 答案=输入文本', () => {
    const d: AnswerDraft = { action: 'none', candidateIndex: 0, text: '自研分库分表' }
    setAnswerAction(d, 'free', QUESTIONS[0]!)
    expect(d.action).toBe('free')
    expect(draftAnswerText(d, QUESTIONS[0]!)).toBe('自研分库分表')
  })

  it('确认后改为编辑（输入框改动候选）→ edit', () => {
    const d: AnswerDraft = { action: 'confirm', candidateIndex: 0, text: '分布式锁' }
    setAnswerAction(d, 'edit', QUESTIONS[0]!)
    expect(d.action).toBe('edit')
    expect(draftAnswerText(d, QUESTIONS[0]!)).toBe('分布式锁')
  })

  it('buildAnswersRecord：未答项缺失；确认/编辑/自由输入/哨兵按键入记录', () => {
    const drafts: Record<string, AnswerDraft> = {
      q1: { action: 'none', candidateIndex: 0, text: '' }, // 未答 → 缺失
      q2: { action: 'confirm', candidateIndex: 0, text: '接口 P95 < 200ms' },
      q3: { action: 'deny', candidateIndex: 0, text: '' } // 哨兵
    }
    const record = buildAnswersRecord(QUESTIONS, drafts)
    expect(record.q1).toBeUndefined()
    expect(record.q2).toBe('接口 P95 < 200ms')
    expect(record.q3).toBe(CONTENT_ANSWER_DENIED)
  })

  it('answerCounts：已答/未答统计（Y=问题总数；X=有答案或有明确处置）', () => {
    const drafts: Record<string, AnswerDraft> = {
      q1: { action: 'confirm', candidateIndex: 0, text: '分布式锁' },
      q2: { action: 'cannot', candidateIndex: 0, text: '' },
      q3: { action: 'none', candidateIndex: 0, text: '' }
    }
    const counts = answerCounts(drafts, QUESTIONS)
    expect(counts).toEqual({ answered: 2, total: 3, unanswered: 1 })
  })
})
