import type { ContentPromotionMissingField, ContentPromotionSuggestion } from '@shared/types'
import {
  CONTENT_ANSWER_CANNOT,
  CONTENT_ANSWER_DENIED
} from '@shared/content-answers'
import { promotionQuestionKey } from '@shared/content-promotions'
import type { AnswerAction } from './content-answers-form'

/**
 * 大赛提升追问表单逻辑（#98/T08：与 content-answers-form 同模式，纯函数模块）。
 *\n * 每张提升建议卡片列出缺失字段（开始时间/结束时间/技术栈/描述），\n * 复用四选一 + 自由输入语义（无候选）：确认属实 = 以当前输入为准；\n * 不属实/无法补充写哨兵（不写入项目字段）；answers 键 = promotion-<id>-<字段>。\n * 确认提升时把各字段草稿编码为提交 answers。
 */

/** 单字段提升回答草稿（复用 AnswerAction；无候选，candidateIndex 恒 0）。 */
export interface PromotionDraft {
  action: AnswerAction
  text: string
}

/** 每个缺失字段生成一个未答草稿。 */
export function emptyPromotionDrafts(promotion: ContentPromotionSuggestion): Record<string, PromotionDraft> {
  const drafts: Record<string, PromotionDraft> = {}
  promotion.missingFields.forEach((field) => {
    drafts[promotionQuestionKey(promotion, field)] = { action: 'none', text: '' }
  })
  return drafts
}

/** 四选一动作按钮（无候选：确认属实/编辑后确认以当前输入为准；不属实/无法补充清空文本）。 */
export function setPromotionAction(
  draft: PromotionDraft,
  action: Exclude<AnswerAction, 'none'>
): void {
  draft.action = action
  if (action === 'deny' || action === 'cannot') draft.text = ''
  // confirm / edit / free：保留现有文本，由输入框继续编辑
}

/** 输入框编辑：未答→自由输入；确认候选后被改动→编辑后确认。 */
export function onPromotionInput(draft: PromotionDraft, text: string): void {
  draft.text = text
  if (draft.action === 'none' || draft.action === 'confirm') draft.action = 'free'
}

/** 单字段提交值：null = 未答（不写入 answers）；哨兵 = 明确处置。 */
export function promotionDraftAnswer(
  draft: PromotionDraft,
  _field: ContentPromotionMissingField
): string | null {
  switch (draft.action) {
    case 'confirm':
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

/** 构建提交 answers（promotion-<id>-<字段> → 答案/哨兵；未答缺失）。 */
export function buildPromotionAnswers(
  promotion: ContentPromotionSuggestion,
  drafts: Record<string, PromotionDraft>
): Record<string, string> {
  const answers: Record<string, string> = {}
  promotion.missingFields.forEach((field) => {
    const key = promotionQuestionKey(promotion, field)
    const draft = drafts[key]
    if (draft === undefined) return
    const value = promotionDraftAnswer(draft, field)
    if (value !== null) answers[key] = value
  })
  return answers
}
