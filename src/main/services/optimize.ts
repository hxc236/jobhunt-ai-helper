import type { Db } from '../db/migrations'
import type { AgentService } from './agent'
import type { PositionService } from './position'
import type { ResumeService } from './resume'
import { assertValidResume, ResumeValidationError } from './resume-schema'
import type { Resume } from '../../shared/types/resume'
import type {
  JdAnalysis,
  OptimizationMode,
  OptimizeChange,
  OptimizeResult,
  Position
} from '../../shared/types'


/** 优化服务错误：code 供渲染层区分提示。 */
export class OptimizeError extends Error {
  constructor(
    readonly code: 'no-jd' | 'bad-json',
    message: string
  ) {
    super(message)
    this.name = 'OptimizeError'
  }
}

/** JD 文本指纹（djb2 简单哈希；仅用于缓存失效判断，非加密）。 */
export function jdFingerprint(jd: string): string {
  let hash = 5381
  for (let i = 0; i < jd.length; i++) {
    hash = ((hash << 5) + hash + jd.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/** 从 agent 回复中提取 JSON（优先 ```json 代码块，其次花括号配平）。 */
export function extractJson(reply: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)
  const candidate = fence !== null ? fence[1] : reply
  const start = candidate.indexOf('{')
  if (start === -1) throw new OptimizeError('bad-json', '回复中未找到 JSON 对象')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1))
    }
  }
  throw new OptimizeError('bad-json', 'JSON 括号未闭合')
}

/**
 * OptimizeService（F-07/#28）：三轮 agent 编排（ADR-0002：optimize 每次新建 inMemory 会话）。
 * 1) JD 解析（写 positions.jd_analysis 缓存；JD 指纹一致跳过）；2) 缺口评估；
 * 3) 生成优化稿 + changes[]（strict/balanced 约束；输出过 resume.schema.json 校验，
 * 首次非法自动修正一轮）。
 */
export interface OptimizeServiceOptions {
  /** 轮次进度回调（IPC 层接事件推送 optimize:progress，UI 流式展示三轮进度）。 */
  onProgress?: (info: { jobId: string; round: 1 | 2 | 3; phase: string }) => void
}

export class OptimizeService {
  private readonly onProgress: OptimizeServiceOptions['onProgress']

  constructor(
    private readonly db: Db,
    private readonly positions: PositionService,
    private readonly resumes: ResumeService,
    private readonly agent: AgentService,
    options: OptimizeServiceOptions = {}
  ) {
    this.onProgress = options.onProgress
  }

  async run(jobId: string, resumeId: string, mode: OptimizationMode = 'strict'): Promise<OptimizeResult> {
    const position = this.positions.get(jobId) // 职位不存在 → not-found
    if (position.jd.trim() === '') {
      throw new OptimizeError('no-jd', '职位 JD 为空，无法生成优化稿——请先在职位详情中补充 JD')
    }
    const resume = this.resumes.get(resumeId)
    if (resume === undefined) throw new OptimizeError('no-jd', `简历不存在：${resumeId}`)

    const session = await this.agent.createSession('optimize')
    try {
      this.onProgress?.({ jobId, round: 1, phase: 'JD 解析' })
      const jdAnalysis = await this.analyzeJd(session, position)
      this.onProgress?.({ jobId, round: 2, phase: '缺口评估' })
      const gaps = await this.assessGaps(session, jdAnalysis, resume)
      this.onProgress?.({ jobId, round: 3, phase: '生成优化稿' })
      const { optimizedResume, changes } = await this.generate(session, jdAnalysis, gaps, resume, mode)
      return { jobId, resumeId, mode, jdAnalysis, gaps, optimizedResume, changes }
    } finally {
      session.dispose()
    }
  }

  /** 第 1 轮：JD 解析 → 结构化分析；positions.jd_analysis 缓存（JD 指纹一致跳过）。 */
  private async analyzeJd(
    session: { prompt(text: string): Promise<string> },
    position: Position
  ): Promise<JdAnalysis> {
    const fingerprint = jdFingerprint(position.jd)
    const cached = this.readJdCache(position.id)
    if (cached !== null && cached.jdFingerprint === fingerprint) {
      return cached
    }

    const prompt = [
      '[优化流程 1/3：JD 解析] 你是一名校招职位分析师。分析以下 JD，输出 JSON：',
      '{"skills": ["技能列表"], "keywords": ["关键词列表"], "requirements": ["任职要求"], "hardRequirements": ["硬性条件，如学历/专业"]}',
      '',
      `JD：\n${position.jd}`
    ].join('\n')
    const reply = await session.prompt(prompt)
    const parsed = extractJson(reply)
    if (!isRecord(parsed)) throw new OptimizeError('bad-json', 'JD 解析输出结构非法')
    const analysis: JdAnalysis = {
      skills: toStringArray(parsed.skills),
      keywords: toStringArray(parsed.keywords),
      requirements: toStringArray(parsed.requirements),
      hardRequirements: toStringArray(parsed.hardRequirements),
      parsedAt: new Date().toISOString(),
      jdFingerprint: fingerprint
    }
    this.db.prepare('UPDATE positions SET jd_analysis = ? WHERE id = ?').run(
      JSON.stringify(analysis),
      position.id
    )
    return analysis
  }

  /** 第 2 轮：缺口评估 → 短板清单（学习清单/面试的依据）。 */
  private async assessGaps(
    session: { prompt(text: string): Promise<string> },
    jdAnalysis: JdAnalysis,
    resume: Resume
  ): Promise<string[]> {
    const prompt = [
      '[优化流程 2/3：缺口评估] 基于 JD 分析与简历，找出简历相对 JD 的缺口，输出 JSON：',
      '{"gaps": ["缺口1", "缺口2"]}',
      '',
      `JD 分析：\n${JSON.stringify(jdAnalysis)}`,
      '',
      `简历：\n${JSON.stringify(resume)}`
    ].join('\n')
    const reply = await session.prompt(prompt)
    const parsed = extractJson(reply)
    if (!isRecord(parsed)) throw new OptimizeError('bad-json', '缺口评估输出结构非法')
    return toStringArray(parsed.gaps)
  }

  /** 第 3 轮：生成优化稿 + changes[]；strict/balanced 约束；schema 校验 + 自动修正一轮。 */
  private async generate(
    session: { prompt(text: string): Promise<string> },
    jdAnalysis: JdAnalysis,
    gaps: string[],
    resume: Resume,
    mode: OptimizationMode
  ): Promise<{ optimizedResume: Resume; changes: OptimizeChange[] }> {
    const constraint =
      mode === 'strict'
        ? '约束（strict 模式）：不得虚构任何简历中不存在的信息——不得添加未提供的项目/经历/技能/量化数据，只允许措辞优化、结构调整、突出与 JD 相关的已有内容。'
        : '约束（balanced 模式）：允许适度润色与合理推断，但不得捏造可核查的量化数据与经历。'
    const prompt = [
      '[优化流程 3/3：生成优化稿] 基于 JD 分析与缺口评估，优化简历（保持 resume.schema.json 结构），输出 JSON：',
      '{"resume": {简历对象}, "changes": [{"section": "节名", "before": "原文", "after": "改后", "reason": "理由"}]}',
      '',
      constraint,
      '',
      `JD 分析：\n${JSON.stringify(jdAnalysis)}`,
      '',
      `缺口：\n${gaps.join('\n')}`,
      '',
      `原始简历：\n${JSON.stringify(resume)}`
    ].join('\n')
    const reply = await session.prompt(prompt)

    try {
      return this.parseGeneration(reply)
    } catch (err) {
      // 首轮非法（JSON 结构或 schema）→ 带定位自动修正一轮
      const issues = err instanceof ResumeValidationError ? err.issues : undefined
      const issueText =
        issues === undefined ? String(err) : issues.map((i) => `${i.instancePath} ${i.message ?? i.keyword}`).join('；')
      const repair = await session.prompt(
        [
          '[修正：上次输出未通过简历 schema 校验] 请按以下问题修正后重新输出完整 JSON（含 resume 与 changes）：',
          issueText
        ].join('\n')
      )
      return this.parseGeneration(repair)
    }
  }

  /** 解析生成轮输出：JSON 结构 + resume 过 schema 校验。 */
  private parseGeneration(reply: string): { optimizedResume: Resume; changes: OptimizeChange[] } {
    const parsed = extractJson(reply)
    if (!isRecord(parsed) || !isRecord(parsed.resume)) {
      throw new OptimizeError('bad-json', '生成输出结构非法（缺 resume 对象）')
    }
    assertValidResume(parsed.resume) // 非法抛 ResumeValidationError（含定位）
    const changes = Array.isArray(parsed.changes)
      ? (parsed.changes as OptimizeChange[]).filter((c) => isRecord(c))
      : []
    return { optimizedResume: parsed.resume as unknown as Resume, changes }
  }

  private readJdCache(jobId: string): JdAnalysis | null {
    const row = this.db.prepare('SELECT jd_analysis FROM positions WHERE id = ?').get(jobId) as
      | { jd_analysis: string | null }
      | undefined
    if (row === undefined || row.jd_analysis === null) return null
    try {
      const parsed = JSON.parse(row.jd_analysis) as JdAnalysis
      return isRecord(parsed) && Array.isArray(parsed.skills) ? parsed : null
    } catch {
      return null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}
