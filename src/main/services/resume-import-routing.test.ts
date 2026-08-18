import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PDFDocument from 'pdfkit'
import { openDatabase } from '../db/database'
import { ResumeService } from './resume'
import { ResumeImportService, type ImportEvent } from './resume-import'
import type { PdfOcrAdapter } from './ocr-import'

/**
 * #82 服务层 seam 测试：混合/乱码/双栏 PDF 逐页智能路由（OCR adapter 替身）。
 * 覆盖：混合 PDF（文本页 + 扫描页 → mixed）、硬异常页 → OCR、双栏坐标重排、
 * 稀疏正常尾页不误 OCR、OCR 后复检低置信度、无 adapter 时 ocr-needed。
 */

class FakeOcrAdapter implements PdfOcrAdapter {
  /** 每页 OCR 返回（index = pageNo-1）；不返回的页默认 ''. */
  texts: Record<number, string>
  calls: number[] = []

  constructor(texts: Record<number, string> = {}) {
    this.texts = texts
  }

  async open(): Promise<{ numPages: number }> {
    return { numPages: 999 }
  }

  async ocrPage(_filePath: string, pageNo: number, isCancelled: () => boolean): Promise<string> {
    this.calls.push(pageNo)
    if (isCancelled()) return ''
    return this.texts[pageNo] ?? ''
  }

  async dispose(): Promise<void> {}
}

interface Harness {
  svc: ResumeImportService
  adapter: FakeOcrAdapter
  events: ImportEvent[]
  dir: string
}

function makeHarness(adapter?: FakeOcrAdapter): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'resume-import-routing-'))
  const resumes = new ResumeService(openDatabase(':memory:'))
  const fake = adapter ?? new FakeOcrAdapter()
  const events: ImportEvent[] = []
  const svc = new ResumeImportService({
    resumeService: resumes,
    ocrAdapter: fake,
    emit: (e) => events.push(e)
  })
  return { svc, adapter: fake, events, dir }
}

async function settle(svc: ResumeImportService, token: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (svc.isFinished(token)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('import 流程未在超时内结束')
}

function doneEvent(h: Harness, token: string) {
  return h.events.find((e) => e.type === 'done' && e.token === token) as Extract<ImportEvent, { type: 'done' }> | undefined
}

/** 多页 PDF：每组文本占一页（空组 = 扫描页）。 */
function multiPagePdf(pageGroups: string[][]): Promise<Buffer> {
  const cjkFont = 'C:/Windows/Fonts/simhei.ttf'
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 72 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    pageGroups.forEach((lines, i) => {
      if (i > 0) doc.addPage()
      for (let k = 0; k < lines.length; k++) {
        doc.font(cjkFont).fontSize(12).text(lines[k], 72, 720 - k * 60)
      }
    })
    doc.end()
  })
}

describe('ResumeImportService 逐页智能路由（#82）', () => {
  it('混合 PDF：页1 文本直接提取、页2 扫描走 OCR，parsePath=mixed 且保持原页序', async () => {
    const h = makeHarness(new FakeOcrAdapter({ 2: '张伟\n电话：138-0000-1234' }))
    const file = join(h.dir, 'mixed.pdf')
    writeFileSync(file, await multiPagePdf([['第一页：个人信息'], []]))
    const token = h.svc.start(file)
    await settle(h.svc, token)

    expect(h.adapter.calls).toEqual([2]) // 仅页 2 OCR
    const done = doneEvent(h, token)
    expect(done).toBeDefined()
    if (done === undefined) return
    expect(done.draft.parsePath).toBe('mixed')
    expect(done.draft.text).toContain('===== 第 1 页 =====')
    expect(done.draft.text).toContain('===== 第 2 页 =====')
    const p1 = done.draft.text.indexOf('第一页')
    const p2 = done.draft.text.indexOf('张伟')
    expect(p2).toBeGreaterThan(p1) // 原页序
    expect(done.draft.pageRisks).toEqual([
      { pageNo: 1, source: 'text', risk: undefined },
      { pageNo: 2, source: 'ocr', risk: undefined }
    ])
    // 确认后溯源 parsePath=mixed
    const stored = h.svc.confirm(token, { meta: {}, basics: { name: '张伟' }, education: [{ school: '北京理工大学', degree: '本科', major: '计算机' }] })
    expect(stored.meta.importedFrom?.parsePath).toBe('mixed')
  })

  it('硬异常页（替换字符）→ OCR', async () => {
    const h = makeHarness(new FakeOcrAdapter({ 1: '张伟 电话：138-0000-1234 教育经历 北京理工大学' }))
    const file = join(h.dir, 'bad.pdf')
    writeFileSync(file, await multiPagePdf([['张伟\uFFFD电话 乱码页']]))
    const token = h.svc.start(file)
    await settle(h.svc, token)
    expect(h.adapter.calls).toEqual([1])
    const done = doneEvent(h, token)
    expect(done?.draft.pageRisks?.[0]).toMatchObject({ pageNo: 1, source: 'ocr' })
  })

  it('双栏页优先坐标重排（reflowed 标记），不 OCR', async () => {
    const h = makeHarness(new FakeOcrAdapter({}))
    const file = join(h.dir, 'two-col.pdf')
    // 用两列布局文本生成 PDF（pdfkit 手动摆位）
    const cjkFont = 'C:/Windows/Fonts/simhei.ttf'
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 72 })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
      const lines = [
        ['姓名', 72], ['张伟', 72], ['电话', 72], ['138-0000-1234', 72],
        ['教育经历', 400], ['北京理工大学', 400], ['本科计算机', 400], ['2022-2026', 400]
      ]
      for (let i = 0; i < lines.length; i++) {
        doc.font(cjkFont).fontSize(12).text(lines[i][0] as string, lines[i][1] as number, 600 - Math.floor(i / 2) * 24)
      }
      doc.end()
    })
    writeFileSync(file, buf)
    const token = h.svc.start(file)
    await settle(h.svc, token)

    expect(h.adapter.calls).toEqual([]) // 双栏重排，不 OCR
    const done = doneEvent(h, token)
    expect(done?.draft.pageRisks?.[0]?.risk).toBe('reflowed')
    expect(done?.draft.pageRisks?.[0]?.source).toBe('text')
  })

  it('稀疏正常尾页 → 文本路径，不误 OCR', async () => {
    const h = makeHarness(new FakeOcrAdapter({}))
    const file = join(h.dir, 'tail.pdf')
    writeFileSync(file, await multiPagePdf([['张伟', '电话：138-0000-1234', '教育经历 北京理工大学'], ['第 3 页']]))
    const token = h.svc.start(file)
    await settle(h.svc, token)
    expect(h.adapter.calls).toEqual([]) // 两页都走文本
    const done = doneEvent(h, token)
    expect(done?.draft.parsePath).toBe('text')
    expect(done?.draft.text).toContain('第 3 页')
  })

  it('OCR 后复检仍异常（乱码）→ low-confidence 风险标记', async () => {
    const h = makeHarness(new FakeOcrAdapter({ 1: '%%%%%%%&&&&&@@@@@### 张 伟 北 京 理 工' }))
    const file = join(h.dir, 'garbage.pdf')
    writeFileSync(file, await multiPagePdf([[]]))
    const token = h.svc.start(file)
    await settle(h.svc, token)
    const done = doneEvent(h, token)
    expect(done?.draft.pageRisks?.[0]).toMatchObject({ pageNo: 1, source: 'ocr', risk: 'low-confidence' })
  })

  it('无 OCR adapter：硬异常页 ocr-needed（不建空草稿），文本页正常', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-import-routing-'))
    const resumes = new ResumeService(openDatabase(':memory:'))
    const events: ImportEvent[] = []
    const noAdapter = new ResumeImportService({ resumeService: resumes, emit: (e) => events.push(e) })
    const file = join(dir, 'mixed2.pdf')
    writeFileSync(file, await multiPagePdf([['正常文本页内容足够长'], []]))
    const token = noAdapter.start(file)
    await settle(noAdapter, token)
    const done = events.find((e) => e.type === 'done' && e.token === token)
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.draft.pageRisks?.[1]).toMatchObject({ pageNo: 2, risk: 'ocr-needed' })
    expect(done.draft.pageRisks?.[0]).toMatchObject({ pageNo: 1, source: 'text' })
  })
})
