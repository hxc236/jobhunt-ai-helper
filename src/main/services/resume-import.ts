import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Resume, ResumeImportProvenance, StoredResume } from '../../shared/types/resume'
import type { ResumeDraft, ResumeFieldStatus } from '../../shared/types'
import { parseUploadFile, extractPdfPages, buildDraft, ResumeParseError } from './resume-parse'
import type { ResumeService } from './resume'
import type { AgentService, AgentSession, AgentSettingsStore } from './agent'
import type { PdfOcrAdapter } from './ocr-import'
import { analyzePageQuality, SOFT_OCR_THRESHOLD } from './pdf-page-quality'
import { normalizeExtractedText, reflowTwoColumn } from './pdf-routing'
import { extractJson } from './optimize'
import { assertValidResume, ResumeValidationError } from './resume-schema'

/**
 * 简历导入模块（#75 起，DOCX 本地导入闭环；#77 Agent 自动结构化与本地草稿降级）。
 * - start 同步校验（类型/大小）→ 后台异步执行（阶段事件：read → parse → map → agent）；
 * - 草稿（文本 + 规则映射 Resume）仅存内存，确认前不写正式简历表；
 * - #77 Agent 结构化：独立无工具内存态会话，只接收文本；首次使用前隐私告知并记录同意；
 *   未配置/关闭/拒绝同意/网络失败/超时/连续非法 → 自动降级本地草稿并展示原因；
 *   网络类暂时错误自动重试一次；等待超 agentWaitMs（默认 30s）→ agent_pending(timeout)
 *   由用户决定继续等待/使用本地草稿/取消；
 * - 取消：置 cancelled 标记，中止 Agent 会话、拒绝未决决策，取消后不产生 done；
 * - 确认：createImported 强制新基准简历（baseResumeId/targetJobId 为空）+ 溯源信息；
 * - 源文件只读、不复制、不保留路径；确认/取消/失败后释放内存草稿。
 */

/** 单文件上限：20 MB（规格 #73 Upload boundaries）。 */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** PDF 页数上限（规格 #73 Upload boundaries）。 */
export const MAX_PDF_PAGES = 10

/** 导入阶段（UI 进度展示；后续 ticket 扩展 Agent 结构化等阶段）。 */
export type ImportPhase = 'read' | 'parse' | 'map' | 'agent' | 'ocr'

/** Agent 降级/未使用原因（UI 展示；规格「未配置、关闭或失败时显示原因并使用本地草稿」）。 */
export type AgentFailReason =
  | 'agent-not-configured'
  | 'agent-disabled'
  | 'consent-declined'
  | 'user-local'
  | 'agent-failed'
  | 'invalid-output'

/** 导入中需要用户决策的时刻（#77）。 */
export type AgentDecisionKind = 'consent' | 'timeout'
export type AgentDecisionChoice = 'agree' | 'decline' | 'continue' | 'local'

/** 设置键（非敏感，settings 表）：Agent 导入增强开关；首次隐私同意时间。 */
export const AGENT_IMPORT_ENABLED = 'agent.importEnabled'
export const AGENT_IMPORT_CONSENT = 'agent.importConsentAt'

/** Agent 等待阈值（默认 30s；测试注入短值）。 */
const AGENT_WAIT_DEFAULT_MS = 30_000

/** 主 → 渲染事件（经 IPC pushEvent 转发）。 */
export type ImportEvent =
  | { type: 'progress'; token: string; phase: ImportPhase; detail?: string }
  | {
      type: 'done'
      token: string
      draft: ResumeDraft
      resume: Resume
      agent: { used: boolean; failedReason?: AgentFailReason }
    }
  | { type: 'error'; token: string; code: string; message: string }
  | { type: 'cancelled'; token: string }
  | { type: 'agent_pending'; token: string; kind: AgentDecisionKind }

/** 导入文件错误（start 同步抛出；UI 直接展示 message）。 */
export class ImportFileError extends Error {
  constructor(
    readonly code: 'unsupported' | 'too-large' | 'read-failed',
    message: string
  ) {
    super(message)
    this.name = 'ImportFileError'
  }
}

/** 用户选择「使用本地草稿」→ 终止 Agent、走本地降级（不是导入错误）。 */
class AgentUseLocalError extends Error {
  readonly name = 'AgentUseLocalError'
}

/** 导入被取消（cancel 或决策被拒）。 */
class ImportCancelledError extends Error {
  readonly name = 'ImportCancelledError'
}

interface DecisionHandle {
  resolve: (choice: AgentDecisionChoice) => void
  reject: (err: Error) => void
}

interface DraftEntry {
  token: string
  filePath: string
  cancelled: boolean
  finished: boolean
  draft?: ResumeDraft
  /** 进行中的 Agent 会话（取消时中止）。 */
  agentSession?: AgentSession
  /** 待决决策（consent / timeout）——UI 经 decide() 答复。 */
  decisions: Map<AgentDecisionKind, DecisionHandle>
}

export class ResumeImportService {
  private readonly entries = new Map<string, DraftEntry>()

  constructor(
    private readonly deps: {
      resumeService: ResumeService
      /** 事件推送（IPC 层注入 pushEvent；测试注入收集数组）。 */
      emit: (event: ImportEvent) => void
      /** #77：Agent 服务（未注入 = 无 Agent 增强，恒本地草稿）。 */
      agent?: AgentService
      /** #81：扫描型 PDF 的 OCR adapter（未注入 = 扫描件走「需要 OCR」降级路径）。 */
      ocrAdapter?: PdfOcrAdapter
      /** 非敏感设置存取（开关 + 隐私同意记录）。 */
      settings?: AgentSettingsStore
      /** Agent 等待阈值 ms（默认 30_000；测试注入短值）。 */
      agentWaitMs?: number
    }
  ) {
    this.agentWaitMs = deps.agentWaitMs ?? AGENT_WAIT_DEFAULT_MS
  }

  private readonly agentWaitMs: number

  /**
   * 开始导入：同步校验文件（类型/大小/可读）后立即返回 token，异步阶段在后台执行。
   * 校验失败同步抛 ImportFileError（渲染层在 invoke 处直接展示）。
   */
  start(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.docx' && ext !== '.pdf') {
      throw new ImportFileError('unsupported', `不支持的文件类型：${ext === '' ? '无扩展名' : ext}（支持 .docx / .pdf）`)
    }
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      throw new ImportFileError('read-failed', '无法读取所选文件，请确认文件仍存在')
    }
    if (size > MAX_IMPORT_BYTES) {
      throw new ImportFileError('too-large', `文件超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MB 上限，请压缩后重试`)
    }
    const entry: DraftEntry = { token: randomUUID(), filePath, cancelled: false, finished: false, decisions: new Map() }
    this.entries.set(entry.token, entry)
    void this.run(entry)
    return entry.token
  }

  /** 取消导入：中止 Agent 会话、拒绝未决决策；取消后不产生 done。 */
  cancel(token: string): void {
    const entry = this.entries.get(token)
    if (entry === undefined || entry.finished) return
    entry.cancelled = true
    for (const handle of entry.decisions.values()) handle.reject(new ImportCancelledError('导入已取消'))
    entry.decisions.clear()
    void entry.agentSession?.abort()
  }

  /** 用户答复导入中的 Agent 决策（#77：consent 同意/拒绝；timeout 继续等待/本地草稿）。 */
  decide(token: string, kind: AgentDecisionKind, choice: AgentDecisionChoice): void {
    const entry = this.entries.get(token)
    if (entry === undefined) return
    const handle = entry.decisions.get(kind)
    if (handle === undefined) return
    entry.decisions.delete(kind)
    handle.resolve(choice)
  }

  /** 确认导入：校验 schema → 创建新基准简历（溯源）→ 释放草稿。 */
  confirm(token: string, resume: Resume): StoredResume {
    const entry = this.entries.get(token)
    if (entry === undefined) throw new Error('导入会话不存在或已结束')
    if (entry.cancelled) throw new Error('导入已取消，无法确认')
    if (entry.draft === undefined) throw new Error('导入尚未完成，无法确认')
    const provenance: ResumeImportProvenance = {
      fileName: basename(entry.filePath),
      fileType: extname(entry.filePath).toLowerCase() === '.pdf' ? 'pdf' : 'docx',
      parsePath: entry.draft.parsePath ?? 'text',
      importedAt: new Date().toISOString()
    }
    const stored = this.deps.resumeService.createImported(resume, provenance)
    this.entries.delete(token)
    return stored
  }

  /** 放弃草稿（渲染层离开导入流程）：释放内存，不写库。 */
  dispose(token: string): void {
    const entry = this.entries.get(token)
    if (entry === undefined) return
    void entry.agentSession?.abort()
    this.entries.delete(token)
  }

  /** 是否已到终态（done / error / cancelled）。 */
  isFinished(token: string): boolean {
    return this.entries.get(token)?.finished ?? true
  }

  /** 是否存在可确认的草稿（确认前草稿不入库的检查用）。 */
  hasDraft(token: string): boolean {
    const entry = this.entries.get(token)
    return entry !== undefined && !entry.cancelled && entry.draft !== undefined
  }

  private async run(entry: DraftEntry): Promise<void> {
    const { token } = entry
    try {
      this.emit('progress', token, 'read')
      if (entry.cancelled) return this.finishCancelled(entry)
      this.emit('progress', token, 'parse')
      // #82：PDF 逐页智能路由（文本/双栏重排/OCR）；DOCX 直接文本提取
      const draft =
        extname(entry.filePath).toLowerCase() === '.pdf'
          ? await this.routePdfPages(entry)
          : await parseUploadFile(entry.filePath, { maxPdfPages: MAX_PDF_PAGES })
      if (entry.cancelled) return this.finishCancelled(entry)
      this.emit('progress', token, 'map')
      const localResume = draftToResume(draft)
      const agent = await this.structureWithAgent(entry, draft)
      if (entry.cancelled) return this.finishCancelled(entry)
      const finalDraft = agent.draft ?? draft
      const finalResume = agent.resume ?? localResume
      entry.draft = finalDraft
      entry.finished = true
      this.deps.emit({
        type: 'done',
        token,
        draft: finalDraft,
        resume: finalResume,
        agent: { used: agent.used, failedReason: agent.failedReason }
      })
    } catch (err) {
      if (entry.cancelled || err instanceof ImportCancelledError) return this.finishCancelled(entry)
      entry.finished = true
      const code = err instanceof ResumeParseError ? err.code : 'read-failed'
      this.deps.emit({ type: 'error', token, code, message: errMessage(err) })
    }
  }

  /**
   * #77 Agent 自动结构化（只接收文本；任何失败都降级本地草稿并给出原因）。
   * 顺序：开关/未配置检查 → 首次隐私同意 → 独立会话 → 提示 + 30s 等待决策 → schema 校验修正一轮。
   */
  private async structureWithAgent(
    entry: DraftEntry,
    localDraft: ResumeDraft
  ): Promise<{ used: boolean; failedReason?: AgentFailReason; resume?: Resume; draft?: ResumeDraft }> {
    const agent = this.deps.agent
    if (agent === undefined) return { used: false, failedReason: 'agent-disabled' }
    this.emit('progress', entry.token, 'agent')
    // 设置开关（缺省开启）
    if (this.deps.settings?.get(AGENT_IMPORT_ENABLED) === false) {
      return { used: false, failedReason: 'agent-disabled' }
    }
    // 未配置（分层降级）
    let status
    try {
      status = agent.getStatus()
    } catch {
      return { used: false, failedReason: 'agent-not-configured' }
    }
    if (!status.configured) return { used: false, failedReason: 'agent-not-configured' }
    // 首次使用前隐私告知（未同意 → 本次用本地草稿；同意后记录，不再询问）
    if (this.deps.settings !== undefined && this.deps.settings.get(AGENT_IMPORT_CONSENT) === undefined) {
      this.deps.emit({ type: 'agent_pending', token: entry.token, kind: 'consent' })
      const choice = await this.awaitAgentDecision(entry, 'consent')
      if (choice !== 'agree') return { used: false, failedReason: 'consent-declined' }
      this.deps.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    }
    let session: AgentSession
    try {
      session = await agent.createSession('resume_import')
    } catch {
      return { used: false, failedReason: 'agent-not-configured' }
    }
    entry.agentSession = session
    try {
      const promptText = buildStructurePrompt(localDraft.text)
      let reply: string
      try {
        reply = await this.promptWithDecision(entry, session, promptText)
      } catch (err) {
        if (err instanceof AgentUseLocalError) return { used: false, failedReason: 'user-local' }
        if (err instanceof ImportCancelledError) throw err
        if (!isTransientAgentError(err)) {
          return { used: false, failedReason: 'agent-failed' }
        }
        // 网络类暂时错误自动重试一次；仍失败 → 降级
        try {
          reply = await this.promptWithDecision(entry, session, promptText)
        } catch (err2) {
          if (err2 instanceof AgentUseLocalError) return { used: false, failedReason: 'user-local' }
          if (err2 instanceof ImportCancelledError) throw err2
          return { used: false, failedReason: 'agent-failed' }
        }
      }
      // schema 校验；非法 → 携带定位修正一轮；仍非法 → 降级
      try {
        return this.parseStructured(reply, localDraft)
      } catch (err) {
        const issues = err instanceof ResumeValidationError ? err.issues : undefined
        const issueText =
          issues === undefined
            ? String(err)
            : issues.map((i) => `${i.instancePath ?? ''} ${i.message ?? i.keyword}`).join('；')
        try {
          const repair = await this.promptWithDecision(entry, session, buildRepairPrompt(issueText))
          return this.parseStructured(repair, localDraft)
        } catch (err2) {
          if (err2 instanceof AgentUseLocalError) return { used: false, failedReason: 'user-local' }
          if (err2 instanceof ImportCancelledError) throw err2
          return { used: false, failedReason: 'invalid-output' }
        }
      }
    } finally {
      entry.agentSession = undefined
      session.dispose()
    }
  }

  /** Agent 提示 + 30s 等待阈值：超时 → agent_pending(timeout)，由用户决定继续等待/本地草稿。 */
  private async promptWithDecision(entry: DraftEntry, session: AgentSession, promptText: string): Promise<string> {
    const promise = session.prompt(promptText)
    const timedOut = await Promise.race([
      promise.then(() => false),
      sleep(this.agentWaitMs).then(() => true)
    ])
    if (timedOut) {
      this.deps.emit({ type: 'agent_pending', token: entry.token, kind: 'timeout' })
      const choice = await this.awaitAgentDecision(entry, 'timeout')
      if (choice === 'local') {
        await session.abort()
        throw new AgentUseLocalError()
      }
      // 'continue'：继续等待原提示完成
    }
    return await promise
  }

  /** Agent 回复 → Resume（schema 校验）+ 字段状态升级为 agent 的草稿。 */
  private parseStructured(reply: string, localDraft: ResumeDraft): { used: true; resume: Resume; draft: ResumeDraft } {
    const parsed = extractJson(reply)
    if (!isRecord(parsed)) {
      throw new ResumeValidationError([{ instancePath: '', keyword: '', message: 'agent 输出不是 JSON 对象' }])
    }
    const resume = parsed as unknown as Resume
    assertValidResume(resume) // 非法抛 ResumeValidationError（含定位）
    const fieldStatus: Record<string, ResumeFieldStatus> = {
      name: resume.basics?.name !== undefined && resume.basics.name !== '' ? 'agent' : (localDraft.fieldStatus.name ?? 'missing'),
      phone: resume.basics?.phone ? 'agent' : (localDraft.fieldStatus.phone ?? 'missing'),
      email: resume.basics?.email ? 'agent' : (localDraft.fieldStatus.email ?? 'missing'),
      birthday: resume.basics?.birthday ? 'agent' : (localDraft.fieldStatus.birthday ?? 'missing'),
      gender: resume.basics?.gender ? 'agent' : (localDraft.fieldStatus.gender ?? 'missing'),
      education: (resume.education ?? []).length > 0 ? 'agent' : (localDraft.fieldStatus.education ?? 'missing'),
      skills: (resume.skills ?? []).length > 0 ? 'agent' : (localDraft.fieldStatus.skills ?? 'missing')
    }
    return {
      used: true,
      resume,
      draft: { ...localDraft, fieldStatus, missingFields: missingFieldsOf(resume) }
    }
  }

  private awaitAgentDecision(entry: DraftEntry, kind: AgentDecisionKind): Promise<AgentDecisionChoice> {
    return new Promise<AgentDecisionChoice>((resolve, reject) => {
      entry.decisions.set(kind, { resolve, reject })
    })
  }

  /**
   * #82 逐页智能路由：每页提取文本 + 坐标 → analyzePageQuality →
   * - 硬异常或软分 ≥ 40：双栏优先坐标重排（不可靠再 OCR）；其余直接 OCR；
   * - 15–39：保留文本并标记 pending；<15：正常文本；
   * - OCR 后复检（空结果失败、仍异常标记 low-confidence）；
   * - 合并保持原页序与跨页上下文；parsePath = 全部文本 text / 全 OCR ocr / 混合 mixed。
   */
  private async routePdfPages(entry: DraftEntry): Promise<ResumeDraft> {
    const pages = await extractPdfPages(entry.filePath, MAX_PDF_PAGES) // 加密/损坏/超页数 → 明确错误
    const adapter = this.deps.ocrAdapter
    if (adapter !== undefined) await adapter.open(entry.filePath)
    const routed: Array<{ pageNo: number; text: string; source: 'text' | 'ocr'; risk?: string }> = []
    try {
      for (const page of pages) {
        if (entry.cancelled) throw new ImportCancelledError()
        const normalized = normalizeExtractedText(page.text)
        // 无文本层页按「有视觉内容」处理（扫描/照片页），有文本页不臆断视觉失配
        const hasVisual = normalized.trim() === ''
        const quality = analyzePageQuality({ text: normalized, hasVisualContent: hasVisual, items: page.items })

        // 双栏页优先坐标重排（#82：不能可靠恢复时才 OCR）
        const hasTwoColumn = quality.soft.some((s) => s.type === 'two-column-order')
        let reflowedOk = false
        if (hasTwoColumn && page.items.length >= 8) {
          const reflowed = normalizeExtractedText(reflowTwoColumn(page.items))
          const recheck = analyzePageQuality({ text: reflowed, hasVisualContent: false })
          reflowedOk = recheck.hard.length === 0 && recheck.softScore < SOFT_OCR_THRESHOLD
          if (reflowedOk) {
            routed.push({ pageNo: page.pageNo, text: reflowed, source: 'text', risk: 'reflowed' })
            continue
          }
        }

        if (quality.hard.length > 0 || quality.softScore >= SOFT_OCR_THRESHOLD) {
          if (adapter === undefined) {
            // 无 OCR adapter：硬异常页保留文本并标记需要 OCR（不建空草稿）
            routed.push({ pageNo: page.pageNo, text: normalized, source: 'text', risk: 'ocr-needed' })
            continue
          }
          this.deps.emit({ type: 'progress', token: entry.token, phase: 'ocr', detail: `第 ${page.pageNo}/${pages.length} 页` })
          const ocrText = normalizeExtractedText(await adapter.ocrPage(entry.filePath, page.pageNo, () => entry.cancelled))
          if (entry.cancelled) throw new ImportCancelledError()
          if (ocrText === '') {
            throw new Error(`OCR 第 ${page.pageNo} 页结果为空——请确认 PDF 清晰、方向正常，或换用清晰文件重试`)
          }
          // OCR 后复检：仍异常 → 低置信度标记
          const after = analyzePageQuality({ text: ocrText, hasVisualContent: false })
          routed.push({
            pageNo: page.pageNo,
            text: ocrText,
            source: 'ocr',
            risk: after.hard.length > 0 || after.softScore >= SOFT_OCR_THRESHOLD ? 'low-confidence' : undefined
          })
        } else if (quality.decision === 'pending') {
          routed.push({ pageNo: page.pageNo, text: normalized, source: 'text', risk: 'pending' })
        } else {
          routed.push({ pageNo: page.pageNo, text: normalized, source: 'text' })
        }
      }
      return buildRoutedDraft(entry.filePath, routed)
    } finally {
      if (adapter !== undefined) void adapter.dispose()
    }
  }

  private emit(type: 'progress', token: string, phase: ImportPhase): void {
    this.deps.emit({ type, token, phase })
  }

  private finishCancelled(entry: DraftEntry): void {
    entry.finished = true
    this.entries.delete(entry.token)
    this.deps.emit({ type: 'cancelled', token: entry.token })
  }
}

/**
 * 草稿 → 可编辑 Resume（本地确定性映射，Agent 不可用时的保底草稿）。
 * 规则无法表示的字段（技能分类段落、项目/经历等）留空由人工补齐；原文保留在 draft.text。
 */
export function draftToResume(draft: ResumeDraft): Resume {
  const f = draft.fields
  return {
    meta: { title: importTitleFromFileName(draft.fileName) },
    basics: {
      name: f.name ?? '',
      phone: f.phone,
      email: f.email,
      gender: f.gender === '男' || f.gender === '女' ? f.gender : undefined,
      birthday: f.birthday
    },
    education: f.education.map((e) => ({
      school: e.school ?? '',
      degree: e.degree ?? '',
      major: e.major ?? '',
      ...splitPeriod(e.period)
    }))
  }
}

/** 关键字段缺失清单（UI 待确认；姓名/教育为 schema 必填，电话/邮箱为常用关键字段）。 */
export function missingFieldsOf(resume: Resume): string[] {
  const missing: string[] = []
  if (resume.basics?.name === undefined || resume.basics.name === '') missing.push('name')
  if (resume.basics?.phone === undefined || resume.basics.phone === '') missing.push('phone')
  if (resume.basics?.email === undefined || resume.basics.email === '') missing.push('email')
  if ((resume.education ?? []).length === 0) missing.push('education')
  return missing
}

/**
 * #77 结构化提示：只接收提取文本；约束只映射/归一原文、禁止补写事实，
 * 姓名/电话/邮箱/学校/日期/数字不得猜测修改；输出须符合简历 Schema。
 */
export function buildStructurePrompt(text: string): string {
  return [
    '[简历导入结构化] 你是简历信息整理助手。下面是用户简历的提取全文（可能含 OCR 或排版噪声）。',
    '请只将原文事实映射为 resume.schema.json 结构，输出完整简历 JSON。',
    '',
    '严格遵守：',
    '1. 只能映射、归一和组织原文证据；禁止补写原文不存在的教育、项目、经历、技能、数字或任何事实，不得润色或虚构。',
    '2. 姓名、电话、邮箱、学校、日期和数字必须与原文一致，不得猜测修改。',
    '3. 原文无法表示的条目（证书、语言成绩、校园经历等）不要塞进任何字段，忽略即可。',
    '4. 输出必须符合 schema：basics.name 必填；education 非空且每条含 school/degree/major；',
    '   skills 为固定三分类（工程能力/科研能力/其他能力）每类一段话 {category, text}；',
    '   不得输出已删除字段（items/proficiency/highlights/role/link/certificates）。',
    '',
    '提取全文：',
    text
  ].join('\n')
}

/** 修正提示（首轮输出未过 schema 校验 → 携带定位修正一轮）。 */
export function buildRepairPrompt(issueText: string): string {
  return `[修正：上次输出未通过简历 Schema 校验] 请仅按以下问题修正后重新输出完整简历 JSON：\n${issueText}`
}

/** 网络类暂时错误判定（重试一次的依据；启发式，不视为产品常量）。 */
export function isTransientAgentError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /ECONN|ENET|ETIMEDOUT|timeout|超时|网络|连接|fetch failed|5\d\d/i.test(message)
}

/**
 * 逐页路由结果 → 草稿（#82）：带页码标记（Agent 理解跨页上下文 + 核对展示）、
 * 逐页来源与风险（pageRisks）、parsePath（全文本 text / 全 OCR ocr / 混合 mixed）。
 */
export function buildRoutedDraft(
  filePath: string,
  routed: Array<{ pageNo: number; text: string; source: 'text' | 'ocr'; risk?: string }>
): ResumeDraft {
  const ruleText = routed
    .filter((r) => r.text !== '')
    .map((r) => r.text)
    .join('\n')
  const draft = buildDraft(basename(filePath), ruleText)
  const markedText = routed.map((r) => `===== 第 ${r.pageNo} 页 =====\n${r.text}`).join('\n')
  const hasOcr = routed.some((r) => r.source === 'ocr')
  const allOcr = routed.every((r) => r.source === 'ocr')
  return {
    ...draft,
    text: markedText,
    pages: routed.map((r) => ({ pageNo: r.pageNo, text: r.text })),
    pageRisks: routed.map((r) => ({ pageNo: r.pageNo, source: r.source, risk: r.risk })),
    parsePath: allOcr ? 'ocr' : hasOcr ? 'mixed' : 'text',
    // 全文为空（如无 adapter 的全扫描页）→ 保持 scanned（UI 走「无法提取文本」路径，不建空草稿）
    scanned: ruleText === ''
  }
}

/**
 * 默认标题：有区分度的文件名直接用；`resume`/`简历`/`我的简历` 等通用词
 * 留空（保存时回退「姓名-基准简历」，#76 细化）。
 */
export function importTitleFromFileName(fileName: string): string {
  const stem = basename(fileName)
    .replace(/\.docx$/i, '')
    .replace(/\.pdf$/i, '')
    .trim()
  if (stem === '') return ''
  if (/^(resume|简历|我的简历|个人简历)$/i.test(stem)) return ''
  return stem
}

/** '2022-09 ~ 2026-06' / '2022-09 ~ 至今' → {startDate, endDate}（YYYY-MM；进行中无 endDate）。 */
export function splitPeriod(period: string | undefined): { startDate?: string; endDate?: string | null } {
  if (period === undefined) return {}
  const m = /((?:19|20)\d{2})-(\d{1,2})(?:\s*~\s*((?:19|20)?\d{2})-(\d{1,2}))?/.exec(period)
  if (m === null) return {}
  const startDate = `${m[1]}-${m[2].padStart(2, '0')}`
  if (m[3] === undefined) return { startDate } // 无结束段（含「至今」）→ 应届/进行中
  const endYear = m[3].length === 2 ? `20${m[3]}` : m[3]
  return { startDate, endDate: `${endYear}-${m[4].padStart(2, '0')}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
