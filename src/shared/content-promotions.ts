import type { ContentPromotionMissingField, ContentPromotionSuggestion } from './types'
import { CONTENT_ANSWER_CANNOT, CONTENT_ANSWER_DENIED } from './content-answers'

/**
 * #90/T08 大赛经历提升为项目（shared：主进程校验/落库与渲染层追问表单共用，单一来源）。
 *
 * 诊断引擎识别 honors 中像大赛/竞赛的条目并输出提升建议（ContentPromotionSuggestion）；
 * 用户确认提升时，缺失字段（时间/技术栈/描述）经追问补齐——回答编码与 T04 追问一致：
 * answers 为 `Record<questionKey, string>`，键 = `promotion-<建议id>-<字段>`；
 * 「不属实 / 无法补充」同样用哨兵值（不写入项目字段），与「未答（键缺失）」区分。
 */

/** 缺失字段中文标签（追问表单展示）。 */
export const PROMOTION_MISSING_FIELD_LABELS: Record<ContentPromotionMissingField, string> = {
  startDate: '开始时间',
  endDate: '结束时间',
  techStack: '技术栈',
  description: '项目描述'
}

/** 缺失字段是否合法。 */
export function isPromotionMissingField(value: unknown): value is ContentPromotionMissingField {
  return value === 'startDate' || value === 'endDate' || value === 'techStack' || value === 'description'
}

/** 提升追问稳定键：`promotion-<建议id>-<字段>`。 */
export function promotionQuestionKey(
  promotion: ContentPromotionSuggestion,
  field: ContentPromotionMissingField
): string {
  return `promotion-${promotion.id}-${field}`
}

/** 某提升建议的全部追问键。 */
export function promotionQuestionKeys(promotion: ContentPromotionSuggestion): string[] {
  return promotion.missingFields.map((field) => promotionQuestionKey(promotion, field))
}

/** 提升追问问题文本（表单展示）。 */
export function promotionQuestionText(
  promotion: ContentPromotionSuggestion,
  field: ContentPromotionMissingField
): string {
  return `大赛「${promotion.honorName}」的${PROMOTION_MISSING_FIELD_LABELS[field]}？`
}

/** 回答值是否哨兵（不属实/无法补充）——该类回答不写入项目字段。 */
export function isPromotionAnswerSentinel(value: string): boolean {
  return value === CONTENT_ANSWER_DENIED || value === CONTENT_ANSWER_CANNOT
}
