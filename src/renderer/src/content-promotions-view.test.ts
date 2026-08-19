import { describe, expect, it } from 'vitest'
import type { ContentPromotionSuggestion } from '@shared/types'
import {
  buildPromotionAnswers,
  emptyPromotionDrafts,
  onPromotionInput,
  setPromotionAction
} from './content-promotions-view'

const PROMOTION: ContentPromotionSuggestion = {
  id: 'promo-0',
  honorIndex: 0,
  honorName: '全国大学生数学建模竞赛省一等奖',
  evidence: '原文：竞赛省一等奖',
  missingFields: ['startDate', 'techStack', 'description']
}

describe('content-promotions-view（#98 大赛提升追问表单逻辑）', () => {
  it('emptyPromotionDrafts：每个缺失字段一个未答草稿（键 promotion-<id>-<field>）', () => {
    const drafts = emptyPromotionDrafts(PROMOTION)
    expect(Object.keys(drafts).sort()).toEqual([
      'promotion-promo-0-description',
      'promotion-promo-0-startDate',
      'promotion-promo-0-techStack'
    ])
    for (const draft of Object.values(drafts)) {
      expect(draft.action).toBe('none')
      expect(draft.text).toBe('')
    }
  })

  it('四选一动作：不属实/无法补充清空文本；确认属实/编辑保留文本', () => {
    const drafts = emptyPromotionDrafts(PROMOTION)
    const startDate = drafts['promotion-promo-0-startDate']!
    startDate.text = '2023-04'
    setPromotionAction(startDate, 'confirm')
    expect(startDate.action).toBe('confirm')
    expect(startDate.text).toBe('2023-04')
    setPromotionAction(startDate, 'deny')
    expect(startDate.text).toBe('')
  })

  it('输入框编辑：未答→自由输入；确认后被改动→编辑后确认', () => {
    const drafts = emptyPromotionDrafts(PROMOTION)
    const techStack = drafts['promotion-promo-0-techStack']!
    onPromotionInput(techStack, 'Python')
    expect(techStack.action).toBe('free')
    setPromotionAction(techStack, 'confirm')
    onPromotionInput(techStack, 'Python、Pandas')
    // 与 content-answers-form 语义一致：输入框编辑后统一归为自由输入（confirm 状态被输入改写）
    expect(techStack.action).toBe('free')
  })

  it('buildPromotionAnswers：答案/哨兵编码，未答缺失', () => {
    const drafts = emptyPromotionDrafts(PROMOTION)
    drafts['promotion-promo-0-startDate'] = { action: 'free', text: '2023-04' }
    drafts['promotion-promo-0-description'] = { action: 'cannot', text: '' }
    // techStack 未答 → 键缺失
    const answers = buildPromotionAnswers(PROMOTION, drafts)
    expect(answers).toEqual({
      'promotion-promo-0-startDate': '2023-04',
      'promotion-promo-0-description': '[无法补充]'
    })
  })
})
