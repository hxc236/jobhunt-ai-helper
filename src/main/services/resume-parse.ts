import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import mammoth from 'mammoth'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ResumeDraft, ResumeFieldStatus } from '../../shared/types'

/**
 * 简历上传解析（F-14/#26）：docx（mammoth）与 pdf（pdfjs-dist）→ 文本 →
 * 结构化草稿（规则提取 + 置信度 + 待确认标记）。
 * - 解析与抓取无关的纯服务：字段提取为规则函数（可测），mammoth/pdfjs 为唯一 IO；
 * - 扫描件（无可提取文本）→ scanned 降级标记（UI 提示手动录入，spec 降级策略）；
 * - 字段级来源状态（#76）：有值→text，无值→missing；无单一整体置信度；
 *   证书/语言成绩/校园经历等 Schema 外内容保留为 unmappedText（不静默丢失）。
 */

/** 解析错误：code 供渲染层区分「不支持的类型」与「读取/解析失败」。 */
export class ResumeParseError extends Error {
  constructor(
    readonly code: 'unsupported' | 'read-failed' | 'encrypted' | 'too-many-pages',
    message: string
  ) {
    super(message)
    this.name = 'ResumeParseError'
  }
}

const require = createRequire(import.meta.url)
const PDFJS_PACKAGE_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'))

/**
 * pdfjs Node 字体资源目录。部分中文 PDF 只声明 Adobe-GB1/GB-EUC-H 等外部 CMap，
 * 不内嵌 ToUnicode；缺少这些资源时 pdfjs 会静默产出空文本/乱码并只写 warning。
 * Node PDF factory 接受文件系统路径，但要求统一 `/` 且以 `/` 结尾。
 */
function pdfjsAssetDir(name: 'cmaps' | 'standard_fonts'): string {
  return `${path.join(PDFJS_PACKAGE_DIR, name).replace(/\\/g, '/')}/`
}

/** 单页提取结果（#78：页码 + 行文本 + 字符坐标，坐标供 #82 双栏重排）。 */
export interface PdfPageText {
  pageNo: number
  text: string
  /** 字符级坐标（pdfjs transform 平移量，pt；#82 阅读顺序恢复依据）。 */
  items: Array<{ str: string; x: number; y: number }>
}

/** 解析文件为结构化草稿（按扩展名分派；.docx mammoth / .pdf pdfjs）。 */
export async function parseUploadFile(
  filePath: string,
  options: { maxPdfPages?: number } = {}
): Promise<ResumeDraft> {
  const fileName = path.basename(filePath)
  const ext = path.extname(filePath).toLowerCase()

  let draft: ResumeDraft
  if (ext === '.docx') {
    const text = await extractDocxText(filePath)
    draft = buildDraft(fileName, text)
  } else if (ext === '.pdf') {
    const pages = await extractPdfPages(filePath, options.maxPdfPages)
    draft = buildPdfDraft(fileName, pages)
  } else {
    throw new ResumeParseError('unsupported', `不支持的文件类型：${ext === '' ? '无扩展名' : ext}（支持 .docx / .pdf）`)
  }
  return draft
}

/** docx → 纯文本（mammoth.extractRawText）。 */
async function extractDocxText(filePath: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  } catch (err) {
    throw new ResumeParseError('read-failed', `docx 解析失败：${errMessage(err)}`)
  }
}

/**
 * pdf → 逐页文本（pdfjs getTextContent，仅文本层）：保留页码与字符坐标，
 * 跨页内容按原顺序返回；加密/损坏/超页数 → 明确的 ResumeParseError。
 */
export async function extractPdfPages(filePath: string, maxPages?: number): Promise<PdfPageText[]> {
  try {
    const data = new Uint8Array(await readFile(filePath))
    const loadingTask = getDocument({
      data,
      cMapUrl: pdfjsAssetDir('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetDir('standard_fonts')
    })
    let doc: PDFDocumentProxy
    try {
      doc = await loadingTask.promise
    } catch (err) {
      throw toPdfError(err)
    }
    try {
      if (maxPages !== undefined && doc.numPages > maxPages) {
        throw new ResumeParseError('too-many-pages', `PDF 共 ${doc.numPages} 页，超过 ${maxPages} 页上限，请拆分为多个文件后重试`)
      }
      const pages: PdfPageText[] = []
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo)
        const content = await page.getTextContent()
        // 逐 item 拼接：hasEOL 换行（pdfjs 行分隔判定），否则空格——保留行结构
        let pageText = ''
        const items: PdfPageText['items'] = []
        for (const item of content.items) {
          if (!('str' in item)) continue
          pageText += item.str
          if ('hasEOL' in item && item.hasEOL) pageText += '\n'
          else pageText += ' '
          if (Array.isArray(item.transform) && item.transform.length >= 6) {
            items.push({ str: item.str, x: item.transform[4], y: item.transform[5] })
          }
        }
        pages.push({ pageNo, text: pageText.trim(), items })
      }
      return pages
    } finally {
      await loadingTask.destroy()
    }
  } catch (err) {
    if (err instanceof ResumeParseError) throw err
    throw new ResumeParseError('read-failed', `pdf 解析失败：${errMessage(err)}`)
  }
}

/** pdfjs 加载失败归一：加密 / 损坏。 */
function toPdfError(err: unknown): ResumeParseError {
  const message = errMessage(err)
  if ((err instanceof Error && err.name === 'PasswordException') || /password|密码/i.test(message)) {
    return new ResumeParseError('encrypted', 'PDF 受密码保护，无法解析（不尝试绕过密码）')
  }
  return new ResumeParseError('read-failed', `pdf 解析失败：${message}`)
}

/**
 * 逐页文本 → 草稿（#78）：draft.text 带页码标记（Agent 理解跨页上下文 + 核对展示），
 * 本地规则解析用无标记文本；扫描件（无文本层）保持 text 为空并标记 scanned。
 */
export function buildPdfDraft(fileName: string, pages: PdfPageText[]): ResumeDraft {
  const ruleText = pages
    .map((p) => p.text)
    .join('\n')
    .trim()
  const draft = buildDraft(fileName, ruleText)
  if (draft.scanned) {
    // 无可提取文本 → 保持空文本（UI 走「需要 OCR」降级路径，不建空草稿）
    return { ...draft, text: '' }
  }
  const markedText = pages.map((p) => `===== 第 ${p.pageNo} 页 =====\n${p.text}`).join('\n')
  return { ...draft, text: markedText, pages: pages.map(({ pageNo, text }) => ({ pageNo, text })) }
}

/** 文本 → 草稿（规则提取 + 字段级来源状态；扫描件降级）。 */
export function buildDraft(fileName: string, rawText: string): ResumeDraft {
  const text = rawText.replace(/\r\n?/g, '\n').trim()
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const fields = parseResumeText(text)
  // 扫描件：pdf 无文本层（如拍照/扫描）→ 降级提示手动录入
  const scanned = text.length < 20
  // 字段级来源状态（#76：无单一整体置信度）：有值 → 文本提取；无值 → 缺失
  const fieldStatus: Record<string, ResumeFieldStatus> = {
    name: fields.name === undefined ? 'missing' : 'text',
    phone: fields.phone === undefined ? 'missing' : 'text',
    email: fields.email === undefined ? 'missing' : 'text',
    birthday: fields.birthday === undefined ? 'missing' : 'text',
    gender: fields.gender === undefined ? 'missing' : 'text',
    education: fields.education.length === 0 ? 'missing' : 'text',
    skills: fields.skills.length === 0 ? 'missing' : 'text'
  }
  const missingFields: string[] = []
  if (fields.name === undefined) missingFields.push('name')
  if (fields.phone === undefined) missingFields.push('phone')
  if (fields.email === undefined) missingFields.push('email')
  if (fields.education.length === 0) missingFields.push('education')

  return {
    fileName,
    text,
    fields,
    fieldStatus,
    missingFields,
    parsePath: 'text',
    unmappedText: extractUnmappedLines(lines),
    scanned
  }
}

/**
 * 未映射原文（#76）：证书/语言成绩/校园经历等 Schema 无法表示的条目原样保留，
 * 供人工并入荣誉/能力/自我评价或舍弃；不静默丢弃、不自动塞入错误字段。
 */
export function extractUnmappedLines(lines: string[]): string[] {
  const UNMAPPED_PATTERNS = [
    /证书/,
    /资格证/,
    /CET/,
    /四六级/,
    /雅思/,
    /托福/,
    /普通话/,
    /驾驶证/,
    /校园经历/,
    /学生工作/,
    /社团/,
    /学生会/,
    /语言能力/,
    /语言水平/
  ]
  return lines.filter((line) => UNMAPPED_PATTERNS.some((pattern) => pattern.test(line)))
}

/** 规则提取：姓名/电话/邮箱/性别/生日/教育/技能（确定性正则，弱启发优先保真）。 */
export function parseResumeText(text: string): ResumeDraft['fields'] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  return {
    name: guessName(lines),
    // 兼容 138-0000-1234 / 138 0000 1234 写法，提取后归一为纯数字
    phone: (() => {
      const match = text.match(/(?<!\d)1[3-9]\d{1}[- ]?\d{4}[- ]?\d{4}(?!\d)/)
      return match === null ? undefined : match[0].replace(/\D/g, '')
    })(),
    email: text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0],
    gender: text.match(/性别\s*[:：]?\s*([男女])/)?.[1],
    birthday: parseBirthday(text),
    education: parseEducation(lines),
    skills: parseSkills(lines)
  }
}

/** 姓名启发：首行且为 2-4 个中文/间隔号字符，且非「XX简历」类标题行。 */
function guessName(lines: string[]): string | undefined {
  const first = lines[0]
  if (first === undefined) return undefined
  if (!/^[\u4e00-\u9fa5·]{2,4}$/.test(first)) return undefined
  if (/简历|求职|应聘/.test(first)) return undefined
  return first
}

/** 生日：出生日期/生日/出生年月 后的 YYYY-MM（兼容 -/.年 分隔）。 */
function parseBirthday(text: string): string | undefined {
  const match = text.match(
    /(?:出生日期|生日|出生年月)\s*[:：]?\s*((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月]?(\d{1,2})?日?/
  )
  if (match === null) return undefined
  return `${match[1]}-${match[2].padStart(2, '0')}`
}

/** 教育经历：含 本科/硕士/博士/大学/学院 的行 → {school, degree, major?, period}。 */
function parseEducation(lines: string[]): ResumeDraft['fields']['education'] {
  const seen = new Set<string>()
  const entries: ResumeDraft['fields']['education'] = []
  for (const line of lines) {
    if (!/(本科|硕士|博士|大学|学院)/.test(line)) continue
    const degree = ['博士', '硕士', '本科'].find((d) => line.includes(d))
    const schoolMatch = /[\u4e00-\u9fa5]{2,}(?:大学|学院)/.exec(line)
    const school = schoolMatch?.[0]
    if (school === undefined && degree === undefined) continue
    if (school !== undefined && seen.has(school)) continue
    if (school !== undefined) seen.add(school)
    const majorMatch = /专业\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z]{2,})/.exec(line)
    entries.push({
      school,
      degree,
      major: majorMatch?.[1],
      period: parsePeriod(line)
    })
  }
  return entries
}

/** 起止时间：'2022-09 ~ 2026-06' / '2022.09-2026.06' / '2022.09 至今'。 */
function parsePeriod(line: string): string | undefined {
  const match =
    /((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月]?\d{0,2}日?\s*[~—至\-–]+\s*((?:19|20)?\d{2})[-/.年](\d{1,2})[-/.月]?\d{0,2}日?/.exec(
      line
    ) ??
    /((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月]?\d{0,2}日?\s*(至今|现在|今)/.exec(line)
  if (match === null) return undefined
  if (match[3] === '至今' || match[3] === '现在' || match[3] === '今') {
    return `${match[1]}-${match[2].padStart(2, '0')} ~ 至今`
  }
  const endYear = match[3].length === 2 ? `20${match[3]}` : match[3]
  return `${match[1]}-${match[2].padStart(2, '0')} ~ ${endYear}-${match[4].padStart(2, '0')}`
}

/** 技能：技能/掌握/熟悉 节下的行 → 分词去重（逗号/顿号/空白/斜杠分隔，上限 30）。 */
function parseSkills(lines: string[]): string[] {
  const skills: string[] = []
  let inSkillSection = false
  const END_HEADERS = /经验|经历|项目|证书|教育|自我评价|联系方式|基本信息|求职意向|荣誉|获奖/
  for (const line of lines) {
    if (/^(技能|专业技能|技术栈|掌握|熟悉)/.test(line)) {
      inSkillSection = true
      continue
    }
    if (inSkillSection && END_HEADERS.test(line)) {
      inSkillSection = false
      continue
    }
    if (!inSkillSection) continue
    for (const token of line.split(/[,，、;；/\s]+/)) {
      const skill = token.trim()
      if (skill !== '' && !skills.includes(skill) && skills.length < 30) {
        skills.push(skill)
      }
    }
  }
  return skills
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
