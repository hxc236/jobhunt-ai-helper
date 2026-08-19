import type { ContentQuestion } from './types'

/**
 * #90/T04 追问回答编码（shared：主进程校验与渲染层表单共用，单一来源）。
 *
 * answers 记录为 `Record<questionId, string>`。除了文本答案，还需表达
 * 「明确处置但无文本」的两类情形——不属实 / 无法补充——用哨兵值区分，
 * 与「未答（键缺失）」语义不同：
 * - 未答：answers 中无该键（改写轮可继续追问/标记待确认）；
 * - 不属实 / 无法补充：answers 中该键 = 哨兵（用户已明确处置）。
 */

/** 「不属实」哨兵（写进 answers 的值，同时自解释地出现在改写轮提示词中）。 */
export const CONTENT_ANSWER_DENIED = '[不属实]'

/** 「无法补充」哨兵（写进 answers 的值，同时自解释地出现在改写轮提示词中）。 */
export const CONTENT_ANSWER_CANNOT = '[无法补充]'

/** 追问问题稳定键：优先显式 id，缺失时按诊断内序号派生（诊断已持久化，键在任务内稳定）。 */
export function contentQuestionKey(question: ContentQuestion, index: number): string {
  return question.id !== undefined && question.id !== '' ? question.id : `q${index}`
}

/** 追问问题已知键集（服务端 submitAnswers 校验、渲染层提交共用）。 */
export function contentQuestionKeys(questions: ContentQuestion[]): string[] {
  return questions.map((q, i) => contentQuestionKey(q, i))
}
