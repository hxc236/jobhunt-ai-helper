import type { Batch, HireType, PositionInput } from '../../shared/types'

/**
 * CSV 解析纯函数层（issue #69 / spec #68）：
 * - parseCsv：标准 CSV 解析（引号包裹字段、`""` 转义、字段内换行、逗号分隔）；
 * - detectCsvEncoding：UTF-8 含 BOM / GBK 自动识别（Node 22 full-icu TextDecoder('gbk')，零新依赖）；
 * - buildHeaderMap / parseCsvRowsToInputs：表头别名映射（英文/中文/大小写下划线归一）+
 *   逐行转换为职位卡输入，坏行收集错误不中断整批。
 *
 * 只做结构转换（文本 → PositionInput）；必填/枚举/日期/薪资区间等业务校验在
 * 导入预览层复用 PositionService.create 的规则（T2 / spec #68「校验规则与手动录入一致」）。
 */

/** CSV 模板列 → PositionInput 字段（spec #68 数据契约；company_type 不在模板，缺省'其他'）。 */
export const CSV_FIELDS = [
  'company',
  'title',
  'hire_type',
  'recruit_season',
  'city',
  'salary_min',
  'salary_max',
  'salary_text',
  'channel',
  'channel_url',
  'start_date',
  'end_date',
  'batch',
  'jd',
  'notes'
] as const
export type CsvField = (typeof CSV_FIELDS)[number]

/**
 * 模板 CSV 文本（#68/T3 模板下载）：全字段表头（英文标准列名）+ 一条示例行。
 * 写入文件时调用方加 UTF-8 BOM 前缀（Excel 直接识别编码；BOM 也是编码检测依据）。
 */
export const CSV_TEMPLATE_TEXT = [
  'company,title,hire_type,recruit_season,city,salary_min,salary_max,salary_text,channel,channel_url,start_date,end_date,batch,jd,notes',
  '华为,前端开发工程师,校招,2027秋招,深圳,20,40,20-40K·14薪,官网,https://example.com/job/1,2026-08-01,2026-09-30,提前批,负责前端页面开发与体验优化,示例行——导入后请删除'
].join('\n')

/** 表头列 → 职位卡字段映射（buildHeaderMap 产出；未知列/重复别名列 = null）。 */
export type HeaderMap = Record<number, CsvField | null>

/** 表头别名表（键为归一化后的列名：trim + 小写 + 去空白/下划线/连字符；中文原样）。 */
const FIELD_ALIASES: Record<string, CsvField> = {
  company: 'company',
  公司: 'company',
  公司名: 'company',
  公司名称: 'company',
  title: 'title',
  岗位: 'title',
  岗位名: 'title',
  岗位名称: 'title',
  职位: 'title',
  职位名称: 'title',
  hiretype: 'hire_type',
  招聘类型: 'hire_type',
  recruitseason: 'recruit_season',
  秋招季: 'recruit_season',
  届数: 'recruit_season',
  city: 'city',
  城市: 'city',
  salarymin: 'salary_min',
  薪资下限: 'salary_min',
  最低薪资: 'salary_min',
  salarymax: 'salary_max',
  薪资上限: 'salary_max',
  最高薪资: 'salary_max',
  salarytext: 'salary_text',
  薪资文本: 'salary_text',
  薪资: 'salary_text',
  channel: 'channel',
  投递渠道: 'channel',
  渠道: 'channel',
  channelurl: 'channel_url',
  投递链接: 'channel_url',
  渠道链接: 'channel_url',
  岗位网址: 'channel_url', // #67 定案：岗位网址复用 channel_url
  startdate: 'start_date',
  开始日期: 'start_date',
  网申开始: 'start_date',
  enddate: 'end_date',
  截止日期: 'end_date',
  网申截止: 'end_date',
  结束日期: 'end_date',
  batch: 'batch',
  批次: 'batch',
  jd: 'jd',
  职位描述: 'jd',
  岗位描述: 'jd',
  notes: 'notes',
  备注: 'notes'
}

/** 列名归一：trim + 小写 + 去空白/下划线/连字符（'Hire_Type'/'Channel URL' → 'hiretype'/'channelurl'）。 */
function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * 标准 CSV 解析（RFC 4180 子集，宽松）：
 * - 逗号分隔、引号包裹字段、`""` 转义、字段内换行（\n / \r\n / 孤立 \r 均作行结束）；
 * - 引号必须出现在字段起始处（字段中引号按字面处理）；未闭合引号宽容接受（余下内容作为字段）；
 * - 空行（无任何字符）与末尾换行不产生行；BOM 前缀剥离（GBK 解码路径无 BOM，防御处理）。
 */
export function parseCsv(text: string): string[][] {
  if (text.startsWith('\uFEFF')) text = text.slice(1)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldStarted = false // 当前字段是否已有内容（区分开头的 `"` 引号标志与字面引号）

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true
      fieldStarted = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      fieldStarted = false
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (field !== '' || fieldStarted || row.length > 0) {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      fieldStarted = false
      continue
    }
    field += ch
    fieldStarted = true
  }
  if (field !== '' || fieldStarted || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * 编码检测：UTF-8 BOM（EF BB BF）→ utf8；无 BOM 时 GBK 兜底解码尝试
 * （Node 22 full-icu TextDecoder('gbk')，零新依赖）；解码失败（非法序列）回退 UTF-8。
 */
export function detectCsvEncoding(buffer: Uint8Array): 'utf8' | 'gbk' {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8'
  }
  try {
    new TextDecoder('gbk', { fatal: true }).decode(buffer)
    return 'gbk'
  } catch {
    return 'utf8'
  }
}

/**
 * 表头别名映射：每列归一化（大小写/下划线/中文别名）后映射为职位卡字段。
 * 未知列与重复别名列（如 company 与 公司 同现）置 null——重复列取最左列。
 */
export function buildHeaderMap(headerRow: string[]): HeaderMap {
  const map: HeaderMap = {}
  const seen = new Set<CsvField>()
  headerRow.forEach((cell, index) => {
    const field = FIELD_ALIASES[normalizeHeaderCell(cell)]
    if (field !== undefined && !seen.has(field)) {
      map[index] = field
      seen.add(field)
    } else {
      map[index] = null
    }
  })
  return map
}

/** 逐行转换结果：可导入输入 + 坏行错误（顺序与数据行一致，供上层报告）。 */
export interface CsvParseOutcome {
  inputs: PositionInput[]
  errors: string[]
}

/**
 * 表头映射 + 逐行转换（rows[0] 为表头，headerMap 由 buildHeaderMap 产出）：
 * - 字段值 trim；空值归一为 undefined（company/title 保留空串，供校验层标缺字段）；
 * - salary_min/max 字符串 → 数字（非数字 = 坏行错误）；hire_type/batch 枚举与日期
 *   原样透传（业务校验在导入预览层复用 create 规则，避免规则漂移）；
 * - 坏行（列数多于表头、薪资非数字）收集错误并跳过，不中断整批；
 *   列数不足补空、全空行跳过不报错（Excel 导出常见形态）；
 * - company_type 不在模板列，缺省 '其他'（与采集入库路径一致）。
 */
export function parseCsvRowsToInputs(rows: string[][], headerMap: HeaderMap): CsvParseOutcome {
  if (rows.length === 0) {
    return { inputs: [], errors: ['CSV 文件为空'] }
  }
  const header = rows[0]
  const mappedCount = header.reduce(
    (n, _cell, i) => (headerMap[i] === undefined || headerMap[i] === null ? n : n + 1),
    0
  )
  if (mappedCount === 0) {
    return {
      inputs: [],
      errors: ['表头未识别到任何有效列——请使用模板列名（company/公司、title/岗位…）或下载模板']
    }
  }

  const inputs: PositionInput[] = []
  const errors: string[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((cell) => cell.trim() === '')) continue // 空行跳过（Excel 导出常见尾行）
    if (row.length > header.length) {
      errors.push(`第 ${r} 条数据行列数不匹配（表头 ${header.length} 列，实际 ${row.length} 列），已跳过`)
      continue
    }
    // 列数不足 → 末尾补空（Excel 导出常见），不报错
    const cells =
      row.length === header.length ? row : [...row, ...Array<string>(header.length - row.length).fill('')]

    const input: PositionInput = { company: '', company_type: '其他', title: '' }
    let bad: string | null = null
    for (let c = 0; c < header.length; c++) {
      const field = headerMap[c]
      if (field === null || field === undefined) continue
      const value = cells[c].trim()
      if (value === '') continue
      switch (field) {
        case 'company':
          input.company = value
          break
        case 'title':
          input.title = value
          break
        case 'hire_type':
          input.hire_type = value as HireType // 枚举校验在预览层复用 create 规则
          break
        case 'recruit_season':
          input.recruit_season = value
          break
        case 'city':
          input.city = value
          break
        case 'salary_min':
        case 'salary_max': {
          const n = Number(value)
          if (Number.isNaN(n)) {
            bad = `第 ${r} 条数据行${field === 'salary_min' ? '薪资下限' : '薪资上限'}「${value}」不是数字，已跳过`
            break
          }
          if (field === 'salary_min') input.salary_min = n
          else input.salary_max = n
          break
        }
        case 'salary_text':
          input.salary_text = value
          break
        case 'channel':
          input.channel = value
          break
        case 'channel_url':
          input.channel_url = value
          break
        case 'start_date':
          input.start_date = value
          break
        case 'end_date':
          input.end_date = value
          break
        case 'batch':
          input.batch = value as Batch // 枚举校验在预览层复用 create 规则
          break
        case 'jd':
          input.jd = value
          break
        case 'notes':
          input.notes = value
          break
      }
      if (bad !== null) break
    }
    if (bad !== null) {
      errors.push(bad)
      continue
    }
    inputs.push(input)
  }
  return { inputs, errors }
}
