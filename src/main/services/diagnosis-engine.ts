import type { Resume } from '../../shared/types/resume'
import type {
  ContentDiagnosis,
  ContentProjectVerdict,
  ContentPromotionSuggestion,
  ContentRuleStatus,
  ContentRuleVerdict
} from '../../shared/types'
import {
  CONTENT_PROJECT_TARGET_PREFIX,
  CONTENT_RULE_NAMES
} from '../../shared/types'
import { isPromotionMissingField } from '../../shared/content-promotions'
import { extractJson } from './optimize'

/**
 * 内容优化规则诊断引擎（T03/#93）。
 *
 * 业务①（内容优化）规则集——面向应届生、中文简历、不依赖 JD/岗位方向；
 * 与按 JD 优化（业务②）完全分离。大赛经历归属项目经历（T08/#98 再提升为独立项目）。
 *
 * 规则矩阵（每条判定 = ruleId / target / status / evidence / issue / suggestion / factSource）：
 * - R1 含金量：项目是否写清难点与解决行动（每项目一条，target=`project:<id>`）
 * - R2 全局可读性：标点 / 结构化拆解（≤4 条要点）/ 突出重点 / 可读性（全局一条，target=`global`）
 * - R3 实习前置：实习经历无条件排在项目/大赛之前（相对顺序，target=`section:order`；无实习或仅一条实习 → na）
 * - R4 四要素 + 结果（每项目每维度一条，target=`project:<id>`）：
 *     R4-简介：解决问题 / 面向场景 / 目标用户
 *     R4-难点：业务/技术难点，含具体目标与约束
 *     R4-工作量：本人边界 / 关键行动 / 方案选择 / 可归因成果
 *     R4-结果：交付 / 验证 / 证据等级
 *     R4-技术栈：技术栈真实
 *
 * 一致性约束（防 LLM 前后矛盾）：项目判定由该项目规则状态推导——
 *   insufficient → needs-info（最高优先级）；improve → rewrite；否则 keep。
 * LLM 返回的项目判定仅在该项目没有任何规则条目时兜底采用。
 *
 * 边界：不做岗位相关性判断；不输出总分/等级。
 *
 * 大赛提升（T08/#98）：honors 中像大赛/竞赛的条目（含 大赛/竞赛/挑战赛/比赛/杯/赛 等字样
 * 或描述为参赛获奖）可提升为项目——诊断输出 promotions 建议（honorIndex/honorName/evidence/缺失字段），
 * 由用户在追问环节确认并补齐缺失字段后提升为项目，再按项目规则参与诊断与改写。
 */

/** 规则矩阵定义（提示词与 UI 展示共用规则名，单一来源 CONTENT_RULE_NAMES）。 */
export const CONTENT_RULE_DEFINITIONS: ReadonlyArray<{
  ruleId: string
  /** 中文名（含规则范围说明）。 */
  name: string
  /** project = 每项目一条（target project:<id>）；global = 全局一条。 */
  scope: 'project' | 'global'
}> = [
  { ruleId: 'R1', name: CONTENT_RULE_NAMES['R1'], scope: 'project' },
  { ruleId: 'R2', name: CONTENT_RULE_NAMES['R2'], scope: 'global' },
  { ruleId: 'R3', name: CONTENT_RULE_NAMES['R3'], scope: 'global' },
  { ruleId: 'R4-简介', name: CONTENT_RULE_NAMES['R4-简介'], scope: 'project' },
  { ruleId: 'R4-难点', name: CONTENT_RULE_NAMES['R4-难点'], scope: 'project' },
  { ruleId: 'R4-工作量', name: CONTENT_RULE_NAMES['R4-工作量'], scope: 'project' },
  { ruleId: 'R4-结果', name: CONTENT_RULE_NAMES['R4-结果'], scope: 'project' },
  { ruleId: 'R4-技术栈', name: CONTENT_RULE_NAMES['R4-技术栈'], scope: 'project' }
]

/** 诊断轮提示词：完整规则矩阵 + 质量维度定义 + JSON 输出契约 + 简历原文。 */
export function buildDiagnosisPrompt(resume: Resume): string {
  const ruleLines = CONTENT_RULE_DEFINITIONS.map((r) => {
    if (r.scope === 'project') return `${r.ruleId} ${r.name}（每项目一条，target=${CONTENT_PROJECT_TARGET_PREFIX}<项目id>）`
    if (r.ruleId === 'R3') {
      // R3 na 条件：无实习经历或仅一条实习经历时不存在相对顺序问题，判定为不适用
      return `${r.ruleId} ${r.name}（全局一条，target=section:order；无实习经历或仅一条实习经历时判定为不适用(na)）`
    }
    return `${r.ruleId} ${r.name}（全局一条，target=global）`
  })
  return [
    '[内容优化 1/2：规则诊断] 你是一名简历内容优化专家。以下为一份应届生中文简历（无 JD、无岗位方向）。',
    '按预设规则逐条对照，输出每条判定（规则 ID / 作用对象 / 状态 / 原文证据 / 问题说明 / 建议动作 / 事实来源）。',
    '',
    '规则集（大赛经历归属项目经历；不做岗位相关性判断；不输出总分/等级）：',
    ...ruleLines,
    '',
    '每维度状态：pass（通过）/ improve（需改进）/ insufficient（信息不足）/ na（不适用）。',
    '每项目判定：keep（保持）/ rewrite（可直接改写）/ needs-info（需要补充信息）。',
    '需要用户补充的事实写入 questions（按项目分组：简介/难点/个人工作量/结果/技术栈，含原文证据与候选）。',
    'honors 中的大赛/竞赛经历可提升为项目（#90 业务①规则，T08）：',
    '  仅当 honors 条目明显是大赛/竞赛（含「大赛/竞赛/挑战赛/比赛/杯/赛」等字样，或描述为参赛获奖）时输出 promotions 建议；',
    '  每条建议含 honorIndex（honors 数组下标）、honorName、evidence（原文）、missingFields（缺失字段子集：startDate/endDate/techStack/description）；',
    '  非大赛荣誉（奖学金/荣誉称号等）不输出提升建议。',
    '只输出 JSON，不要多余文字：',
    JSON.stringify({
      rules: [
        {
          ruleId: 'R1|R2|R3|R4-简介|R4-难点|R4-工作量|R4-结果|R4-技术栈',
          target: 'project:<项目id>|global|section:order',
          status: 'pass|improve|insufficient|na',
          evidence: '原文证据',
          issue: '问题说明',
          suggestion: '建议动作',
          factSource: 'original|user-answer|inferred'
        }
      ],
      projects: [{ projectId: '<项目id>', verdict: 'keep|rewrite|needs-info' }],
      questions: [
        { id: '<可选稳定键，如 q1；省略时按序号 q0/q1/…>', projectId: '<项目id>', field: '简介|难点|个人工作量|结果|技术栈', question: '追问问题', evidence: '原文证据', candidates: ['候选1', '候选2'] }
      ],
      promotions: [
        { id: '<稳定键，如 promo-0>', honorIndex: 0, honorName: '大赛名称', evidence: '原文证据', missingFields: ['startDate', 'endDate', 'techStack', 'description'] }
      ]
    }),
    '',
    `简历 JSON：\n${JSON.stringify(resume)}`
  ].join('\n')
}

/** 解析诊断轮输出：JSON 结构校验（保持 T02 的宽松字段降级）+ 项目判定一致性推导。 */
export function parseDiagnosis(reply: string): ContentDiagnosis {
  const parsed = extractJson(reply)
  if (!isRecord(parsed)) throw new Error('诊断输出结构非法（未找到 JSON 对象）')
  const rules = Array.isArray(parsed.rules)
    ? parsed.rules.filter(isRecord).map(parseRule)
    : []
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.filter(isRecord).map((q) => ({
        // T04：问题稳定键（追问表单 answers 记录用；缺失时渲染层按序号派生）
        ...(q.id !== undefined && q.id !== null && String(q.id) !== '' ? { id: String(q.id) } : {}),
        projectId: String(q.projectId ?? ''),
        field: String(q.field ?? ''),
        question: String(q.question ?? ''),
        evidence: String(q.evidence ?? ''),
        candidates: Array.isArray(q.candidates) ? q.candidates.map((c) => String(c)) : []
      }))
    : []
  // 项目判定：优先由该项目规则状态推导（一致性约束）；该项目无规则条目时兜底用 LLM 判定。
  // 项目判定：优先由该项目规则状态推导（一致性约束）；该项目无规则条目时兜底用 LLM 判定。
  // LLM 省略 projects 数组（或为空）时，由项目级规则反向推导项目判定（review 修复：
  // 避免仅有 improve 规则却落入 noChanges 路径）。
  const projects =
    Array.isArray(parsed.projects) && parsed.projects.length > 0
      ? parsed.projects.filter(isRecord).map((p) => {
          const projectId = String(p.projectId ?? '')
          const hasProjectRules = rules.some((r) => r.target === projectTarget(projectId))
          return {
            projectId,
            verdict: hasProjectRules
              ? deriveProjectVerdict(projectId, rules)
              : (isVerdict(p.verdict) ? p.verdict : 'keep')
          }
        })
      : deriveProjectsFromRules(rules)
  // 大赛提升建议（T08/#98）：非法条目（下标非数字/缺失字段非法）跳过，其余保留。
  const promotions = Array.isArray(parsed.promotions)
    ? parsed.promotions
        .filter(isRecord)
        .map(parsePromotion)
        .filter((p): p is ContentPromotionSuggestion => p !== null)
    : []
  return { rules, projects, questions, promotions }
}

/** 解析单条大赛提升建议；字段缺失/下标非法/名称缺失返回 null（跳过）。 */
function parsePromotion(raw: Record<string, unknown>): ContentPromotionSuggestion | null {
  const honorIndex = typeof raw.honorIndex === 'number' ? raw.honorIndex : Number(raw.honorIndex)
  if (!Number.isInteger(honorIndex) || honorIndex < 0) return null
  // #98 review：honorName 是提升对象的确认依据（下标+名称双重匹配），缺失/空视为非法建议
  const honorName = typeof raw.honorName === 'string' ? raw.honorName.trim() : ''
  if (honorName === '') return null
  const missingFields = Array.isArray(raw.missingFields)
    ? raw.missingFields
        .filter(isPromotionMissingField)
        .filter((field, index, all) => all.indexOf(field) === index)
    : []
  return {
    id: raw.id !== undefined && raw.id !== null && String(raw.id) !== '' ? String(raw.id) : `promo-${honorIndex}`,
    honorIndex,
    honorName,
    evidence: String(raw.evidence ?? ''),
    missingFields
  }
}

/** 项目级规则 → 按项目分组推导判定（LLM 未返回 projects 数组时的兜底）。 */
function deriveProjectsFromRules(
  rules: ContentRuleVerdict[]
): Array<{ projectId: string; verdict: ContentProjectVerdict }> {
  const projectIds = new Set<string>()
  for (const r of rules) {
    const id = projectIdFromTarget(r.target)
    if (id !== undefined) projectIds.add(id)
  }
  return [...projectIds]
    .map((projectId) => ({ projectId, verdict: deriveProjectVerdict(projectId, rules) }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
}

/** 一致性推导：insufficient → needs-info；否则 improve → rewrite；否则 keep。 */
export function deriveProjectVerdict(
  projectId: string,
  rules: readonly ContentRuleVerdict[]
): ContentProjectVerdict {
  const projectRules = rules.filter((r) => r.target === projectTarget(projectId))
  if (projectRules.some((r) => r.status === 'insufficient')) return 'needs-info'
  if (projectRules.some((r) => r.status === 'improve')) return 'rewrite'
  return 'keep'
}

/** target → 项目 id；非项目规则返回 undefined。 */
function projectIdFromTarget(target: string): string | undefined {
  if (!target.startsWith(CONTENT_PROJECT_TARGET_PREFIX)) return undefined
  const id = target.slice(CONTENT_PROJECT_TARGET_PREFIX.length)
  return id === '' ? undefined : id
}

/** 项目 id → 项目规则作用对象 target。 */
function projectTarget(projectId: string): string {
  return `${CONTENT_PROJECT_TARGET_PREFIX}${projectId}`
}

function parseRule(r: Record<string, unknown>): ContentRuleVerdict {
  return {
    ruleId: String(r.ruleId ?? ''),
    target: String(r.target ?? ''),
    status: isRuleStatus(r.status) ? r.status : 'na',
    evidence: String(r.evidence ?? ''),
    issue: String(r.issue ?? ''),
    suggestion: String(r.suggestion ?? ''),
    factSource: isFactSource(r.factSource) ? r.factSource : 'original'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVerdict(value: unknown): value is ContentProjectVerdict {
  return value === 'keep' || value === 'rewrite' || value === 'needs-info'
}

function isRuleStatus(value: unknown): value is ContentRuleStatus {
  return value === 'pass' || value === 'improve' || value === 'insufficient' || value === 'na'
}

function isFactSource(value: unknown): value is ContentRuleVerdict['factSource'] {
  return value === 'original' || value === 'user-answer' || value === 'inferred'
}
