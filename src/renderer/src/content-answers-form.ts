import {
  CONTENT_ANSWER_CANNOT,
  CONTENT_ANSWER_DENIED,
  contentQuestionKey
} from '@shared/content-answers'
import type { ContentQuestion } from '@shared/types'

/**
 * 追问批量问答表单逻辑（#94/T04：分组/候选/四选一/自由输入/跳过）。
 *
 * 纯函数模块（与 content-diagnosis-view 同模式），供 ResumesView 任务卡片
 * awaiting_answers 状态渲染与提交编码使用：
 * - 每题一个 AnswerDraft（动作 + 所选候选 + 文本）；
 * - 四选一 = 确认属实 / 编辑后确认 / 不属实 / 无法补充，自由输入独立；
 * - answers 记录统一为 `Record<questionKey, string>`：不属实/无法补充写哨兵值，
 *   未答 = 键缺失（与 T02 submitAnswers 契约一致）。
 */

/** 每题处置动作：none=未答；confirm/edit/deny/cannot=四选一；free=自由输入。 */
export type AnswerAction = 'none' | 'confirm' | 'edit' | 'deny' | 'cannot' | 'free'

/** 四选一 + 自由输入 操作按钮标签。 */
export const ANSWER_ACTION_LABELS: Record<Exclude<AnswerAction, 'none'>, string> = {
  confirm: '确认属实',
  edit: '编辑后确认',
  deny: '不属实',
  cannot: '无法补充',
  free: '自由输入'
}

/** 单题草稿（组件内受控状态）。 */
export interface AnswerDraft {
  action: AnswerAction
  /** 所选候选下标（confirm 用；默认第一个）。 */
  candidateIndex: number
  /** 自由输入/编辑后的文本。 */
  text: string
}

/** 每题生成一个未答草稿。 */
export function emptyDrafts(questions: ContentQuestion[]): Record<string, AnswerDraft> {
  const drafts: Record<string, AnswerDraft> = {}
  questions.forEach((q, i) => {
    drafts[contentQuestionKey(q, i)] = { action: 'none', candidateIndex: 0, text: '' }
  })
  return drafts
}

/** 选中候选 = 确认属实（答案=候选原文）。 */
export function applyCandidate(draft: AnswerDraft, question: ContentQuestion, candidateIndex: number): void {
  draft.action = 'confirm'
  draft.candidateIndex = candidateIndex
  const candidate = question.candidates[candidateIndex]
  draft.text = candidate ?? ''
}

/** 切换动作（编辑/自由输入沿用文本；不属实/无法补充清空文本；确认属实取所选候选）。 */
export function setAnswerAction(
  draft: AnswerDraft,
  action: Exclude<AnswerAction, 'none'>,
  question: ContentQuestion
): void {
  draft.action = action
  if (action === 'deny' || action === 'cannot') {
    draft.text = ''
  } else if (action === 'confirm') {
    const candidate = question.candidates[draft.candidateIndex]
    draft.text = candidate ?? ''
  }
  // edit / free：保留现有文本，由输入框继续编辑
}

/** 单题提交值：null = 未答（不写入 answers）。 */
export function draftAnswerText(draft: AnswerDraft, question: ContentQuestion): string | null {
  switch (draft.action) {
    case 'confirm': {
      const candidate = question.candidates[draft.candidateIndex]
      return candidate !== undefined && candidate !== '' ? candidate : null
    }
    case 'edit':
    case 'free': {
      const text = draft.text.trim()
      return text !== '' ? text : null
    }
    case 'deny':
      return CONTENT_ANSWER_DENIED
    case 'cannot':
      return CONTENT_ANSWER_CANNOT
    default:
      return null
  }
}

/** 计数：Y=问题总数；X=有答案或有明确处置（不属实/无法补充）的题数；N=Y-X。 */
export function answerCounts(
  drafts: Record<string, AnswerDraft>,
  questions: ContentQuestion[]
): { answered: number; total: number; unanswered: number } {
  const total = questions.length
  let answered = 0
  questions.forEach((q, i) => {
    const draft = drafts[contentQuestionKey(q, i)]
    if (draft !== undefined && draftAnswerText(draft, q) !== null) answered += 1
  })
  return { answered, total, unanswered: total - answered }
}

/** 构建提交用 answers 记录（questionKey → 答案文本 / 哨兵；未答缺失）。 */
export function buildAnswersRecord(
  questions: ContentQuestion[],
  drafts: Record<string, AnswerDraft>
): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => {
    const key = contentQuestionKey(q, i)
    const draft = drafts[key]
    if (draft === undefined) return
    const text = draftAnswerText(draft, q)
    if (text !== null) answers[key] = text
  })
  return answers
}
