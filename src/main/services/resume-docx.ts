import JSZip from 'jszip'
import type { Resume, ResumeSectionKey } from '../../shared/types/resume'
import { resolveSectionOrder } from '../../shared/types/resume'
import { dateRange, esc } from './resume-render'

/**
 * 简历 DOCX 导出（#74）：真实可编辑 Word 文档生成（纯函数，无 IO）。
 * - 用 jszip 直接生成最小合法 DOCX 包（WordprocessingML），不使用整页图片；
 * - 章节与 A4 PDF（resume-render.renderSheet）顺序一致：头部 → 教育背景 → 实习经历
 *   → 项目经历 → 科研经历 → 竞赛与荣誉 → 技能和其他 → 自我评价；空章节不输出；
 * - #91：分节顺序遵循 resume.sectionOrder（缺省默认顺序），项目渲染优先 highlights；
 * - 文字为真实段落（w:p/w:t），列表为 Word 编号（w:numPr），照片以内嵌图片（media + drawing）；
 * - Word/WPS 中可继续编辑；分页由 Word 自然处理（不承诺像素级分页一致）。
 */

/** DOCX 内嵌照片：ext 决定 media 文件名与 mime（png/jpg/jpeg/webp/gif）。 */
export interface DocxPhoto {
  ext: string
  data: Buffer
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** A4 页面（twips）：宽 210mm / 高 297mm，四边 2cm 页边距。 */
const PAGE_W = 11906
const PAGE_H = 16838
const MARGIN = 1134
/** 正文可用宽度（twips）＝ 页宽 − 左右边距；右侧制表位停在此处。 */
const TEXT_W = PAGE_W - MARGIN * 2

interface RunProps {
  bold?: boolean
  /** 字号（半磅，如 22 = 11pt） */
  size?: number
  /** 文字颜色（十六进制，不含 #） */
  color?: string
}

/** 单个文本 run：中文 eastAsia 字体恒为微软雅黑，正文 11pt。 */
function run(text: string, props: RunProps = {}): string {
  const size = props.size ?? 22
  const rPr = `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${
    props.bold ? '<w:b/>' : ''
  }${props.color !== undefined ? `<w:color w:val="${props.color}"/>` : ''}</w:rPr>`
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

/** 制表位 run（右对齐日期前）。 */
function tabRun(): string {
  return '<w:r><w:tab/></w:r>'
}

interface ParaProps {
  /** Word 编号列表（numbering.xml numId 1：圆点） */
  numId?: number
  /** 右侧制表位（右对齐日期用） */
  rightTab?: boolean
  align?: 'left' | 'right' | 'center'
  /** 段落下边框（章节标题用） */
  borderBottom?: { sz: number; color: string }
  spacingBefore?: number
  spacingAfter?: number
}

/** 段落：由完整 run 元素组成（不接受未包裹文本，避免嵌套 w:r）。 */
function para(runs: string[], props: ParaProps = {}): string {
  const spacing =
    props.spacingBefore !== undefined || props.spacingAfter !== undefined
      ? `<w:spacing ${props.spacingBefore !== undefined ? `w:before="${props.spacingBefore}" ` : ''}${props.spacingAfter !== undefined ? `w:after="${props.spacingAfter}"` : ''}/>`
      : ''
  const tabs = props.rightTab ? `<w:tabs><w:tab w:val="right" w:pos="${TEXT_W - 100}"/></w:tabs>` : ''
  const jc = props.align !== undefined ? `<w:jc w:val="${props.align}"/>` : ''
  const num = props.numId !== undefined ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${props.numId}"/></w:numPr>` : ''
  const pBdr =
    props.borderBottom !== undefined
      ? `<w:pBdr><w:bottom w:val="single" w:sz="${props.borderBottom.sz}" w:space="2" w:color="${props.borderBottom.color}"/></w:pBdr>`
      : ''
  const pPr = `<w:pPr>${spacing}${tabs}${jc}${num}${pBdr}</w:pPr>`
  return `<w:p>${pPr}${runs.join('')}</w:p>`
}

/** 普通正文段。 */
function bodyP(text: string, props: ParaProps = {}): string {
  return para([run(text)], { spacingAfter: 120, ...props })
}

/** 章节标题：蓝色加粗 + 下边框，与 A4 h2 视觉一致。 */
function sectionHeading(title: string): string {
  return para([run(title, { bold: true, size: 28, color: '2B5CA8' })], {
    spacingBefore: 240,
    spacingAfter: 120,
    borderBottom: { sz: 8, color: '2B5CA8' }
  })
}

/** 条目头：左加粗 + 右日期（右制表位）。 */
function entryHead(left: string, right: string): string {
  const runs = [run(left, { bold: true })]
  if (right !== '') runs.push(tabRun(), run(right))
  return para(runs, { spacingBefore: 120, spacingAfter: 40, rightTab: right !== '' })
}

/** 条目次级行（如 GPA · 排名）。 */
function entrySub(text: string): string {
  return para([run(text, { size: 21 })], { spacingAfter: 40 })
}

/** 列表项（Word 编号圆点）。 */
function bullet(text: string): string {
  return para([run(text)], { numId: 1, spacingAfter: 40 })
}

/** 描述按行拆条：1 条 → 段落；多条 → 列表（与 PDF renderDescLines 语义一致）。 */
function descLines(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length <= 1) {
    return lines.length === 1 ? bodyP(lines[0]) : ''
  }
  return lines.map(bullet).join('')
}

/** 标签行（技术栈等），顿号连接。 */
function tagLine(label: string, values: string[]): string {
  if (values.length === 0) return ''
  return para([run(`${label}：${values.join('、')}`, { size: 21 })])
}

// ---------- 各章节 ----------

/** 头部：姓名 + 事实行 + 链接 + 求职意向；有照片时左右分栏（边框表，Word 可编辑）。 */
function renderHeader(resume: Resume, photo?: DocxPhoto): string {
  const b = resume.basics ?? {}
  const intent = b.jobIntention ?? {}
  const facts = [
    ['电话', b.phone],
    ['邮箱', b.email],
    ['性别', b.gender],
    ['生日', b.birthday],
    ['政治面貌', b.politicalStatus],
    ['生源地', b.hometown],
    ['现居城市', b.location]
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')

  const leftParts: string[] = []
  leftParts.push(para([run(b.name, { bold: true, size: 36 })], { spacingAfter: 40 }))
  if (facts.length > 0) {
    leftParts.push(bodyP(facts.map(([, v]) => v).join('　|　'), { spacingAfter: 40 }))
  }
  const links = (b.links ?? []).filter((l) => l.url !== undefined && l.url !== '')
  if (links.length > 0) {
    leftParts.push(bodyP(links.map((l) => `${l.label ?? l.url ?? ''}：${l.url ?? ''}`).join('　'), { spacingAfter: 40 }))
  }
  if (intent.position !== undefined || (intent.city ?? []).length > 0) {
    const cityText = (intent.city ?? []).join(' / ')
    const intentText = `求职意向：${intent.position ?? '—'}${cityText !== '' ? `　·　期望城市：${cityText}` : ''}${
      intent.salary !== undefined && intent.salary !== '' ? `　·　${intent.salary}` : ''
    }`
    leftParts.push(bodyP(intentText))
  }

  if (photo === undefined) return leftParts.join('')
  // 照片右列：无边框表格，左列正文、右列图片（保持与 A4 头部一致的左右排布）
  const photoXml = `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r>${photoRun()}</w:r></w:p>`
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="240" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:vAlign w:val="top"/></w:tcPr>${leftParts.join(
    ''
  )}</w:tc><w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:vAlign w:val="top"/></w:tcPr>${photoXml}</w:tc></w:tr></w:tbl>`

  function photoRun(): string {
    return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="723900" cy="952500"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="photo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="2" name="photo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdPhoto"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="723900" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  }
}

function renderEducation(education: Resume['education']): string {
  const parts: string[] = []
  for (const e of education) {
    parts.push(entryHead(`${e.school}　${e.degree} · ${e.major}`, dateRange(e.startDate, e.endDate)))
    const bits = [e.gpa !== undefined && e.gpa !== '' ? `GPA ${e.gpa}` : null, e.rank !== undefined && e.rank !== '' ? `排名 ${e.rank}` : null].filter(
      (v): v is string => v !== null
    )
    if (bits.length > 0) parts.push(entrySub(bits.join('　·　')))
    if ((e.courses ?? []).length > 0) parts.push(tagLine('相关课程', e.courses ?? []))
  }
  return parts.join('')
}

function renderExperience(experience: Resume['experience']): string {
  const parts: string[] = []
  for (const x of experience ?? []) {
    parts.push(entryHead(`${x.company ?? ''}　${x.title ?? ''}`.trim(), dateRange(x.startDate, x.endDate)))
    for (const h of x.highlights ?? []) {
      if (h.trim() !== '') parts.push(bullet(h))
    }
    if ((x.techStack ?? []).length > 0) parts.push(tagLine('技术栈', x.techStack ?? []))
  }
  return parts.join('')
}

function renderProjects(projects: Resume['projects']): string {
  const parts: string[] = []
  for (const p of projects ?? []) {
    parts.push(entryHead(p.name ?? '', dateRange(p.startDate, p.endDate)))
    // #91：优先渲染结构化要点（≤4 条）；无要点时回退到 description（旧数据）
    const highlights = (p.highlights ?? []).filter((h) => h.trim() !== '')
    if (highlights.length > 0) {
      for (const h of highlights) parts.push(bullet(h))
    } else if (p.description !== undefined && p.description !== '') {
      parts.push(descLines(p.description))
    }
    if ((p.techStack ?? []).length > 0) parts.push(tagLine('技术栈', p.techStack ?? []))
  }
  return parts.join('')
}

function renderResearch(research: Resume['research']): string {
  const parts: string[] = []
  for (const r of research ?? []) {
    parts.push(entryHead(r.title ?? '', dateRange(r.startDate, r.endDate)))
    if (r.description !== undefined && r.description !== '') parts.push(descLines(r.description))
    if (r.achievement !== undefined && r.achievement !== '') parts.push(bodyP(`成果：${r.achievement}`))
  }
  return parts.join('')
}

function renderSkills(skills: Resume['skills']): string {
  return (skills ?? [])
    .filter((s) => s.text.trim() !== '')
    .map((s) => para([run(s.category, { bold: true }), run(`：${s.text}`)], { spacingAfter: 80 }))
    .join('')
}

/** 按节渲染（#91：sectionOrder 驱动的分节渲染）；空节返回空串。 */
function renderDocxSection(resume: Resume, section: ResumeSectionKey): string {
  switch (section) {
    case 'education':
      return (resume.education ?? []).length > 0
        ? `${sectionHeading('教育背景')}${renderEducation(resume.education ?? [])}`
        : ''
    case 'experience':
      return (resume.experience ?? []).length > 0
        ? `${sectionHeading('实习经历')}${renderExperience(resume.experience ?? [])}`
        : ''
    case 'projects':
      return (resume.projects ?? []).length > 0
        ? `${sectionHeading('项目经历')}${renderProjects(resume.projects ?? [])}`
        : ''
    case 'research': {
      const research = (resume.research ?? []).filter(
        (r) => (r.title ?? '') !== '' || (r.description ?? '') !== '' || (r.achievement ?? '') !== ''
      )
      return research.length > 0 ? `${sectionHeading('科研经历')}${renderResearch(research)}` : ''
    }
    case 'honors':
      return (resume.honors ?? []).length > 0
        ? `${sectionHeading('竞赛与荣誉')}${bodyP((resume.honors ?? []).join('　·　'))}`
        : ''
    case 'skills':
      return (resume.skills ?? []).length > 0
        ? `${sectionHeading('技能和其他')}${renderSkills(resume.skills ?? [])}`
        : ''
    case 'selfAssessment':
      return resume.selfAssessment !== undefined && resume.selfAssessment !== ''
        ? `${sectionHeading('自我评价')}${bodyP(resume.selfAssessment)}`
        : ''
    case 'basics':
      return ''
  }
}

// ---------- DOCX 包组装 ----------

/** 简历 → 可编辑 DOCX 二进制（Word/WPS 可打开；空章节省略，长内容自然分页）。 */
export async function buildResumeDocx(resume: Resume, photo?: DocxPhoto): Promise<Buffer> {
  const hasPhoto = photo !== undefined
  const mediaExt = photo !== undefined ? normalizeExt(photo.ext) : 'png'

  const parts: string[] = [renderHeader(resume, photo)]
  // #91：分节顺序遵循 resume.sectionOrder（缺省默认顺序）；头部恒在首位
  for (const section of resolveSectionOrder(resume.sectionOrder)) {
    if (section === 'basics') continue
    const sectionHtml = renderDocxSection(resume, section)
    if (sectionHtml !== '') parts.push(sectionHtml)
  }

  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${parts.join(
    ''
  )}<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypesXml(hasPhoto, mediaExt))
  zip.file('_rels/.rels', rootRelsXml())
  zip.file('word/document.xml', documentXml)
  zip.file('word/numbering.xml', numberingXml())
  zip.file('word/_rels/document.xml.rels', documentRelsXml(hasPhoto, mediaExt))
  if (photo !== undefined) {
    zip.file(`word/media/image1.${mediaExt}`, photo.data)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/** 扩展名归一：jpeg → jpg，其余原样。 */
function normalizeExt(ext: string): string {
  return ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase()
}

function contentTypesXml(hasPhoto: boolean, mediaExt: string): string {
  const mime = IMAGE_MIME[mediaExt]
  const photoDefault =
    hasPhoto && mime !== undefined ? `<Default Extension="${mediaExt}" ContentType="${mime}"/>` : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${photoDefault}</Types>`
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
}

function documentRelsXml(hasPhoto: boolean, mediaExt: string): string {
  const photoRel = hasPhoto
    ? `<Relationship Id="rIdPhoto" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.${mediaExt}"/>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${photoRel}</Relationships>`
}

/** 圆点列表编号（numId 1）。 */
function numberingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
}
