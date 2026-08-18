import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Resume, ResumeImportProvenance, StoredResume } from '../../shared/types/resume'
import type { ResumeDraft } from '../../shared/types'
import { parseUploadFile, ResumeParseError } from './resume-parse'
import type { ResumeService } from './resume'

/**
 * 简历导入模块（#75 起，DOCX 本地导入闭环；后续 PDF/OCR/Agent 共用此 interface）。
 * - start 同步校验（类型/大小）→ 后台异步执行（阶段事件：read → parse → map）；
 * - 草稿（文本 + 规则映射 Resume）仅存内存，确认前不写正式简历表；
 * - 取消：置 cancelled 标记，阶段间检查，取消后不产生 done；
 * - 确认：createImported 强制新基准简历（baseResumeId/targetJobId 为空）+ 溯源信息；
 * - 源文件只读、不复制、不保留路径；确认/取消/失败后释放内存草稿。
 */

/** 单文件上限：20 MB（规格 #73 Upload boundaries）。 */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** 导入阶段（UI 进度展示；后续 ticket 扩展 OCR 第 N/M 页、Agent 结构化等阶段）。 */
export type ImportPhase = 'read' | 'parse' | 'map'

/** 主 → 渲染事件（经 IPC pushEvent 转发）。 */
export type ImportEvent =
  | { type: 'progress'; token: string; phase: ImportPhase }
  | { type: 'done'; token: string; draft: ResumeDraft; resume: Resume }
  | { type: 'error'; token: string; code: string; message: string }
  | { type: 'cancelled'; token: string }

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

interface DraftEntry {
  token: string
  filePath: string
  cancelled: boolean
  finished: boolean
  draft?: ResumeDraft
}

export class ResumeImportService {
  private readonly entries = new Map<string, DraftEntry>()

  constructor(
    private readonly deps: {
      resumeService: ResumeService
      /** 事件推送（IPC 层注入 pushEvent；测试注入收集数组）。 */
      emit: (event: ImportEvent) => void
    }
  ) {}

  /**
   * 开始导入：同步校验文件（类型/大小/可读）后立即返回 token，异步阶段在后台执行。
   * 校验失败同步抛 ImportFileError（渲染层在 invoke 处直接展示）。
   */
  start(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    if (ext !== '.docx') {
      throw new ImportFileError('unsupported', `不支持的文件类型：${ext === '' ? '无扩展名' : ext}（当前仅支持 .docx）`)
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
    const entry: DraftEntry = { token: randomUUID(), filePath, cancelled: false, finished: false }
    this.entries.set(entry.token, entry)
    void this.run(entry)
    return entry.token
  }

  /** 取消导入：阶段间检查标记，取消后不产生 done。 */
  cancel(token: string): void {
    const entry = this.entries.get(token)
    if (entry === undefined || entry.finished) return
    entry.cancelled = true
  }

  /** 确认导入：校验 schema → 创建新基准简历（溯源）→ 释放草稿。 */
  confirm(token: string, resume: Resume): StoredResume {
    const entry = this.entries.get(token)
    if (entry === undefined) throw new Error('导入会话不存在或已结束')
    if (entry.cancelled) throw new Error('导入已取消，无法确认')
    if (entry.draft === undefined) throw new Error('导入尚未完成，无法确认')
    const provenance: ResumeImportProvenance = {
      fileName: basename(entry.filePath),
      fileType: 'docx',
      parsePath: 'text',
      importedAt: new Date().toISOString()
    }
    const stored = this.deps.resumeService.createImported(resume, provenance)
    this.entries.delete(token)
    return stored
  }

  /** 放弃草稿（渲染层离开导入流程）：释放内存，不写库。 */
  dispose(token: string): void {
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
      const draft = await parseUploadFile(entry.filePath)
      if (entry.cancelled) return this.finishCancelled(entry)
      this.emit('progress', token, 'map')
      const resume = draftToResume(draft)
      entry.draft = draft
      entry.finished = true
      this.deps.emit({ type: 'done', token, draft, resume })
    } catch (err) {
      if (entry.cancelled) return this.finishCancelled(entry)
      entry.finished = true
      const code = err instanceof ResumeParseError ? err.code : 'read-failed'
      this.deps.emit({ type: 'error', token, code, message: errMessage(err) })
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
