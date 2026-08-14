import { readFile } from 'node:fs/promises'
import type {
  CsvImportPreviewItem,
  CsvImportPreviewResult,
  CsvImportResult,
  CsvImportSelection,
  PositionInput,
  PositionPatch
} from '../../shared/types'
import { buildHeaderMap, detectCsvEncoding, parseCsv, parseCsvRowsToInputs } from './csv'
import { dedupeKeyOf, type PositionService, validateInput } from './position'

/**
 * CSV 导入服务（issue #70 / spec #68）：预览 + 批量 upsert。
 * - 预览：逐行复用 PositionService.create 的校验规则（validateInput 纯函数，规则零漂移），
 *   标 missingFields（公司/岗位必填、校招必填秋招季）与 exists（去重键命中已有职位）；
 * - 确认导入：新行走 create（规范插入路径，source=manual）；exists 且选更新走 update
 *   （patch 语义——未提供字段保持原值）；exists 未选更新 → 跳过（防误覆盖手动数据）；
 *   校验失败行跳过不中断，failed 带原因（顺序与请求一致）。
 */

export class CsvImportService {
  constructor(private readonly positions: PositionService) {}

  /**
   * 文件预览（#68/T3 IPC 数据源）：读文件 → 编码检测（UTF-8 含 BOM / GBK）→ 解码 →
   * CSV 解析（表头别名映射 + 坏行收集）→ 逐行校验/去重标记。
   * encoding 供渲染层展示（乱码提示依据）。
   */
  async previewFile(filePath: string): Promise<CsvImportPreviewResult> {
    const buffer = await readFile(filePath)
    const encoding = detectCsvEncoding(buffer)
    const text = new TextDecoder(encoding).decode(buffer)
    const rows = parseCsv(text)
    const headerMap = buildHeaderMap(rows[0] ?? [])
    const { inputs, errors } = parseCsvRowsToInputs(rows, headerMap)
    return { encoding, errors, items: this.preview(inputs) }
  }

  /** 预览：解析输入 → 逐行标记缺字段/校验错误/已存在（exists 由去重键实时查询，不信任调用方）。 */
  preview(inputs: PositionInput[]): CsvImportPreviewItem[] {
    return inputs.map((input) => ({
      input,
      missingFields: missingFieldsOf(input),
      error: validateInput(input),
      exists: this.positions.findByDedupeKey(dedupeKeyOf(input)) !== undefined
    }))
  }

  /**
   * 勾选导入（批量 upsert）：
   * - 校验失败行跳过不中断（failed 收集原因，顺序与请求一致）；
   * - 去重键未命中 → 插入（inserted++）；
   * - 去重键命中且 update=true → 更新已有职位（updated++）；
   * - 去重键命中且 update=false → 跳过（不更新不新建，防误覆盖）。
   */
  importSelected(items: CsvImportSelection[]): CsvImportResult {
    let inserted = 0
    let updated = 0
    const failed: string[] = []
    items.forEach((item, index) => {
      const error = validateInput(item.input)
      if (error !== null) {
        failed.push(`第 ${index + 1} 条数据行：${error}`)
        return
      }
      const existing = this.positions.findByDedupeKey(dedupeKeyOf(item.input))
      if (existing === undefined) {
        try {
          this.positions.create(item.input)
          inserted++
        } catch (err) {
          failed.push(`第 ${index + 1} 条数据行：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      if (!item.update) return // exists 且未选更新 → 跳过（防误覆盖手动数据）
      try {
        // patch 语义：CSV 行未提供的字段保持已有值（对齐 update 的 patch 契约）
        this.positions.update(existing.id, patchOf(item.input))
        updated++
      } catch (err) {
        failed.push(`第 ${index + 1} 条数据行：${err instanceof Error ? err.message : String(err)}`)
      }
    })
    return { inserted, updated, failed }
  }
}

/** 缺字段标记（与 create 校验的必填规则一致：公司/岗位必填、校招必填秋招季）。 */
function missingFieldsOf(input: PositionInput): string[] {
  const missing: string[] = []
  if (input.company.trim() === '') missing.push('company')
  if (input.title.trim() === '') missing.push('title')
  const hireType = input.hire_type ?? '校招'
  if (hireType === '校招' && (input.recruit_season ?? '').trim() === '') missing.push('recruit_season')
  return missing
}

/** PositionInput → PositionPatch：仅携带 CSV 行提供的字段（undefined 不参与 patch = 保持原值）。 */
function patchOf(input: PositionInput): PositionPatch {
  const patch: PositionPatch = { company: input.company, title: input.title }
  if (input.hire_type !== undefined) patch.hire_type = input.hire_type
  if (input.recruit_season !== undefined) patch.recruit_season = input.recruit_season
  if (input.jd !== undefined) patch.jd = input.jd
  if (input.city !== undefined) patch.city = input.city
  if (input.channel !== undefined) patch.channel = input.channel
  if (input.channel_url !== undefined) patch.channel_url = input.channel_url
  if (input.batch !== undefined) patch.batch = input.batch
  if (input.start_date !== undefined) patch.start_date = input.start_date
  if (input.end_date !== undefined) patch.end_date = input.end_date
  if (input.salary_min !== undefined) patch.salary_min = input.salary_min
  if (input.salary_max !== undefined) patch.salary_max = input.salary_max
  if (input.salary_text !== undefined) patch.salary_text = input.salary_text
  if (input.notes !== undefined) patch.notes = input.notes
  return patch
}
