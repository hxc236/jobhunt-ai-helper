import type { PdfPageText } from './resume-parse'

/**
 * 逐页路由辅助（#82）：双栏坐标重排 + 安全文本归一。
 *
 * - reflowTwoColumn：基于字符坐标恢复双栏阅读顺序（栏内按行、左栏优先）；
 * - normalizeExtractedText：只做「安全归一」——异常空格、全半角标点、连续空白、
 *   日期分隔符形式；绝不修改姓名、电话、邮箱、学校、日期内容与任何数字
 *   （易错字符回归测试：#82 验收「不会静默猜改事实」）。
 */

const FULLWIDTH_MAP: Record<string, string> = {
  '，': ',',
  '。': '.',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '！': '!',
  '？': '?',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '—': '-'
}

/**
 * 双栏坐标重排：x 中位切分为左右两栏，栏内按 y（行）再按 x 排序，左栏优先，
 * 产出单栏阅读顺序文本。仅当字符坐标充足（调用方判断）时使用。
 */
export function reflowTwoColumn(items: PdfPageText['items']): string {
  const valid = items.filter((i) => i.str.trim() !== '')
  if (valid.length === 0) return ''
  const xs = valid.map((i) => i.x).sort((a, b) => a - b)
  const mid = xs[Math.floor(xs.length / 2)]
  const left = valid.filter((i) => i.x <= mid)
  const right = valid.filter((i) => i.x > mid)
  const byRows = (group: typeof valid): string[] => {
    const rows: Array<Array<typeof valid[number]>> = []
    const ROW_TOLERANCE = 8 // pt：y 差在容差内视为同一行
    const sorted = [...group].sort((a, b) => a.y - b.y || a.x - b.x)
    for (const item of sorted) {
      const lastRow = rows[rows.length - 1]
      if (lastRow !== undefined && Math.abs(item.y - lastRow[0].y) <= ROW_TOLERANCE) {
        lastRow.push(item)
      } else {
        rows.push([item])
      }
    }
    return rows.map((row) => row.map((i) => i.str).join(''))
  }
  const leftLines = byRows(left)
  const rightLines = byRows(right)
  // 交替合并左右栏行（行数不同时按序衔接）
  const lines: string[] = []
  const max = Math.max(leftLines.length, rightLines.length)
  for (let i = 0; i < max; i++) {
    if (i < leftLines.length) lines.push(leftLines[i])
    if (i < rightLines.length) lines.push(rightLines[i])
  }
  return lines.join('\n')
}

/**
 * 安全归一（#82）：只改形式不改事实——
 * - 全角空格 → 普通空格；连续空白折叠为单空格/单换行（保留行结构）；
 * - 全半角标点映射（中文标点 → 英文对等标点）；
 * - 日期分隔符形式（2022年09月 / 2022.09 / 2022/09 → 2022-09，不补零不猜改）。
 * 绝不动姓名/电话/邮箱/学校/日期内容/数字。
 */
export function normalizeExtractedText(text: string): string {
  // 全角空格 → 普通空格
  let out = text.replace(/\u3000/g, ' ')
  // 全半角标点
  out = out.replace(/[，。；：（）！？“”‘’—]/g, (ch) => FULLWIDTH_MAP[ch] ?? ch)
  // 连续空白折叠（保留换行结构：2+ 空格 → 1；3+ 换行 → 2）
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')
  // 日期分隔符形式归一：仅处理带「年月日」明确标记的日期（2022年9月 → 2022-9），
  // 不补零；裸 YYYY.MM / YYYY/MM 可能是不带语境的数字/小数，绝不改（#82 不得静默改事实）
  out = out.replace(/((?:19|20)\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])?日?/g, (_all, year, month, day) => {
    return day === undefined ? `${year}-${month}` : `${year}-${month}-${day}`
  })
  // 行内首尾空白清理
  out = out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
  return out.trim()
}