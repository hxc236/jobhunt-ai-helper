import type {
  ContentDiagnosis,
  ContentProjectVerdict,
  ContentRuleStatus,
  ContentRuleVerdict
} from '@shared/types'
import { CONTENT_PROJECT_TARGET_PREFIX, CONTENT_RULE_NAMES } from '@shared/types'

/**
 * 内容优化规则判定展示（T03/#93）：任务卡片诊断区渲染辅助（纯函数模块）。
 * - 状态/判定中文标签（单一来源，规则名来自 shared CONTENT_RULE_NAMES）；
 * - 规则按作用对象分组：项目规则（project:<id>）vs 全局规则（global / section:order）。
 */

/** 维度状态标签（通过 / 需改进 / 信息不足 / 不适用）。 */
export const RULE_STATUS_LABELS: Record<ContentRuleStatus, string> = {
  pass: '通过',
  improve: '需改进',
  insufficient: '信息不足',
  na: '不适用'
}

/** 项目判定标签（保持 / 可直接改写 / 需要补充信息）。 */
export const PROJECT_VERDICT_LABELS: Record<ContentProjectVerdict, string> = {
  keep: '保持',
  rewrite: '可直接改写',
  'needs-info': '需要补充信息'
}

/** 事实来源标签（原文 / 用户回答 / 推断-待确认）。 */
export const FACT_SOURCE_LABELS: Record<ContentRuleVerdict['factSource'], string> = {
  original: '原文',
  'user-answer': '用户回答',
  inferred: '推断-待确认'
}

/** 规则 ID → 中文名（来自 shared CONTENT_RULE_NAMES）；未知规则回退原 ID。 */
export function ruleName(ruleId: string): string {
  return CONTENT_RULE_NAMES[ruleId] ?? ruleId
}

/** 项目级规则（target=`project:<id>`）。 */
export function isProjectRule(rule: ContentRuleVerdict): boolean {
  return rule.target.startsWith(CONTENT_PROJECT_TARGET_PREFIX)
}

/** 全局规则（target=`global` / `section:order`）。 */
export function isGlobalRule(rule: ContentRuleVerdict): boolean {
  return !isProjectRule(rule)
}

/** 项目判定；诊断中没有该项目时返回 undefined。 */
export function projectVerdictFor(
  diagnosis: ContentDiagnosis,
  projectId: string
): ContentProjectVerdict | undefined {
  return diagnosis.projects.find((p) => p.projectId === projectId)?.verdict
}

/** 某项目的规则条目（按 ruleId 稳定排序）。 */
export function projectRules(diagnosis: ContentDiagnosis, projectId: string): ContentRuleVerdict[] {
  return diagnosis.rules
    .filter((r) => r.target === `${CONTENT_PROJECT_TARGET_PREFIX}${projectId}`)
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
}

/** 全局规则条目（R2 可读性 / R3 实习前置，按 ruleId 稳定排序）。 */
export function globalRules(diagnosis: ContentDiagnosis): ContentRuleVerdict[] {
  return diagnosis.rules.filter(isGlobalRule).sort((a, b) => a.ruleId.localeCompare(b.ruleId))
}
