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
 * #81 服务层 seam 测试：扫描型 PDF → OCR adapter 替身（不触真实渲染/Windows OCR）。
 * 覆盖成功（多页顺序）、进度事件、取消、空结果、失败与溯源 parsePath=ocr。
 */

class FakeOcrAdapter implements PdfOcrAdapter {
  texts: string[]
  failPage?: number
  delayMs: number
  calls: number[] = []
  disposed = false

  constructor(texts: string[], options: { failPage?: number; delayMs?: number } = {}) {
    this.texts = texts
    this.failPage = options.failPage
    this.delayMs = options.delayMs ?? 0
  }

  async open(): Promise<{ numPages: number }> {
    return { numPages: this.texts.length }
  }

  async ocrPage(_filePath: string, pageNo: number, isCancelled: () => boolean): Promise<string> {
    this.calls.push(pageNo)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.failPage === pageNo) throw new Error('OCR 引擎不可用——请确认系统已安装中文语言包')
    if (isCancelled()) return ''
    return this.texts[pageNo - 1]
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

/** 扫描 PDF fixture（无文本层，N 页空页 → scanned）。 */
function scannedPdf(pageCount: number): Promise<Buffer> {

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 72 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    for (let i = 1; i < pageCount; i++) doc.addPage()
    doc.end()
  })
}

interface Harness {
  svc: ResumeImportService
  adapter: FakeOcrAdapter
  events: ImportEvent[]
  dir: string
}

function makeHarness(texts: string[], options: { failPage?: number; delayMs?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'resume-import-ocr-'))
  const resumes = new ResumeService(openDatabase(':memory:'))
  const adapter = new FakeOcrAdapter(texts, options)
  const events: ImportEvent[] = []
  const svc = new ResumeImportService({
    resumeService: resumes,
    ocrAdapter: adapter,
    emit: (e) => events.push(e)
  })
  return { svc, adapter, events, dir }
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

describe('ResumeImportService 扫描型 PDF OCR（#81）', () => {
  it('逐页 OCR 成功：页码进度、按原页序合并、字段提取、溯源 parsePath=ocr', async () => {
    const h = makeHarness(['张伟\n电话：138-0000-1234', '教育经历\n北京理工大学 本科 计算机科学与技术'])
    const file = join(h.dir, 'scan.pdf')
    writeFileSync(file, await scannedPdf(2))
    const token = h.svc.start(file)
    await settle(h.svc, token)

    // 逐页顺序调用
    expect(h.adapter.calls).toEqual([1, 2])
    // 进度：ocr 第 N/M 页 → map
    const progress = h.events.filter((e) => e.type === 'progress' && e.token === token)
    expect(progress.map((p) => (p as { phase: string; detail?: string }).phase)).toEqual(['read', 'parse', 'ocr', 'ocr', 'map'])
    const ocrDetails = progress.filter((p) => (p as { phase: string }).phase === 'ocr').map((p) => (p as { detail?: string }).detail)
    expect(ocrDetails).toEqual(['第 1/2 页', '第 2/2 页'])

    const done = doneEvent(h, token)
    expect(done).toBeDefined()
    if (done === undefined) return
    expect(done.draft.scanned).toBe(false)
    expect(done.draft.parsePath).toBe('ocr')
    expect(done.draft.text).toContain('===== 第 1 页 =====')
    expect(done.draft.text).toContain('===== 第 2 页 =====')
    expect(done.draft.pages).toHaveLength(2)
    expect(done.draft.fields.name).toBe('张伟')
    // 确认后溯源 parsePath=ocr
    const stored = h.svc.confirm(token, { meta: {}, basics: { name: '张伟' }, education: [{ school: '北京理工大学', degree: '本科', major: '计算机' }] })
    expect(stored.meta.importedFrom?.parsePath).toBe('ocr')
    expect(stored.meta.importedFrom?.fileType).toBe('pdf')
  })

  it('取消：OCR 期间取消 → cancelled 事件、不产生 done、正式库无新增', async () => {
    const h = makeHarness(['第一页文本较长足够避免扫描误判', '第二页文本'], { delayMs: 50 })
    const file = join(h.dir, 'scan.pdf')
    writeFileSync(file, await scannedPdf(2))
    const token = h.svc.start(file)
    // 第一页 OCR 完成后取消（模拟用户点取消）
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && h.adapter.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    h.svc.cancel(token)
    await settle(h.svc, token)

    expect(h.events.some((e) => e.type === 'done' && e.token === token)).toBe(false)
    expect(h.events.some((e) => e.type === 'cancelled' && e.token === token)).toBe(true)
    expect(h.events.some((e) => e.type === 'error' && e.token === token)).toBe(false)
  })

  it('OCR 结果全部为空 → 明确错误（不建空草稿）', async () => {
    const h = makeHarness(['', ''])
    const file = join(h.dir, 'scan.pdf')
    writeFileSync(file, await scannedPdf(2))
    const token = h.svc.start(file)
    await settle(h.svc, token)

    const err = h.events.find((e) => e.type === 'error' && e.token === token)
    expect(err).toBeDefined()
    expect((err as { message: string }).message).toContain('OCR 识别结果为空')
    expect(h.events.some((e) => e.type === 'done' && e.token === token)).toBe(false)
  })

  it('OCR 引擎缺失/单页失败 → 明确错误（原因透传，UI 提供重试/换文件/手动新建）', async () => {
    const h = makeHarness(['第一页', '第二页'], { failPage: 1 })
    const file = join(h.dir, 'scan.pdf')
    writeFileSync(file, await scannedPdf(2))
    const token = h.svc.start(file)
    await settle(h.svc, token)

    const err = h.events.find((e) => e.type === 'error' && e.token === token)
    expect(err).toBeDefined()
    expect((err as { message: string }).message).toContain('中文语言包')
  })

  it('文本型 PDF 不受 OCR 路径影响：parsePath 仍为 text（回归）', async () => {
    const h = makeHarness(['不应被调用'])
    const file = join(h.dir, 'text.pdf')
    // 有文本层的 PDF（#78 路径）
    const cjkFont = 'C:/Windows/Fonts/simhei.ttf'
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 72 })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
      doc.font(cjkFont).fontSize(12).text('张伟 电话：138-0000-1234 教育经历 北京理工大学', 72, 600)
      doc.end()
    })
    writeFileSync(file, buf)
    const token = h.svc.start(file)
    await settle(h.svc, token)
    expect(h.adapter.calls).toEqual([]) // 未走 OCR
    const done = doneEvent(h, token)
    expect(done?.draft.parsePath).toBe('text')
  })
})
