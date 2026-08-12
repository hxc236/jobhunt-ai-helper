import { randomUUID } from 'node:crypto'
import {
  BATCHES,
  COMPANY_TYPES,
  POSITION_STATUSES,
  type Position,
  type PositionFilters,
  type PositionInput,
  type PositionListItem,
  type PositionPatch
} from '../../shared/types'
import type { Db } from '../db/migrations'

const INSERT = `
  INSERT INTO positions (
    id, company, company_type, title, jd, city, channel, channel_url,
    source, source_url, dedupe_key, recruit_season, batch,
    start_date, end_date, status, notes, created_at, updated_at
  ) VALUES (
    @id, @company, @company_type, @title, @jd, @city, @channel, @channel_url,
    'manual', NULL, @dedupe_key, @recruit_season, @batch,
    @start_date, @end_date, 'active', @notes, @created_at, @updated_at
  )
`
const LIST_SELECT = 'SELECT * FROM positions'
const LIST_ORDER = 'ORDER BY created_at DESC, rowid DESC'

const MS_PER_DAY = 86_400_000

/**
 * 网申截止倒计时（日历天）：end_date 当天 = 0、次日 = -1（已截止）。
 * 用 UTC 日序号差值，避免时区/夏令时误差；today 可注入（服务层测试 seam）。
 */
export function daysUntil(endDate: string, today: Date = new Date()): number {
  const [year, month, day] = endDate.split('-').map(Number)
  const endDay = Date.UTC(year, month - 1, day) / MS_PER_DAY
  const todayDay = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / MS_PER_DAY)
  return endDay - todayDay
}
const BY_DEDUPE = 'SELECT id FROM positions WHERE dedupe_key = ?'
const BY_ID = 'SELECT * FROM positions WHERE id = ?'

/** 职位服务错误：code 供渲染层区分「校验失败」与「重复录入」两类提示。 */
export class PositionError extends Error {
  constructor(
    readonly code: 'validation' | 'duplicate' | 'not-found',
    message: string
  ) {
    super(message)
    this.name = 'PositionError'
  }
}

/**
 * 职位卡服务（F-01：手动录入）。
 * 校验：必填=公司+岗位（+秋招季，dedupe_key 组成部分）；企业性质/批次枚举；
 * 网申日期 YYYY-MM-DD。去重：dedupe_key = company|title|recruit_season，
 * 命中抛 duplicate（不自动合并——合并更新属采集 upsert 路径，见 #5）。
 */
export class PositionService {
  constructor(private readonly db: Db) {}

  /** 创建职位卡（source=manual）。校验失败抛 PositionError('validation')，重复抛 'duplicate'。 */
  create(input: PositionInput): Position {
    const company = input.company.trim()
    const title = input.title.trim()
    const recruitSeason = input.recruit_season.trim()

    if (company === '') throw new PositionError('validation', '公司必填')
    if (title === '') throw new PositionError('validation', '岗位必填')
    if (recruitSeason === '') throw new PositionError('validation', '秋招季必填（去重键组成部分）')
    if (!(COMPANY_TYPES as readonly string[]).includes(input.company_type)) {
      throw new PositionError('validation', `企业性质只能是：${COMPANY_TYPES.join('/')}`)
    }
    if (input.batch !== undefined && !(BATCHES as readonly string[]).includes(input.batch)) {
      throw new PositionError('validation', `批次只能是：${BATCHES.join('/')}`)
    }
    for (const field of ['start_date', 'end_date'] as const) {
      const value = input[field]
      if (value !== undefined && value.trim() !== '' && !isIsoDate(value)) {
        throw new PositionError('validation', `${field} 日期必须为 YYYY-MM-DD 格式`)
      }
    }

    // 语义键去重（#5）：company|title|recruit_season；部分唯一索引 uq_positions_dedupe 兜底
    const dedupeKey = `${company}|${title}|${recruitSeason}`
    const existing = this.db.prepare(BY_DEDUPE).get(dedupeKey)
    if (existing !== undefined) {
      throw new PositionError(
        'duplicate',
        `已存在相同职位（${company} · ${title} · ${recruitSeason}），请勿重复录入`
      )
    }

    const now = new Date().toISOString()
    const row: Position = {
      id: randomUUID(),
      company,
      company_type: input.company_type,
      title,
      jd: input.jd ?? '',
      city: input.city?.trim() || null,
      channel: input.channel?.trim() || null,
      channel_url: input.channel_url?.trim() || null,
      source: 'manual',
      source_url: null,
      dedupe_key: dedupeKey,
      recruit_season: recruitSeason,
      batch: input.batch ?? null,
      start_date: input.start_date?.trim() || null,
      end_date: input.end_date?.trim() || null,
      status: 'active',
      notes: input.notes ?? '',
      created_at: now,
      updated_at: now
    }
    this.db.prepare(INSERT).run(row)
    return row
  }

  /**
   * 职位卡详情（F-03/#20）：完整职位卡（含 JD 全文/渠道链接），详情页数据源。
   * id 不存在抛 PositionError('not-found')。
   */
  get(id: string): Position {
    const row = this.db.prepare(BY_ID).get(id) as Position | undefined
    if (row === undefined) throw new PositionError('not-found', '职位不存在或已删除')
    return row
  }

  /**
   * 职位卡编辑（F-03/#20）：patch 语义——未传字段保持不变；可空字段 null/空串 → 清空；
   * 公司/岗位/秋招季变化时重算 dedupe_key 并查重（排除自身，命中抛 duplicate）。
   * 校验规则与 create 一致（必填/枚举/日期）；成功后 updated_at 刷新（now 可注入，测试 seam）。
   */
  update(id: string, patch: PositionPatch, now: () => string = () => new Date().toISOString()): Position {
    const existing = this.get(id)

    const company = patch.company === undefined ? existing.company : patch.company.trim()
    const title = patch.title === undefined ? existing.title : patch.title.trim()
    const recruitSeason =
      patch.recruit_season === undefined ? existing.recruit_season : patch.recruit_season.trim()
    const companyType = patch.company_type ?? existing.company_type
    const status = patch.status ?? existing.status
    const jd = patch.jd === undefined ? existing.jd : patch.jd
    const notes = patch.notes === undefined ? existing.notes : patch.notes

    if (company === '') throw new PositionError('validation', '公司必填')
    if (title === '') throw new PositionError('validation', '岗位必填')
    if (recruitSeason === '') throw new PositionError('validation', '秋招季必填（去重键组成部分）')
    if (!(COMPANY_TYPES as readonly string[]).includes(companyType)) {
      throw new PositionError('validation', `企业性质只能是：${COMPANY_TYPES.join('/')}`)
    }
    if (!(POSITION_STATUSES as readonly string[]).includes(status)) {
      throw new PositionError('validation', `状态只能是：${POSITION_STATUSES.join('/')}`)
    }
    const batch = patch.batch === undefined ? existing.batch : patch.batch === '' ? null : patch.batch
    if (batch !== null && !(BATCHES as readonly string[]).includes(batch)) {
      throw new PositionError('validation', `批次只能是：${BATCHES.join('/')}`)
    }
    const startDate = toNullable(patch.start_date, existing.start_date)
    const endDate = toNullable(patch.end_date, existing.end_date)
    for (const [field, value] of [
      ['start_date', startDate],
      ['end_date', endDate]
    ] as const) {
      if (value !== null && !isIsoDate(value)) {
        throw new PositionError('validation', `${field} 日期必须为 YYYY-MM-DD 格式`)
      }
    }

    // 语义键变化 → 重算并查重（排除自身；唯一索引 uq_positions_dedupe 兜底并发）
    const dedupeKey = `${company}|${title}|${recruitSeason}`
    if (dedupeKey !== existing.dedupe_key) {
      const conflict = this.db.prepare('SELECT id FROM positions WHERE dedupe_key = ? AND id != ?').get(dedupeKey, id)
      if (conflict !== undefined) {
        throw new PositionError(
          'duplicate',
          `已存在相同职位（${company} · ${title} · ${recruitSeason}），请勿重复录入`
        )
      }
    }

    this.db
      .prepare(
        `UPDATE positions SET
          company=@company, company_type=@company_type, title=@title, jd=@jd,
          city=@city, channel=@channel, channel_url=@channel_url,
          dedupe_key=@dedupe_key, recruit_season=@recruit_season, batch=@batch,
          start_date=@start_date, end_date=@end_date, status=@status, notes=@notes,
          updated_at=@updated_at
         WHERE id=@id`
      )
      .run({
        id,
        company,
        company_type: companyType,
        title,
        jd,
        city: toNullable(patch.city, existing.city),
        channel: toNullable(patch.channel, existing.channel),
        channel_url: toNullable(patch.channel_url, existing.channel_url),
        dedupe_key: dedupeKey,
        recruit_season: recruitSeason,
        batch,
        start_date: startDate,
        end_date: endDate,
        status,
        notes,
        updated_at: now()
      })
    return this.get(id)
  }

  /**
   * 职位卡删除（F-03/#20）：级联删除该职位的投递记录（applications 表由 F-05/#21 建表，
   * 此处先探测表存在性——#21 建表后删除路径自动生效，之前照常可用）；
   * 整操作在同一事务内：not-found 或失败不产生部分删除。
   */
  delete(id: string): void {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM positions WHERE id = ?').get(id)
      if (existing === undefined) throw new PositionError('not-found', '职位不存在或已删除')

      const tables = this.db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'applications'")
        .get() as { n: number }
      if (tables.n > 0) {
        this.db.prepare('DELETE FROM applications WHERE position_id = ?').run(id)
      }
      this.db.prepare('DELETE FROM positions WHERE id = ?').run(id)
    })()
  }

  /**
   * 职位卡列表（F-02/#18：四维筛选 + 倒计时）。
   * - filters：企业性质/批次/状态/秋招季，缺省维度不过滤，可任意组合（交集）；
   * - 返回行带 days_left（网申截止剩余日历天；无 end_date → null，UI 显「待核实」）；
   * - 排序保持 F-01 约定：创建时间倒序。
   */
  list(filters: PositionFilters = {}, today: Date = new Date()): PositionListItem[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}
    const season = filters.recruit_season?.trim() ?? ''
    if (filters.company_type !== undefined) {
      clauses.push('company_type = @company_type')
      params.company_type = filters.company_type
    }
    if (filters.batch !== undefined) {
      clauses.push('batch = @batch')
      params.batch = filters.batch
    }
    if (filters.status !== undefined) {
      clauses.push('status = @status')
      params.status = filters.status
    }
    if (season !== '') {
      clauses.push('recruit_season = @recruit_season')
      params.recruit_season = season
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.db.prepare(`${LIST_SELECT}${where} ${LIST_ORDER}`).all(params) as Position[]
    return rows.map((row) => ({
      ...row,
      days_left: row.end_date === null ? null : daysUntil(row.end_date, today)
    }))
  }
}

/** YYYY-MM-DD 严格校验（Date 回读一致，拦截 2026-02-31 这类越界日期）。 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** patch 可空字段归一：undefined = 保持原值；null/空串 = 清空为 NULL；其余 trim 后使用。 */
function toNullable(value: string | null | undefined, existing: string | null): string | null {
  if (value === undefined) return existing
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
