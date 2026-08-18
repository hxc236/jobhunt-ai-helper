import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildResumeDocx } from './resume-docx'
import type { Resume } from '../../shared/types/resume'
import techResume from './fixtures/resume-tech.json'

/** 解压 docx buffer，返回 文件名 → 文本内容。 */
async function unzipDocx(buf: Buffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(buf)
  const out = new Map<string, string>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) out.set(name, await file.async('string'))
  }
  return out
}

/** 提取 word/document.xml 的纯文本（去标签 + 反转义）。 */
function docText(documentXml: string): string {
  return documentXml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** 与 PDF 章节一致的全量简历（含科研经历，便于验证节序与空节省略）。 */
function fullResume(): Resume {
  const base = structuredClone(techResume) as Resume
  base.research = [
    {
      title: '基于 Transformer 的命名实体识别研究',
      startDate: '2025-03',
      endDate: '2025-09',
      description: '构建中文 NER 数据集并进行数据增强；对比 BiLSTM-CRF 与预训练模型效果。',
      achievement: '以第一作者发表 EI 论文一篇'
    }
  ]
  return base
}

describe('buildResumeDocx', () => {
  it('生成结构合法的 DOCX 包（必需部件齐全，ZIP 魔数正确）', async () => {
    const buf = await buildResumeDocx(fullResume())
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    const files = await unzipDocx(buf)
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/numbering.xml'
    ]) {
      expect(files.has(required), `缺少必需部件 ${required}`).toBe(true)
    }
  })

  it('包含全部非空章节且顺序与 PDF 一致', async () => {
    const buf = await buildResumeDocx(fullResume())
    const xml = (await unzipDocx(buf)).get('word/document.xml') ?? ''
    const text = docText(xml)
    // 基本信息与求职意向
    expect(text).toContain('张伟')
    expect(text).toContain('138-0000-1234')
    expect(text).toContain('zhangwei@example.com')
    expect(text).toContain('后端开发工程师（校招）')
    expect(text).toContain('GitHub')
    // 全部章节标题按 PDF 顺序出现
    const order = ['教育背景', '实习经历', '项目经历', '科研经历', '竞赛与荣誉', '技能和其他', '自我评价']
    let last = -1
    for (const h of order) {
      const idx = text.indexOf(h)
      expect(idx, `章节「${h}」应存在`).toBeGreaterThan(-1)
      expect(idx, `章节「${h}」应保持 PDF 顺序`).toBeGreaterThan(last)
      last = idx
    }
  })

  it('空章节被省略（无科研/自我评价时不出现对应标题）', async () => {
    const resume = structuredClone(techResume) as Resume
    delete resume.research
    delete resume.selfAssessment
    const buf = await buildResumeDocx(resume)
    const text = docText((await unzipDocx(buf)).get('word/document.xml') ?? '')
    expect(text).not.toContain('科研经历')
    expect(text).not.toContain('自我评价')
    expect(text).toContain('教育背景')
  })

  it('照片以内嵌图片（media + 关系 + drawing）形式存在，不是整页图片', async () => {
    const photo = Buffer.from('fake-png-bytes')
    const buf = await buildResumeDocx(fullResume(), { ext: 'png', data: photo })
    const files = await unzipDocx(buf)
    expect(files.has('word/media/image1.png')).toBe(true)
    const rels = files.get('word/_rels/document.xml.rels') ?? ''
    expect(rels).toContain('image1.png')
    const doc = files.get('word/document.xml') ?? ''
    expect(doc).toContain('<pic:pic')
    expect(doc).toContain('r:embed="rIdPhoto"')
    const contentTypes = files.get('[Content_Types].xml') ?? ''
    expect(contentTypes).toContain('image/png')
  })

  it('长内容不截断：项目描述与技术栈完整保留', async () => {
    const resume = fullResume()
    const longDesc = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行描述内容——重复填充以便验证长内容不被截断`).join('\n')
    resume.projects = [{ name: '长内容项目', startDate: '2025-01', endDate: '2025-06', description: longDesc, techStack: ['A', 'B', 'C'] }]
    const buf = await buildResumeDocx(resume)
    const text = docText((await unzipDocx(buf)).get('word/document.xml') ?? '')
    expect(text).toContain('第 40 行描述内容')
    expect(text).toContain('A、B、C')
  })

  it('文字为真实可编辑段落（w:p/w:t），列表用 Word 编号（w:numPr）', async () => {
    const buf = await buildResumeDocx(fullResume())
    const xml = (await unzipDocx(buf)).get('word/document.xml') ?? ''
    expect(xml).toContain('<w:p>')
    expect(xml).toContain('<w:t')
    // 实习要点使用编号列表（可编辑列表而非图片/纯文本拼接）
    const highlight = '参与订单中心重构'
    expect(docText(xml)).toContain(highlight)
    expect(xml).toContain('<w:numPr>')
    // 不允许整页图片：drawing 只允许用于照片（一张），正文为文字
    const drawings = xml.match(/<w:drawing>/g) ?? []
    expect(drawings.length).toBeLessThanOrEqual(1)
    // 结构约束：run 元素不得嵌套（无效 OOXML 会被 Word 拒收或误渲染）
    expect(xml.match(/<w:r>(?:(?!<\/w:r>).)*<w:r>/s)).toBeNull()
  })

  it('空技能分类条目不输出空行', async () => {
    const resume = fullResume()
    resume.skills = [
      { category: '工程能力', text: '熟悉 TypeScript' },
      { category: '科研能力', text: '' },
      { category: '其他能力', text: '英语 CET-6' }
    ]
    const buf = await buildResumeDocx(resume)
    const text = docText((await unzipDocx(buf)).get('word/document.xml') ?? '')
    expect(text).toContain('工程能力：熟悉 TypeScript')
    expect(text).toContain('其他能力：英语 CET-6')
    expect(text).not.toContain('科研能力：')
  })
})
