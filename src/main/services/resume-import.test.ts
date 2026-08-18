import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { openDatabase } from '../db/database'
import { ResumeService } from './resume'
import { ImportFileError, ResumeImportService, type ImportEvent } from './resume-import'
import type { Resume } from '../../shared/types/resume'

/**
 * #75 服务层 seam 测试：ResumeImportService（注入 ResumeService + emit 回调）。
 * DOCX fixture 由 jszip 程序生成（规格：解析测试用程序生成 fixture）。
 */

const MAX = 20 * 1024 * 1024

/** 生成含给定文本的最小合法 DOCX。 */
async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text
      .split('\n')
      .map((line) => `<w:p><w:r><w:t>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
      .join('')}<w:sectPr/></w:body></w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const SAMPLE_TEXT = [
  '张伟',
  '电话：138-0000-1234',
  '邮箱：zhangwei@example.com',
  '本科 北京理工大学 计算机科学与技术 2022-09 ~ 2026-06',
  '技能：Java、Spring Boot、TypeScript'
].join('\n')

interface Harness {
  svc: ResumeImportService
  resumes: ResumeService
  events: ImportEvent[]
  dir: string
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'resume-import-'))
  const resumes = new ResumeService(openDatabase(':memory:'))
  const events: ImportEvent[] = []
  const svc = new ResumeImportService({ resumeService: resumes, emit: (e) => events.push(e) })
  return { svc, resumes, events, dir }
}

function writeFixture(dir: string, name: string, buf: Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, buf)
  return p
}

/** 等待 import 流程结束（done/error/cancelled 事件出现即返回）。 */
async function settle(svc: ResumeImportService, token: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (svc.isFinished(token)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('import 流程未在超时内结束')
}

describe('ResumeImportService（#75 DOCX 本地导入）', () => {
  it('start 同步拒绝不支持的类型与超 20 MB 文件', () => {
    const h = makeHarness()
    const pdf = writeFixture(h.dir, 'a.pdf', Buffer.from('%PDF-1.4'))
    expect(() => h.svc.start(pdf)).toThrowError(ImportFileError)
    try {
      h.svc.start(pdf)
    } catch (err) {
      expect((err as ImportFileError).code).toBe('unsupported')
    }
    const big = writeFixture(h.dir, 'big.docx', Buffer.alloc(MAX + 1))
    try {
      h.svc.start(big)
      expect.unreachable('超限文件应被拒绝')
    } catch (err) {
      expect((err as ImportFileError).code).toBe('too-large')
    }
  })

  it('DOCX 全文提取并按规则映射为保底草稿，进度事件覆盖读取→解析→生成', async () => {
    const h = makeHarness()
    const file = writeFixture(h.dir, 'resume-zhang.docx', await makeDocx(SAMPLE_TEXT))
    const token = h.svc.start(file)
    await settle(h.svc, token)

    const done = h.events.find((e) => e.type === 'done' && e.token === token)
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.draft.fileName).toBe('resume-zhang.docx')
    expect(done.draft.text).toContain('北京理工大学')
    expect(done.draft.fields.name).toBe('张伟')
    expect(done.draft.fields.phone).toBe('13800001234')
    expect(done.draft.fields.education.length).toBeGreaterThan(0)
    // 保底草稿映射为可编辑 Resume：姓名/电话/邮箱/教育填入表单
    expect(done.resume.basics.name).toBe('张伟')
    expect(done.resume.basics.phone).toBe('13800001234')
    expect(done.resume.basics.email).toBe('zhangwei@example.com')
    expect(done.resume.education[0]?.school).toBe('北京理工大学')
    // 阶段顺序：读取 → 解析 → 生成
    const phases = h.events.filter((e) => e.type === 'progress' && e.token === token).map((e) => (e as { phase: string }).phase)
    expect(phases).toEqual(['read', 'parse', 'map'])
  })

  it('损坏的 DOCX 进入 error 事件（read-failed），不产生 done', async () => {
    const h = makeHarness()
    const file = writeFixture(h.dir, 'broken.docx', Buffer.from('not a zip at all'))
    const token = h.svc.start(file)
    await settle(h.svc, token)
    const err = h.events.find((e) => e.type === 'error' && e.token === token)
    expect(err).toBeDefined()
    expect((err as { code: string }).code).toBe('read-failed')
    expect(h.events.some((e) => e.type === 'done' && e.token === token)).toBe(false)
  })

  it('取消后不产生 done，confirm 拒绝；取消是静默（无 error 展示给用户）', async () => {
    const h = makeHarness()
    const file = writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT))
    const token = h.svc.start(file)
    h.svc.cancel(token)
    await settle(h.svc, token)
    expect(h.events.some((e) => e.type === 'done' && e.token === token)).toBe(false)
    // cancelled 是独立事件（UI 静默关闭，不当作错误展示）
    expect(h.events.some((e) => e.type === 'cancelled' && e.token === token)).toBe(true)
    const resume: Resume = { meta: {}, basics: { name: '张伟' }, education: [] }
    expect(() => h.svc.confirm(token, resume)).toThrowError(/已取消|已结束/)
  })

  it('确认前正式简历列表无新增；确认后创建新基准简历并保存溯源信息', async () => {
    const h = makeHarness()
    const file = writeFixture(h.dir, 'resume-zhang.docx', await makeDocx(SAMPLE_TEXT))
    const token = h.svc.start(file)
    await settle(h.svc, token)
    expect(h.resumes.list()).toEqual([]) // 确认前不入库

    const resume: Resume = { meta: {}, basics: { name: '张伟' }, education: [{ school: '北京理工大学', degree: '本科', major: '计算机' }] }
    const stored = h.svc.confirm(token, resume)
    const list = h.resumes.list()
    expect(list).toHaveLength(1)
    expect(stored.meta.baseResumeId).toBeNull()
    expect(stored.meta.targetJobId).toBeNull()
    expect(stored.meta.importedFrom).toEqual({
      fileName: 'resume-zhang.docx',
      fileType: 'docx',
      parsePath: 'text',
      importedAt: stored.meta.importedFrom?.importedAt
    })
    expect(stored.meta.importedFrom?.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // 同一 token 二次确认被拒绝（草稿已释放，不残留）
    expect(() => h.svc.confirm(token, resume)).toThrow()
  })

  it('草稿标题：有区分度的文件名直接用，通用文件名留空（保存时回退“姓名-基准简历”）', async () => {
    const h = makeHarness()
    const file1 = writeFixture(h.dir, '技术向简历-2026.docx', await makeDocx(SAMPLE_TEXT))
    const token1 = h.svc.start(file1)
    await settle(h.svc, token1)
    const done1 = h.events.find((e) => e.type === 'done' && e.token === token1)
    expect((done1 as { resume: Resume }).resume.meta.title).toBe('技术向简历-2026')

    const file2 = writeFixture(h.dir, '简历.docx', await makeDocx(SAMPLE_TEXT))
    const token2 = h.svc.start(file2)
    await settle(h.svc, token2)
    const done2 = h.events.find((e) => e.type === 'done' && e.token === token2)
    expect((done2 as { resume: Resume }).resume.meta.title).toBe('')
  })

  it('源文件不被复制或长期保留（仅临时读取；确认后草稿释放）', async () => {
    const h = makeHarness()
    const file = writeFixture(h.dir, 's.docx', await makeDocx(SAMPLE_TEXT))
    const token = h.svc.start(file)
    await settle(h.svc, token)
    h.svc.confirm(token, { meta: {}, basics: { name: '张伟' }, education: [] })
    // 目录中仍只有原始上传文件（无任何导入复制产物）
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(h.dir)).toEqual(['s.docx'])
    // 草稿已释放：确认后不残留可再次确认的控制器
    expect(h.svc.isFinished(token)).toBe(true)
    expect(h.svc.hasDraft(token)).toBe(false)
  })
})

describe('ResumeService.createImported（#75 溯源）', () => {
  it('拒绝非法简历；强制 baseResumeId/targetJobId 为空并写入 importedFrom', () => {
    const resumes = new ResumeService(openDatabase(':memory:'))
    const stored = resumes.createImported(
      { meta: { baseResumeId: 'res-old', targetJobId: 'pos-1' }, basics: { name: '李四' }, education: [{ school: 'X大学', degree: '本科', major: '计算机' }] },
      { fileName: 'a.docx', fileType: 'docx', parsePath: 'text', importedAt: '2026-01-01T00:00:00Z' }
    )
    expect(stored.meta.baseResumeId).toBeNull()
    expect(stored.meta.targetJobId).toBeNull()
    expect(stored.meta.importedFrom?.fileName).toBe('a.docx')
  })
})
