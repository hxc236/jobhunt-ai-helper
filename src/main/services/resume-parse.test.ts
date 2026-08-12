import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import PDFDocument from 'pdfkit'
import { parseUploadFile, ResumeParseError } from './resume-parse'

/** 简历样例文本（docx/pdf 共用内容）。 */
const SAMPLE_TEXT = `张伟
求职意向：后端开发工程师（校招）
电话：138-0000-1234
邮箱：zhangwei@example.com
性别：男
出生日期：2004-06-15
教育经历
北京理工大学 本科 计算机科学与技术 2022-09 ~ 2026-06
技能
Java、Python、TypeScript
Spring Boot、Redis
项目经历
校园二手交易平台`

/** 用 jszip 构建最小 docx（word/document.xml 段落）。 */
async function buildDocx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${lines.map((line) => `    <w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join('\n')}
  </w:body>
</w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * 构建最小单页 PDF：Type0 字体 + Identity-H + ToUnicode CMap（UTF-16BE hex 文本串）。
 * 无需嵌入字体程序：pdfjs 经 ToUnicode CMap 解码提取文本，中文可正常还原。
 * xref 偏移在装配时计算，保证 pdfjs 可解析。
 */
/**
 * 用 pdfkit 生成真实 PDF（内嵌字体/标准 xref）：中文用系统中文字体（simhei.ttf，Windows 自带），
 * pdfjs 经嵌入字体的 ToUnicode 正常提取。扫描件 = 无文本操作的空白页（提取为空 → 降级标记）。
 */
function buildPdf(textLines: string[]): Promise<Buffer> {
  const cjkFont = 'C:/Windows/Fonts/simhei.ttf'
  if (!existsSync(cjkFont)) {
    throw new Error(`fixture 需要中文字体：${cjkFont}（Windows 自带；测试环境要求）`)
  }
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 72 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    // 行距 60pt：触发 pdfjs 行分隔判定（hasEOL），文本按行提取（行距过小会合并为单行）
    for (let i = 0; i < textLines.length; i++) {
      doc.font(cjkFont).fontSize(12).text(textLines[i], 72, 720 - i * 60)
    }
    doc.end()
  })
}

const tempDirs = new Set<string>()
function tempFile(name: string, data: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'jobhunt-parse-'))
  tempDirs.add(dir)
  const file = join(dir, name)
  writeFileSync(file, data)
  return file
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseUploadFile 简历上传解析（F-14/#26）', () => {
  it('样例 docx 解析：提取全文 + 结构化字段（姓名/电话/邮箱/性别/生日/教育/技能）', async () => {
    const file = tempFile('resume.docx', await buildDocx(SAMPLE_TEXT.split('\n')))
    const draft = await parseUploadFile(file)

    expect(draft.fileName).toBe('resume.docx')
    expect(draft.text).toContain('北京理工大学 本科 计算机科学与技术')
    expect(draft.fields.name).toBe('张伟')
    expect(draft.fields.phone).toBe('13800001234')
    expect(draft.fields.email).toBe('zhangwei@example.com')
    expect(draft.fields.gender).toBe('男')
    expect(draft.fields.birthday).toBe('2004-06')
    expect(draft.fields.education).toHaveLength(1)
    expect(draft.fields.education[0]).toMatchObject({
      school: '北京理工大学',
      degree: '本科',
      period: expect.stringContaining('2022-09')
    })
    expect(draft.fields.skills).toEqual(expect.arrayContaining(['Java', 'Python', 'TypeScript']))
    expect(draft.scanned).toBe(false)
    expect(draft.confidence).toBe(1)
    expect(draft.missingFields).toEqual([])
  })

  it('样例 pdf 解析：文本提取 + 字段映射与 docx 一致', async () => {
    // 9 行样例（行距 60pt 保证 pdfjs 按行分隔）
    const pdfLines = [
      '张伟',
      '电话：138-0000-1234',
      '邮箱：zhangwei@example.com',
      '教育经历',
      '北京理工大学 本科 计算机科学与技术 2022-09 ~ 2026-06',
      '技能',
      'Java、Python、TypeScript',
      '项目经历',
      '校园二手交易平台'
    ]
    const file = tempFile('resume.pdf', await buildPdf(pdfLines))
    const draft = await parseUploadFile(file)

    expect(draft.fileName).toBe('resume.pdf')
    expect(draft.text).toContain('北京理工大学')
    expect(draft.text.split('\n').length).toBeGreaterThan(1) // 行结构保留
    expect(draft.fields.name).toBe('张伟')
    expect(draft.fields.phone).toBe('13800001234')
    expect(draft.fields.email).toBe('zhangwei@example.com')
    expect(draft.fields.education[0]?.degree).toBe('本科')
    expect(draft.fields.skills).toEqual(expect.arrayContaining(['Java', 'Python', 'TypeScript']))
    expect(draft.scanned).toBe(false)
  })

  it('扫描件 pdf（无可提取文本）→ scanned=true、confidence=0、缺失字段提示（降级）', async () => {
    const file = tempFile('scan.pdf', await buildPdf([]))
    const draft = await parseUploadFile(file)

    expect(draft.scanned).toBe(true)
    expect(draft.text).toBe('')
    expect(draft.confidence).toBe(0)
    expect(draft.missingFields).toEqual(['name', 'phone', 'email', 'education'])
  })

  it('字段缺失场景：confidence 按命中比例降级，missingFields 列出缺失项', async () => {
    const lines = ['李娜', '教育经历', '电子科技大学 硕士 软件工程 2022-09 ~ 2026-06']
    const file = tempFile('partial.docx', await buildDocx(lines))
    const draft = await parseUploadFile(file)

    expect(draft.fields.name).toBe('李娜')
    expect(draft.fields.phone).toBeUndefined()
    expect(draft.fields.email).toBeUndefined()
    expect(draft.fields.education).toHaveLength(1)
    expect(draft.missingFields).toEqual(['phone', 'email'])
    expect(draft.confidence).toBe(0.5) // 命中 2/4（姓名+教育）
  })

  it('不支持的文件类型 → ResumeParseError(unsupported)', async () => {
    const file = tempFile('resume.txt', Buffer.from('hello'))
    await expect(parseUploadFile(file)).rejects.toThrowError(ResumeParseError)
    await expect(parseUploadFile(file)).rejects.toThrowError(/不支持的文件类型/)
  })

  it('文件不存在 → ResumeParseError(read-failed)', async () => {
    await expect(parseUploadFile(join(tmpdir(), 'no-such-file.docx'))).rejects.toThrowError(
      ResumeParseError
    )
  })
})
