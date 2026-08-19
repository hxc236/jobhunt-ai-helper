import type { Resume, ResumeProject } from '../../shared/types/resume'
import { RESUME_SECTION_KEYS } from '../../shared/types/resume'
import type {
  ContentDiagnosis,
  ContentOptimizeChange,
  ContentRewrite
} from '../../shared/types'
import {
  CONTENT_ANSWER_CANNOT,
  CONTENT_ANSWER_DENIED,
  contentQuestionKeys
} from '../../shared/content-answers'
import { CONTENT_RULE_NAMES } from '../../shared/types'
import { extractJson } from './optimize'
import { assertValidResume } from './resume-schema'

/**
 * 内容优化改写引擎（T05/#95）：逐项目改写 + 事实溯源生成。
 *
 * 业务①（内容优化）改写轮——在【规则诊断 + 用户已确认回答】基础上，
 * 单轮产出完整最终稿（resume 对象）+ 逐处改动说明（changes[]）。
 * 与按 JD 优化（业务②）完全分离；面向应届生、中文简历、不依赖 JD/岗位方向。
 *
 * 事实溯源（防幻觉依据，US16/US17）：
 * - original：改写自简历原文（before 必须能在原文中找到对应文本，宽松匹配）；
 * - user-answer：直接来自用户已确认的回答内容；
 * - inferred：新增且无来源的事实——必须标记「待确认」，最终版需用户显式勾选（T06 UI）。
 *
 * 一致性校验（解析层强制，保证「无改动项目保留原文」与改动可溯源）：
 * - before 宽松匹配原文（trim/标点/空白容忍）；排序类改动（sectionOrder 等）跳过文本匹配；
 * - after / reason 非空；before≈after 的 no-op 改动被丢弃；
 * - 哨兵抑制：用户标记「[不属实] / [无法补充]」的候选事实不得新增进改写稿
 *   （候选原本就在原文中 → 不算新增，放行）；
 * - 项目溯源：任何与原文不同的项目（含被删除/新增的项目）必须被 ≥1 条 change 记录，
 *   否则视为「无改动项目被篡改」拒绝（防 LLM 静默改写 keep 项目）；
 * - 事实来源兜底：声称 original/user-answer 但 after 既不含原文锚点也不含任何回答文本
 *   → 降级 inferred（新增且无来源）；inferred 的 reason 补「（推断-待确认）」标记。
 *
 * 结构约束（改写产出必须合法）：resume 对象过 resume.schema.json 校验——
 * 项目 highlights ≤4 条（技术栈独立不计条数）、sectionOrder 合法、id 保留。
 */

/** 改写轮输入：原文简历 + 规则诊断 + 用户回答。 */
export interface RewriteRoundInput {
  resume: Resume
  diagnosis: ContentDiagnosis | null
  answers: Record<string, string> | null
}

/** 排序类改动节：不要求 before 命中原文（相对顺序调整记录）。
 * 仅限输出契约中的 sectionOrder——其他节名（含猜测别名）不豁免文本锚点校验，
 * 防止 LLM 借任意节名绕过溯源/降级。 */
const ORDERING_SECTIONS = new Set(['sectionOrder'])

/** 规则约束（改写轮提示词与规则引擎共用 R1–R4 名称，单一来源 CONTENT_RULE_NAMES）。 */
const REWRITE_RULE_LINES: ReadonlyArray<{ ruleId: string; detail: string }> = [
  { ruleId: 'R1', detail: '含金量：写清难点与解决行动——业务/技术难点、具体目标与约束、关键解决行动' },
  { ruleId: 'R2', detail: '全局可读性：修复标点细节错误；冗长内容结构化拆解为要点（每项目 highlights ≤4 条，技术栈独立不计条数）；突出重点、提升可读性' },
  { ruleId: 'R3', detail: '实习前置：实习经历无条件排在项目/大赛之前（相对顺序调整体现在 sectionOrder 与各节内顺序）' },
  { ruleId: 'R4', detail: '四要素 + 结果：简介（解决问题/面向场景/目标用户）、难点（业务/技术，含具体目标与约束）、个人工作量（本人边界/关键行动/方案选择/可归因成果）、结果（交付/验证/证据等级）、技术栈（真实）' }
]

/** 改写轮提示词：规则约束 + 事实使用规则（防幻觉）+ 输出契约 + 诊断/回答/简历原文。 */
export function buildRewritePrompt(input: RewriteRoundInput): string {
  const ruleLines = REWRITE_RULE_LINES.map(
    (r) => `${r.ruleId} ${CONTENT_RULE_NAMES[r.ruleId] ?? ''}：${r.detail}`
  )
  return [
    '[内容优化 2/2：逐项目改写] 你是一名简历内容优化专家。基于【规则诊断结果】与【用户已确认的回答】，对简历逐项目一次改写（单轮产出完整最终稿），只输出 JSON。',
    '',
    '改写须落地的规则约束：',
    ...ruleLines,
    '',
    '事实使用规则（防幻觉，严格遵守）：',
    `1. 原文优先：改写尽量基于简历原文；原文没有的事实不得编造。`,
    `2. 用户回答：answers 中非哨兵值的已确认文本可直接作为事实使用。`,
    `3. 新增且无来源：确需新增且无法追溯到原文或用户回答的事实，source 必须为 inferred，reason 中注明「待确认」。`,
    `4. 哨兵：回答值为「${CONTENT_ANSWER_DENIED}」的候选事实不得写入简历；「${CONTENT_ANSWER_CANNOT}」表示用户无法补充——不得编造该事实（必要时该维度维持信息不足，不写）。`,
    `5. 未答：answers 中缺失的键（用户未回答）不得当作已确认事实使用。`,
    '',
    '输出契约：',
    JSON.stringify({
      resume: '完整简历对象，符合 resume.schema.json（项目 highlights ≤4 条，技术栈独立不计条数；sectionOrder 合法；项目稳定 id 保留）',
      changes: [
        {
          projectId: '改动所属项目 id（全局/排序类改动可省略）',
          section: '改动字段或节（如 description / highlights / techStack / projects / experience / sectionOrder）',
          before: '简历原文中的对应文本（宽松匹配；排序类改动可为调整说明）',
          after: '改后文本（非空）',
          reason: '改动理由（非空）',
          source: 'original|user-answer|inferred（见事实使用规则）'
        }
      ]
    }),
    'changes 规则：只记录实际改动（无改动项目/字段不出现）；before 必须是原文中的对应文本；排序调整（R3）可记录为 section=sectionOrder 的 change。',
    '',
    `诊断：${JSON.stringify(input.diagnosis)}`,
    `用户回答（未答项缺失；哨兵值含义见规则 4）：${JSON.stringify(input.answers)}`,
    `简历 JSON：\n${JSON.stringify(input.resume)}`
  ].join('\n')
}

/**
 * 解析改写轮输出：JSON 结构校验 + resume 过 schema + changes 规范化 +
 * 事实溯源分类 + 一致性校验（原文锚点 / 哨兵抑制 / 项目级可溯源）。
 * 任何校验失败抛 Error（由服务层包装为 bad-json → 轮次失败可重试）。
 */
export function parseRewrite(reply: string, input: RewriteRoundInput): ContentRewrite {
  const parsed = extractJson(reply)
  if (!isRecord(parsed) || !isRecord(parsed.resume)) {
    throw new Error('改写输出结构非法（缺 resume 对象）')
  }
  assertValidResume(parsed.resume) // 非法抛 ResumeValidationError（含定位）
  const rewritten = parsed.resume as unknown as Resume

  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes.filter(isRecord).map(parseChange) : []
  // 丢弃 no-op（before≈after 未产生实际改动）
  const changes = rawChanges.filter((c) => !isNoopChange(c))

  for (const change of changes) {
    assertGrounded(change, input.resume, rewritten)
  }
  assertNoDeniedOrCannotFacts(rewritten, input)
  assertProjectTraceability(input.resume, rewritten, changes)

  const classified = changes.map((change) => classifyChangeSource(change, input))
  return { resume: rewritten, changes: classified }
}

/** 单条 change 规范化（字段缺失给默认值；source 非法 → 保守降级 inferred）。 */
function parseChange(c: Record<string, unknown>): ContentOptimizeChange {
  return {
    ...(c.projectId !== undefined && c.projectId !== null && String(c.projectId) !== ''
      ? { projectId: String(c.projectId) }
      : {}),
    section: String(c.section ?? ''),
    before: String(c.before ?? ''),
    after: String(c.after ?? ''),
    reason: String(c.reason ?? ''),
    source: isChangeSource(c.source) ? c.source : 'inferred'
  }
}

/** no-op：before 与 after 宽松等价（未产生实际改动）。 */
function isNoopChange(change: ContentOptimizeChange): boolean {
  if (change.before.trim() === '') return false
  return normalizeText(change.before) === normalizeText(change.after)
}

/**
 * 一致性校验：section/after/reason 非空；before 宽松命中原文（排序类跳过）。
 * projectId 可在原文或改写稿中存在——新增项目（大赛→项目等）的 change 引用改写稿中的新项目。
 */
function assertGrounded(change: ContentOptimizeChange, resume: Resume, rewritten: Resume): void {
  if (change.section.trim() === '') throw new Error('改动缺少 section 字段')
  if (change.after.trim() === '') throw new Error(`改动（${change.section}）after 为空`)
  if (change.reason.trim() === '') throw new Error(`改动（${change.section}）reason 为空`)
  let projectScope: string | null = null
  if (change.projectId !== undefined && change.projectId !== '') {
    const inOriginal = (resume.projects ?? []).find((p) => p.id === change.projectId)
    const inRewritten = (rewritten.projects ?? []).find((p) => p.id === change.projectId)
    if (inOriginal === undefined && inRewritten === undefined) {
      throw new Error(`改动引用的项目不存在：${change.projectId}`)
    }
    projectScope = inOriginal !== undefined ? projectText(inOriginal) : projectText(inRewritten!)
  }
  if (ORDERING_SECTIONS.has(change.section)) return
  if (change.before.trim() === '') return // 纯新增：无原文锚点，由事实溯源分类标记待确认
  // 新增项目（仅存在于改写稿）的 before 视为空锚点，不要求命中原文
  if (projectScope !== null && !(resume.projects ?? []).some((p) => p.id === change.projectId)) return
  const scope = projectScope ?? textScope(resume, change)
  if (!normalizeText(scope).includes(normalizeText(change.before))) {
    throw new Error(`改动 before 未能在简历原文中找到对应文本：${change.before.slice(0, 50)}`)
  }
}

/** 原文作用域文本：有 projectId 取该项目；否则按 section 取节；未知节兜底全简历。 */
function textScope(resume: Resume, change: ContentOptimizeChange): string {
  if (change.projectId !== undefined && change.projectId !== '') {
    const project = (resume.projects ?? []).find((p) => p.id === change.projectId)
    return project === undefined ? '' : projectText(project)
  }
  const section = change.section
  const value = (resume as unknown as Record<string, unknown>)[section]
  if (value === undefined) return flattenResume(resume)
  return flattenValue(value)
}

/**
 * 哨兵抑制：用户标记「不属实 / 无法补充」的候选事实不得新增进改写稿。
 * 候选原本就在原文中 → 不算新增，放行（用户只是否认它是「难点/结果」等，原文保留）。
 */
function assertNoDeniedOrCannotFacts(rewritten: Resume, input: RewriteRoundInput): void {
  const questions = input.diagnosis?.questions ?? []
  const answers = input.answers ?? {}
  const keys = contentQuestionKeys(questions)
  questions.forEach((q, index) => {
    const answer = answers[keys[index] ?? '']
    if (answer !== CONTENT_ANSWER_DENIED && answer !== CONTENT_ANSWER_CANNOT) return
    const sentinelLabel = answer === CONTENT_ANSWER_DENIED ? CONTENT_ANSWER_DENIED : CONTENT_ANSWER_CANNOT
    const originalProject = (input.resume.projects ?? []).find((p) => p.id === q.projectId)
    const originalText = normalizeText(originalProject !== undefined ? projectText(originalProject) : '')
    const rewrittenProject = (rewritten.projects ?? []).find((p) => p.id === q.projectId)
    const rewrittenText = normalizeText(rewrittenProject !== undefined ? projectText(rewrittenProject) : '')
    for (const candidate of q.candidates) {
      const c = normalizeText(candidate)
      if (c === '') continue
      if (originalText !== '' && originalText.includes(c)) continue
      if (rewrittenText !== '' && rewrittenText.includes(c)) {
        throw new Error(
          `改写引用了被用户标记为「${sentinelLabel}」的候选事实：${candidate.slice(0, 50)}`
        )
      }
    }
  })
}

/**
 * 项目级可溯源：任何与原文不同的项目（含被删除/新增的项目）必须被 ≥1 条 change 记录。
 * 保证「无改动项目保留原文」——LLM 不得静默改写 keep 项目。
 */
function assertProjectTraceability(
  original: Resume,
  rewritten: Resume,
  changes: ContentOptimizeChange[]
): void {
  const originalProjects = original.projects ?? []
  if (originalProjects.length === 0) return
  const changedProjectIds = new Set(
    changes.filter((c) => c.projectId !== undefined).map((c) => c.projectId!)
  )
  const hasSectionLevelChange = changes.some((c) => c.projectId === undefined && c.section === 'projects')
  const rewrittenById = new Map(
    (rewritten.projects ?? []).filter((p) => p.id !== undefined).map((p) => [p.id!, p])
  )
  for (const project of originalProjects) {
    if (project.id === undefined) continue
    const rewrittenProject = rewrittenById.get(project.id)
    if (rewrittenProject === undefined) {
      // 项目被删除：必须可溯源（T05 不实现删除确认，但删除不得静默发生）
      if (!changedProjectIds.has(project.id) && !hasSectionLevelChange) {
        throw new Error(`项目「${project.name ?? project.id}」从改写稿中消失且未在 changes 中记录`)
      }
      continue
    }
    if (
      normalizeText(projectText(rewrittenProject)) !== normalizeText(projectText(project)) &&
      !changedProjectIds.has(project.id) &&
      !hasSectionLevelChange
    ) {
      throw new Error(`项目「${project.name ?? project.id}」发生改动但未在 changes 中记录（无改动项目应保留原文）`)
    }
  }
  // 新增项目同样必须可溯源（防幻觉新增）
  const originalIds = new Set(originalProjects.filter((p) => p.id !== undefined).map((p) => p.id!))
  for (const rewrittenProject of rewritten.projects ?? []) {
    if (rewrittenProject.id === undefined || originalIds.has(rewrittenProject.id)) continue
    if (!changedProjectIds.has(rewrittenProject.id) && !hasSectionLevelChange) {
      throw new Error(`改写稿新增了未在 changes 中记录的项目：${rewrittenProject.name ?? rewrittenProject.id}`)
    }
  }
}

/**
 * 事实溯源分类兜底：
 * - 声称 original/user-answer 但 after 既不含原文锚点（before 宽松命中）也不含任何回答文本
 *   → 降级 inferred（新增且无来源，防幻觉）；
 * - inferred → reason 补「（推断-待确认）」标记（US17：最终版需用户显式勾选）。
 * 排序类改动（sectionOrder 等）不做降级（相对顺序源自原文结构，非新增事实）。
 */
function classifyChangeSource(change: ContentOptimizeChange, input: RewriteRoundInput): ContentOptimizeChange {
  if (change.source === 'inferred') return withPendingMarker(change)
  if (ORDERING_SECTIONS.has(change.section)) return change
  const after = normalizeText(change.after)
  if (after === '') return change
  const before = normalizeText(change.before)
  const groundedInOriginal = before !== '' && after.includes(before)
  const answerTexts = Object.values(input.answers ?? {})
    .filter((v) => v !== CONTENT_ANSWER_DENIED && v !== CONTENT_ANSWER_CANNOT)
    .map((v) => normalizeText(v))
    .filter((v) => v !== '')
  const groundedInAnswers = answerTexts.some((text) => after.includes(text))
  if (!groundedInOriginal && !groundedInAnswers) {
    return withPendingMarker({ ...change, source: 'inferred' })
  }
  return change
}

/** inferred 的 change 必须带「待确认」语义（reason 内显式标记，US17）。
 * 无论 reason 是否已含「推断/待核实」等措辞都追加显式标记，保证标记统一；
 * 仅在 reason 已以「待确认」结尾时跳过，避免重复追加。 */
function withPendingMarker(change: ContentOptimizeChange): ContentOptimizeChange {
  if (change.reason.trim().endsWith('待确认')) return change
  return { ...change, reason: `${change.reason}（推断-待确认）` }
}

/** 项目文本扁平化（id/name/描述/要点/技术栈等全部文本，供宽松匹配）。 */
function projectText(project: ResumeProject): string {
  return flattenObject(project as unknown as Record<string, unknown>)
}

/** 整份简历文本扁平化（不含 sectionOrder——排序不参与文本匹配）。
 * 节列表复用 RESUME_SECTION_KEYS（schema 唯一来源），避免硬编码漂移。 */
function flattenResume(resume: Resume): string {
  const parts: string[] = []
  for (const key of RESUME_SECTION_KEYS) {
    const value = (resume as unknown as Record<string, unknown>)[key]
    if (value !== undefined) parts.push(flattenValue(value))
  }
  return parts.join('\n')
}

function flattenValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => flattenValue(item)).join('\n')
  if (typeof value === 'object' && value !== null) return flattenObject(value as Record<string, unknown>)
  return ''
}

function flattenObject(obj: Record<string, unknown>): string {
  return Object.values(obj).map((v) => flattenValue(v)).join('\n')
}

/** 宽松归一：去空白（含全角空格）、去常见标点、小写。 */
export function normalizeText(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(
      /[，。、,.;；:：!！?？()（）「」『』【】\[\]{}"'“”‘’\u2010-\u2015—_/\\]/g,
      ''
    )
    .toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChangeSource(value: unknown): value is ContentOptimizeChange['source'] {
  return value === 'original' || value === 'user-answer' || value === 'inferred'
}
