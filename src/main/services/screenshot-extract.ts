import type { BossPageExtractResult } from '../../shared/types'
import { toBossPageDraft } from './boss-page-extract'

/**
 * 截图 OCR 文本 → 职位卡草稿（issue #67）。
 *
 * Windows.Media.Ocr 输出特征：中文单字空格分隔（`职 位 描 述`），且无
 * document.title / URL（截图没有页面元数据）。两步处理：
 * 1. normalizeOcrText：去掉中文字符间的空格（拉丁/数字串保留），
 *    让 BOSS 详情页段落标记（职位描述/公司介绍）可被识别；
 * 2. toScreenshotDraft：优先复用 toBossPageDraft 的 BOSS 详情页字段映射
 *    （公司/岗位/城市/薪资/JD 段落切割）；识别不到 JD 段落（非 BOSS
 *    详情页截图）→ 兜底：整段文本进 JD 字段，标题/公司留空待用户填。
 */

/** 去掉中文字符间的空格（Windows OCR 单字间距）：`职 位` → `职位`。
 * 注意只去空格不去换行：`\s` 含 \n 会把相邻两行粘在一起。 */
export function normalizeOcrText(text: string): string {
  return text
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1') // 中文间空格（不含换行）
    .replace(/(\d)[ \t]+([Kk薪·-])[ \t]*/g, '$1$2') // 数字与 K/薪/·/- 间空格
    .replace(/(\d)[ \t]+(?=[\u4e00-\u9fa5])/g, '$1') // 数字与中文间空格：`5 年` → `5年`
    .replace(/[ \t]*·[ \t]*/g, '·') // · 两侧空格
}

/**
 * 从 OCR 首行解析标题与公司（截图无 document.title）。
 * 形态：`前端开发工程师招聘-法本-BOSS直聘` → title=`前端开发工程师`、company=`法本`。
 */
function titleCompanyFromOcrFirstLine(ocrText: string): { title: string; company: string } {
  const firstLine = ocrText.split('\n').find((line) => line.trim() !== '') ?? ''
  const parts = firstLine
    .replace(/[「」]/g, '')
    .replace(/[-_\s]*BOSS\s*直聘\s*$/i, '') // 剥 `-BOSS直聘` 尾巴（OCR 可能带空格）
    .split(/[-_]/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  // 最后一段是公司；其余拼为标题（剥招聘/聘后缀）
  const company = parts.length > 1 ? (parts.pop() as string) : ''
  const title = parts.join('-').replace(/\s*(招聘信息|招聘|聘)\s*$/, '').trim()
  return { title, company }
}

/**
 * OCR 文本 → 职位卡草稿。成功带 draft；OCR 无内容 → 错误。
 * 非 BOSS 详情页形态：整段文本进 JD（兜底），title/company 留空。
 */
export function toScreenshotDraft(ocrText: string): BossPageExtractResult {
  const normalized = normalizeOcrText(ocrText).trim()
  if (normalized === '') {
    return { draft: null, error: '截图未识别到文字——请确认图片清晰且包含职位信息' }
  }
  // BOSS 详情页精准路径：复用 F8 的段落识别（职位描述→公司介绍 之间的 JD）
  const precise = toBossPageDraft({ title: '', bodyText: normalized, h1: '', url: '' })
  if (precise.draft !== null) {
    // 截图无 document.title/h1：用 OCR 首行补标题/公司
    const { title, company } = titleCompanyFromOcrFirstLine(normalized)
    if (title !== '') precise.draft.title = title
    if (company !== '') precise.draft.company = company
    return precise
  }
  // 兜底：无段落标记（非 BOSS 详情页截图）→ 整段文本进 JD
  const { title, company } = titleCompanyFromOcrFirstLine(normalized)
  return {
    draft: {
      company,
      title,
      jd: normalized,
      channel: '手动录入',
      channel_url: '',
      hire_type: '社招'
    }
  }
}
