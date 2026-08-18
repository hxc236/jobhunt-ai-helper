/**
 * PDF 逐页质量判断（#79 初始阈值 + #73 规格信号；#81/#82 用其路由文本/OCR）。
 *
 * 本模块实现 #73「PDF page routing」的硬异常/软异常评分：
 * - 硬异常直接进入 OCR：无文本层但有视觉内容、替换字符/NUL、控制或私用区字符占比 ≥ 5%、
 *   视觉内容与文本量严重不匹配；文本提取失败由调用方（parse 层）直接路由 OCR，不进入本函数。
 * - 软异常累计风险分（初始分值，见各常量注释）：总分 ≥ 40 → OCR（或可靠坐标重排），
 *   15–39 → 保留文本但标记待确认，< 15 → 正常文本路径。
 * - 阈值是待 OCR 基准测试（#79/#82）校准的初始值，不是行业标准常量；修改需附基准证据。
 */

export interface PageQualityInput {
  /** 本页已提取的文本。 */
  text: string
  /** 页面是否有明显视觉内容（渲染非空白；无文本层的扫描页为 true）。 */
  hasVisualContent: boolean
  /** 文本层字符坐标（pdfjs getTextContent items；双栏判断依据，可缺省）。 */
  items?: Array<{ str: string; x: number; y: number }>
}

export type PageQualityDecision = 'ocr' | 'pending' | 'text'

/** 硬异常类型（#73：任一命中直接 OCR）。 */
export type HardAnomaly =
  | 'no-text-with-visual'
  | 'replacement-or-nul'
  | 'control-or-private-ratio'
  | 'visual-text-mismatch'

/** 软异常类型（#73：累计风险分）。 */
export type SoftAnomaly =
  | 'low-valid-ratio'
  | 'sparse-rich-page'
  | 'fragmented-words'
  | 'two-column-order'
  | 'key-format-anomaly'
  | 'duplicate-or-truncated'

export interface PageQualityResult {
  hard: HardAnomaly[]
  soft: Array<{ type: SoftAnomaly; score: number; detail: string }>
  /** 软异常累计分。 */
  softScore: number
  decision: PageQualityDecision
  reason: string
}

// ---------- 初始阈值与分值（#79 初始值，待 OCR 基准校准） ----------

/** 控制字符或私用区字符占比达到该阈值 → 硬异常（#73 初始 5%）。 */
export const HARD_CONTROL_RATIO = 0.05
/** 视觉内容与文本量严重不匹配：有视觉内容但文本不足该字符数 → 硬异常。 */
export const HARD_VISUAL_TEXT_MIN = 30
/** 软异常进入 OCR 的分值阈值（#73 初始 40）。 */
export const SOFT_OCR_THRESHOLD = 40
/** 软异常标记待确认的下限（#73 初始 15；低于则不提示）。 */
export const SOFT_PENDING_MIN = 15
/** 有效中英文/数字比例下限（低于 → 30 分）。 */
export const SOFT_VALID_RATIO = 0.7
/** 文本稀少但页面内容丰富：文本不足该字符数且页面有视觉内容 → 30 分。 */
export const SOFT_SPARSE_TEXT_MAX = 120
/** 连续单字断裂（如「张 伟 北 京」）组数下限 → 20 分。
 *  用「连续」而非单处空格：简历行内字段分隔（如「北京理工大学 本科」）不是断词。 */
export const SOFT_FRAGMENT_GROUPS = 1
/** 双栏：坐标 x 落左/右两个聚类区间的 items 占比下限 → 25 分。 */
export const SOFT_TWO_COLUMN_RATIO = 0.6
/** 重复行 / 截断迹象 → 15 分。 */

const SCORE: Record<SoftAnomaly, number> = {
  'low-valid-ratio': 30,
  'sparse-rich-page': 30,
  'fragmented-words': 20,
  'two-column-order': 25,
  'key-format-anomaly': 15,
  'duplicate-or-truncated': 15
}

/**
 * 分析一页：返回硬异常清单、软异常分项与累计分、路由决策。
 * 稀疏但正常的内容页（如简历尾页只有一行）不得被误判——依赖 hasVisualContent 区分。
 */
export function analyzePageQuality(input: PageQualityInput): PageQualityResult {
  const text = input.text
  const hard: HardAnomaly[] = []
  const soft: Array<{ type: SoftAnomaly; score: number; detail: string }> = []

  // ---------- 硬异常 ----------
  if (input.hasVisualContent && text.trim() === '') {
    hard.push('no-text-with-visual')
  }
  if (text.includes('\uFFFD') || text.includes('\u0000')) {
    hard.push('replacement-or-nul')
  }
  if (text.length > 0) {
    const controlPrivate = text.match(/[\x00-\x1F\uE000-\uF8FF]/g) ?? []
    if (controlPrivate.length / text.length >= HARD_CONTROL_RATIO) {
      hard.push('control-or-private-ratio')
    }
  }
  if (input.hasVisualContent && text.trim().length > 0 && text.trim().length < HARD_VISUAL_TEXT_MIN) {
    hard.push('visual-text-mismatch')
  }

  if (hard.length > 0) {
    return {
      hard,
      soft,
      softScore: 0,
      decision: 'ocr',
      reason: `硬异常：${hard.join('、')}`
    }
  }

  // ---------- 软异常 ----------
  const trimmed = text.trim()
  const nonSpace = trimmed.replace(/\s+/g, '')
  const valid = nonSpace.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) ?? []
  const validRatio = nonSpace.length === 0 ? 1 : valid.length / nonSpace.length
  if (validRatio < SOFT_VALID_RATIO) {
    soft.push({ type: 'low-valid-ratio', score: SCORE['low-valid-ratio'], detail: `有效字符比例 ${Math.round(validRatio * 100)}% < ${SOFT_VALID_RATIO * 100}%` })
  }

  if (input.hasVisualContent && trimmed.length > 0 && trimmed.length < SOFT_SPARSE_TEXT_MAX) {
    soft.push({ type: 'sparse-rich-page', score: SCORE['sparse-rich-page'], detail: `文本稀少(${trimmed.length} 字符)但页面内容丰富` })
  }

  const fragmentGroups = (trimmed.match(/(?:[\u4e00-\u9fa5] ){3,}[\u4e00-\u9fa5]/g) ?? []).length
  if (fragmentGroups >= SOFT_FRAGMENT_GROUPS) {
    soft.push({ type: 'fragmented-words', score: SCORE['fragmented-words'], detail: `连续单字断裂 ${fragmentGroups} 组` })
  }

  if (detectTwoColumn(input.items ?? [])) {
    soft.push({ type: 'two-column-order', score: SCORE['two-column-order'], detail: '坐标呈双栏分布，阅读顺序可能错乱' })
  }

  const keyAnomalies = detectKeyFormatAnomalies(trimmed)
  if (keyAnomalies.length > 0) {
    soft.push({ type: 'key-format-anomaly', score: SCORE['key-format-anomaly'], detail: keyAnomalies.join('；') })
  }

  if (detectDuplicateOrTruncated(trimmed)) {
    soft.push({ type: 'duplicate-or-truncated', score: SCORE['duplicate-or-truncated'], detail: '重复行或截断迹象' })
  }

  const softScore = soft.reduce((sum, item) => sum + item.score, 0)
  if (softScore >= SOFT_OCR_THRESHOLD) {
    return { hard, soft, softScore, decision: 'ocr', reason: `软异常累计 ${softScore} 分 ≥ ${SOFT_OCR_THRESHOLD}` }
  }
  if (softScore >= SOFT_PENDING_MIN) {
    return { hard, soft, softScore, decision: 'pending', reason: `软异常累计 ${softScore} 分（${SOFT_PENDING_MIN}–${SOFT_OCR_THRESHOLD - 1} 待确认）` }
  }
  return { hard, soft, softScore, decision: 'text', reason: `无硬异常，软异常累计 ${softScore} 分 < ${SOFT_PENDING_MIN}` }
}

/** 双栏：x 坐标集中在左/右两个聚类区间（首尾 1/3）的 items 占比 ≥ 阈值 → 可疑。 */
function detectTwoColumn(items: Array<{ str: string; x: number }>): boolean {
  const valid = items.filter((i) => i.str.trim() !== '')
  if (valid.length < 8) return false
  const xs = valid.map((i) => i.x)
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  const span = max - min
  if (span <= 0) return false
  const inEdgeClusters = valid.filter((i) => i.x - min < span * 0.33 || max - i.x < span * 0.33).length
  const ratio = inEdgeClusters / valid.length
  // 纯文本流文本 x 分布连续（单栏），双栏则大量落在两侧
  return ratio >= SOFT_TWO_COLUMN_RATIO
}

/** 关键字段格式异常（#73：电话/邮箱/日期/GPA；初始启发式，不做事实猜测）。 */
function detectKeyFormatAnomalies(text: string): string[] {
  const anomalies: string[] = []
  // 年份被截断的日期（如 202-09）：20xx 只有 3 位
  if (/\b(?:19|20)\d{1}[-/.]\d{1,2}\b/.test(text)) anomalies.push('日期年份异常（可能截断）')
  // 电话号码混入字母（0/O、1/l/I 混淆）
  if (/\b1[3-9][0-9OoIiLl]{8,9}\b/.test(text)) anomalies.push('电话含疑似字母（0/O、1/l/I 混淆）')
  // 含 @ 但邮箱残缺（缺域名点）
  if (/[\w.+-]+@[\w-]+\s*$/.test(text) && !/@[\w-]+\.[\w-]+/.test(text)) anomalies.push('邮箱格式异常')
  return anomalies
}

/** 重复/丢行/截断迹象：非空行重复，或「多行内容」末行无结束标点且极短（截断）。
 *  单行短页（如正常尾页）不判截断——防止所有稀疏页面被误 OCR（#79 反例）。 */
function detectDuplicateOrTruncated(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line)) return true
    seen.add(line)
  }
  const last = lines[lines.length - 1] ?? ''
  if (lines.length > 2 && last.length > 0 && last.length < 12 && !/[。！？；：.!?;:…]/.test(last)) return true
  return false
}
