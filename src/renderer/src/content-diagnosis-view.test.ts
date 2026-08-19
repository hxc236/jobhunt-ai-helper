import { describe, expect, it } from 'vitest'
import {
  RULE_STATUS_LABELS,
  PROJECT_VERDICT_LABELS,
  FACT_SOURCE_LABELS,
  ruleName,
  isProjectRule,
  isGlobalRule,
  projectVerdictFor,
  projectRules,
  globalRules
} from './content-diagnosis-view'
import type { ContentDiagnosis } from '@shared/types'

const DIAGNOSIS: ContentDiagnosis = {
  rules: [
    { ruleId: 'R1', target: 'project:proj-1', status: 'improve', evidence: 'e1', issue: 'i1', suggestion: 's1', factSource: 'original' },
    { ruleId: 'R2', target: 'global', status: 'improve', evidence: 'e2', issue: 'i2', suggestion: 's2', factSource: 'original' },
    { ruleId: 'R3', target: 'section:order', status: 'pass', evidence: 'e3', issue: '', suggestion: '', factSource: 'original' },
    { ruleId: 'R4-简介', target: 'project:proj-2', status: 'insufficient', evidence: 'e4', issue: 'i4', suggestion: 's4', factSource: 'original' }
  ],
  projects: [
    { projectId: 'proj-1', verdict: 'rewrite' },
    { projectId: 'proj-2', verdict: 'needs-info' }
  ],
  questions: []
}

describe('content-diagnosis-view（#93 任务卡片判定展示辅助）', () => {
  it('状态与判定中文标签', () => {
    expect(RULE_STATUS_LABELS).toEqual({
      pass: '通过',
      improve: '需改进',
      insufficient: '信息不足',
      na: '不适用'
    })
    expect(PROJECT_VERDICT_LABELS).toEqual({
      keep: '保持',
      rewrite: '可直接改写',
      'needs-info': '需要补充信息'
    })
  })

  it('FACT_SOURCE_LABELS：事实来源中文标签（原文 / 用户回答 / 推断-待确认）', () => {
    expect(FACT_SOURCE_LABELS).toEqual({
      original: '原文',
      'user-answer': '用户回答',
      inferred: '推断-待确认'
    })
  })

  it('ruleName：已知规则给中文名，未知回退 ruleId', () => {
    expect(ruleName('R1')).toContain('含金量')
    expect(ruleName('R2')).toContain('全局')
    expect(ruleName('R4-结果')).toContain('结果')
    expect(ruleName('R9')).toBe('R9')
  })

  it('isProjectRule / isGlobalRule：project:<id> 为项目规则，global/section:order 为全局规则', () => {
    const r1 = DIAGNOSIS.rules[0]!
    const r2 = DIAGNOSIS.rules[1]!
    const r3 = DIAGNOSIS.rules[2]!
    expect(isProjectRule(r1)).toBe(true)
    expect(isProjectRule(r2)).toBe(false)
    expect(isProjectRule(r3)).toBe(false)
    expect(isGlobalRule(r1)).toBe(false)
    expect(isGlobalRule(r2)).toBe(true)
    expect(isGlobalRule(r3)).toBe(true)
  })

  it('projectVerdictFor 按项目查判定', () => {
    expect(projectVerdictFor(DIAGNOSIS, 'proj-1')).toBe('rewrite')
    expect(projectVerdictFor(DIAGNOSIS, 'proj-2')).toBe('needs-info')
    expect(projectVerdictFor(DIAGNOSIS, 'proj-missing')).toBeUndefined()
  })

  it('projectRules 只含该项目规则；globalRules 含全局规则', () => {
    expect(projectRules(DIAGNOSIS, 'proj-1').map((r) => r.ruleId)).toEqual(['R1'])
    expect(projectRules(DIAGNOSIS, 'proj-2').map((r) => r.ruleId)).toEqual(['R4-简介'])
    expect(globalRules(DIAGNOSIS).map((r) => r.ruleId)).toEqual(['R2', 'R3'])
  })

  it('空诊断 → 空分组', () => {
    expect(projectRules({ rules: [], projects: [], questions: [] }, 'proj-1')).toEqual([])
    expect(globalRules({ rules: [], projects: [], questions: [] })).toEqual([])
  })
})
