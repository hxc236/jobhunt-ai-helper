import { randomUUID } from 'node:crypto'
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  APPLICATION_TRANSITIONS,
  BATCHES,
  COMPANY_TYPES,
  HIRE_TYPES,
  POSITION_STATUSES,
  type Application,
  type ApplicationPatch,
  type ApplicationStatus,
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
    start_date, end_date, hire_type, salary_min, salary_max, salary_text,
    status, notes, created_at, updated_at
  ) VALUES (
    @id, @company, @company_type, @title, @jd, @city, @channel, @channel_url,
    'manual', NULL, @dedupe_key, @recruit_season, @batch,
    @start_date, @end_date, @hire_type, @salary_min, @salary_max, @salary_text,
    'active', @notes, @created_at, @updated_at
  )
`
const LIST_SELECT =
  'SELECT p.*, (SELECT a.status FROM applications a WHERE a.position_id = p.id) AS application_status FROM positions p'
const LIST_ORDER = 'ORDER BY p.created_at DESC, p.rowid DESC'

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

/** 职位服务错误：code 供渲染层区分「校验失败/非法流转/重复录入」提示。 */
export class PositionError extends Error {
  constructor(
    readonly code: 'validation' | 'duplicate' | 'not-found' | 'transition',
    message: string
  ) {
    super(message)
    this.name = 'PositionError'
  }
}

/**
 * 职位卡服务（F-01：手动录入）。
 * 校验：必填=公司+岗位（+校招时秋招季，dedupe_key 组成部分）；企业性质/批次枚举；
 * 网申日期 YYYY-MM-DD；薪资为正整数 K（下限 ≤ 上限）。
 * 去重：dedupe_key = company|title|hire_type|recruit_season（社招/实习 recruit_season 为空串），
 * 命中抛 duplicate（不自动合并——合并更新属采集 upsert 路径，见 #5）。
 */
export class PositionService {
  constructor(private readonly db: Db) {}

  /** 创建职位卡（source=manual）。校验失败抛 PositionError('validation')，重复抛 'duplicate'。 */
  create(input: PositionInput): Position {
    // 校验规则（#68 起导出为纯函数 validateInput，CSV 导入预览/确认复用——规则零漂移）
    const error = validateInput(input)
    if (error !== null) throw new PositionError('validation', error)

    const company = input.company.trim()
    const title = input.title.trim()
    const hireType = input.hire_type ?? '校招'
    // 校招必须有届数；社招/实习无网申窗口，recruit_season 归一为空串（去重键组成部分）
    const recruitSeason = hireType === '校招' ? (input.recruit_season ?? '').trim() : ''

    // 语义键去重（#5 + issue #52）：company|title|hire_type|recruit_season；
    // 部分唯一索引 uq_positions_dedupe 兜底
    const dedupeKey = dedupeKeyOf(input)
    const existing = this.db.prepare(BY_DEDUPE).get(dedupeKey)
    if (existing !== undefined) {
      throw new PositionError(
        'duplicate',
        `已存在相同职位（${company} · ${title} · ${hireType}${recruitSeason === '' ? '' : ` · ${recruitSeason}`}），请勿重复录入`
      )
    }

    const salaryMin = input.salary_min ?? null
    const salaryMax = input.salary_max ?? null
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
      hire_type: hireType,
      salary_min: salaryMin,
      salary_max: salaryMax,
      salary_text: input.salary_text?.trim() || null,
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

  /** 按去重键查职位（#68 CSV 导入预览/确认；命中返回行 id，无 → undefined）。 */
  findByDedupeKey(dedupeKey: string): { id: string } | undefined {
    return this.db.prepare(BY_DEDUPE).get(dedupeKey) as { id: string } | undefined
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
    const hireType = patch.hire_type ?? existing.hire_type
    if (!(HIRE_TYPES as readonly string[]).includes(hireType)) {
      throw new PositionError('validation', `招聘类型只能是：${HIRE_TYPES.join('/')}`)
    }
    // 校招必须有届数；社招/实习无网申窗口，recruit_season 归一为空串
    const recruitSeason =
      hireType === '校招'
        ? (patch.recruit_season === undefined ? existing.recruit_season : patch.recruit_season.trim())
        : ''
    const companyType = patch.company_type ?? existing.company_type
    const status = patch.status ?? existing.status
    const jd = patch.jd === undefined ? existing.jd : patch.jd
    const notes = patch.notes === undefined ? existing.notes : patch.notes

    if (company === '') throw new PositionError('validation', '公司必填')
    if (title === '') throw new PositionError('validation', '岗位必填')
    if (hireType === '校招' && recruitSeason === '') throw new PositionError('validation', '秋招季必填（去重键组成部分）')
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
    const salaryMin = patch.salary_min === undefined ? existing.salary_min : patch.salary_min
    const salaryMax = patch.salary_max === undefined ? existing.salary_max : patch.salary_max
    assertSalary(salaryMin, salaryMax)
    const salaryText =
      patch.salary_text === undefined ? existing.salary_text : patch.salary_text === null || patch.salary_text.trim() === '' ? null : patch.salary_text.trim()

    // 语义键变化 → 重算并查重（排除自身；唯一索引 uq_positions_dedupe 兜底并发）
    const dedupeKey = `${company}|${title}|${hireType}|${recruitSeason}`
    if (dedupeKey !== existing.dedupe_key) {
      const conflict = this.db.prepare('SELECT id FROM positions WHERE dedupe_key = ? AND id != ?').get(dedupeKey, id)
      if (conflict !== undefined) {
        throw new PositionError(
          'duplicate',
          `已存在相同职位（${company} · ${title} · ${hireType}${recruitSeason === '' ? '' : ` · ${recruitSeason}`}），请勿重复录入`
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
          hire_type=@hire_type, salary_min=@salary_min, salary_max=@salary_max, salary_text=@salary_text,
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
        hire_type: hireType,
        salary_min: salaryMin,
        salary_max: salaryMax,
        salary_text: salaryText,
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
   * 职位卡列表（F-02/#18：四维筛选 + 倒计时；F-05/#21：+ 投递状态维度与行内 application_status）。
   * - filters：企业性质/批次/状态/秋招季/投递状态，缺省维度不过滤，可任意组合（交集）；
   * - 投递状态维度：planned 命中 planned 记录或**无投递记录**的职位（未投递），
   *   其余状态只命中存在该状态记录的职位；
   * - 返回行带 days_left（网申截止剩余日历天；无 end_date → null，UI 显「待核实」）
   *   与 application_status（无投递记录 → null）；
   * - 排序保持 F-01 约定：创建时间倒序。
   */
  list(filters: PositionFilters = {}, today: Date = new Date()): PositionListItem[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}
    const season = filters.recruit_season?.trim() ?? ''
    if (filters.company_type !== undefined) {
      clauses.push('p.company_type = @company_type')
      params.company_type = filters.company_type
    }
    if (filters.batch !== undefined) {
      clauses.push('p.batch = @batch')
      params.batch = filters.batch
    }
    if (filters.status !== undefined) {
      clauses.push('p.status = @status')
      params.status = filters.status
    }
    if (season !== '') {
      clauses.push('p.recruit_season = @recruit_season')
      params.recruit_season = season
    }
    if (filters.hire_type !== undefined) {
      clauses.push('p.hire_type = @hire_type')
      params.hire_type = filters.hire_type
    }
    if (filters.salary_min !== undefined) {
      // 区间匹配（issue #58）：职位薪资区间与 [T,∞) 相交——max≥T，或 max 空时 min≥T；
      // 两端都空的职位不命中（无薪资证据）
      clauses.push(
        '((p.salary_max IS NOT NULL AND p.salary_max >= @salary_min) OR (p.salary_max IS NULL AND p.salary_min >= @salary_min))'
      )
      params.salary_min = String(filters.salary_min)
    }
    if (filters.application_status !== undefined) {
      // planned：记录为 planned 或尚无投递记录（未投递）；其余状态：存在该状态记录
      clauses.push(`(
        EXISTS (SELECT 1 FROM applications a WHERE a.position_id = p.id AND a.status = @application_status)
        OR (@application_status = 'planned' AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.position_id = p.id))
      )`)
      params.application_status = filters.application_status
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.db.prepare(`${LIST_SELECT}${where} ${LIST_ORDER}`).all(params) as Array<
      Position & { application_status: ApplicationStatus | null }
    >
    return rows.map((row) => ({
      ...row,
      days_left: row.end_date === null ? null : daysUntil(row.end_date, today)
    }))
  }

  /** 投递记录查询（F-05/#21）：无记录返回 null（详情页据此显示「未开始投递」引导）。 */
  getApplication(positionId: string): Application | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE position_id = ?').get(positionId) as
      | Application
      | undefined
    return row ?? null
  }

  /**
   * 投递状态操作（F-05/#21）：状态机校验后更新（或创建）投递记录。
   * - 首次调用创建记录（隐含起点 planned）；每次状态变更按 APPLICATION_TRANSITIONS 校验，
   *   非法流转抛 PositionError('transition')，状态与时间戳不变；
   * - 同状态调用 = 编辑渠道/投递日期（不触发流转）；
   * - 进入 applied 且未指定 appliedDate 时自动填当天日期；
   * - 各状态 *_at 时间戳记录进入时刻（now 可注入，测试 seam）；updated_at 每次刷新。
   */
  setApplicationState(
    positionId: string,
    patch: ApplicationPatch,
    now: () => string = () => new Date().toISOString()
  ): Application {
    const position = this.get(positionId) // 职位不存在 → not-found

    const nowIso = now()
    const nextStatus = patch.status
    if (!(APPLICATION_STATUSES as readonly string[]).includes(nextStatus)) {
      throw new PositionError('validation', `投递状态只能是：${APPLICATION_STATUSES.join('/')}`)
    }
    if (patch.appliedDate !== undefined && patch.appliedDate !== null && !isIsoDate(patch.appliedDate)) {
      throw new PositionError('validation', '投递日期必须为 YYYY-MM-DD 格式')
    }

    const existing = this.getApplication(positionId)
    const from = existing?.status ?? 'planned'
    if (from !== nextStatus && !(APPLICATION_TRANSITIONS[from] as readonly string[]).includes(nextStatus)) {
      throw new PositionError(
        'transition',
        `非法流转：${APPLICATION_STATUS_LABELS[from]} → ${APPLICATION_STATUS_LABELS[nextStatus]}`
      )
    }

    const channel =
      patch.channel === undefined
        ? existing === null
          ? position.channel // 首次创建：默认复制职位卡渠道
          : existing.channel // 已有记录：不传保持（含已清空的 null）
        : patch.channel === ''
          ? null
          : patch.channel
    const appliedDate =
      patch.appliedDate === undefined
        ? existing?.applied_date ?? (nextStatus === 'applied' ? nowIso.slice(0, 10) : null)
        : patch.appliedDate === ''
          ? null
          : patch.appliedDate

    if (existing === null) {
      const row: Application = {
        id: randomUUID(),
        position_id: positionId,
        status: nextStatus,
        channel,
        applied_date: appliedDate,
        planned_at: null,
        applied_at: null,
        interviewing_at: null,
        offer_at: null,
        rejected_at: null,
        withdrawn_at: null,
        created_at: nowIso,
        updated_at: nowIso
      }
      row[STATUS_TS_COLUMN[nextStatus]] = nowIso
      this.db
        .prepare(
          `INSERT INTO applications (
            id, position_id, status, channel, applied_date,
            planned_at, applied_at, interviewing_at, offer_at, rejected_at, withdrawn_at,
            created_at, updated_at
          ) VALUES (
            @id, @position_id, @status, @channel, @applied_date,
            @planned_at, @applied_at, @interviewing_at, @offer_at, @rejected_at, @withdrawn_at,
            @created_at, @updated_at
          )`
        )
        .run(row)
    } else {
      const updated: Application = {
        ...existing,
        status: nextStatus,
        channel,
        applied_date: appliedDate,
        updated_at: nowIso
      }
      if (from !== nextStatus) {
        updated[STATUS_TS_COLUMN[nextStatus]] = nowIso
      }
      this.db
        .prepare(
          `UPDATE applications SET
            status=@status, channel=@channel, applied_date=@applied_date,
            planned_at=@planned_at, applied_at=@applied_at, interviewing_at=@interviewing_at,
            offer_at=@offer_at, rejected_at=@rejected_at, withdrawn_at=@withdrawn_at,
            updated_at=@updated_at
           WHERE id=@id`
        )
        .run(updated)
    }
    return this.getApplication(positionId) as Application
  }
}

/** YYYY-MM-DD 严格校验（Date 回读一致，拦截 2026-02-31 这类越界日期）。 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * 职位卡输入校验（纯函数；#68 起从 create 提取导出，CSV 导入预览/确认复用——规则零漂移）。
 * 返回 null = 通过；否则返回错误 message（与 create/update 抛出的 PositionError 文案一致）。
 * 规则：必填=公司+岗位（+校招秋招季）；招聘类型/企业性质/批次枚举；网申日期 YYYY-MM-DD；
 * 薪资正整数 K（下限 ≤ 上限）。
 */
export function validateInput(input: PositionInput): string | null {
  const company = input.company.trim()
  const title = input.title.trim()
  const hireType = input.hire_type ?? '校招'
  if (!(HIRE_TYPES as readonly string[]).includes(hireType)) {
    return `招聘类型只能是：${HIRE_TYPES.join('/')}`
  }
  // 校招必须有届数；社招/实习无网申窗口，recruit_season 归一为空串（去重键组成部分）
  const recruitSeason = hireType === '校招' ? (input.recruit_season ?? '').trim() : ''

  if (company === '') return '公司必填'
  if (title === '') return '岗位必填'
  if (hireType === '校招' && recruitSeason === '') return '秋招季必填（去重键组成部分）'
  if (!(COMPANY_TYPES as readonly string[]).includes(input.company_type)) {
    return `企业性质只能是：${COMPANY_TYPES.join('/')}`
  }
  if (input.batch !== undefined && !(BATCHES as readonly string[]).includes(input.batch)) {
    return `批次只能是：${BATCHES.join('/')}`
  }
  for (const field of ['start_date', 'end_date'] as const) {
    const value = input[field]
    if (value !== undefined && value.trim() !== '' && !isIsoDate(value)) {
      return `${field} 日期必须为 YYYY-MM-DD 格式`
    }
  }
  const salaryMin = input.salary_min ?? null
  const salaryMax = input.salary_max ?? null
  return salaryError(salaryMin, salaryMax)
}

/**
 * 职位卡语义去重键（#5 + issue #52）：company|title|hire_type|recruit_season。
 * 归一：字段 trim；缺省招聘类型按校招；社招/实习 recruit_season 为空串。
 * #68 起导出供 CSV 导入预览/确认复用（与 create 入库键零漂移）。
 */
export function dedupeKeyOf(
  input: Pick<PositionInput, 'company' | 'title' | 'hire_type' | 'recruit_season'>
): string {
  const company = input.company.trim()
  const title = input.title.trim()
  const hireType = input.hire_type ?? '校招'
  const recruitSeason = hireType === '校招' ? (input.recruit_season ?? '').trim() : ''
  return `${company}|${title}|${hireType}|${recruitSeason}`
}

/** 薪资校验：null 或正整数 K（下限 ≤ 上限）；返回错误信息或 null。 */
function salaryError(min: number | null, max: number | null): string | null {
  for (const [value, label] of [
    [min, '薪资下限'],
    [max, '薪资上限']
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      return `${label}必须为正整数（K/月）`
    }
  }
  if (min !== null && max !== null && min > max) {
    return '薪资下限不能高于上限'
  }
  return null
}

/** 薪资校验（create/update 内部用）：失败抛 PositionError('validation')。 */
function assertSalary(min: number | null, max: number | null): void {
  const error = salaryError(min, max)
  if (error !== null) throw new PositionError('validation', error)
}

/** 投递状态 → 状态进入时刻列名（applications 表；复盘数据来源）。
 *  类型收窄到时间戳列（值域 string|null），保证按状态索引赋值类型安全。 */
type StatusTsColumn = keyof Pick<
  Application,
  'planned_at' | 'applied_at' | 'interviewing_at' | 'offer_at' | 'rejected_at' | 'withdrawn_at'
>
const STATUS_TS_COLUMN: Record<ApplicationStatus, StatusTsColumn> = {
  planned: 'planned_at',
  applied: 'applied_at',
  interviewing: 'interviewing_at',
  offer: 'offer_at',
  rejected: 'rejected_at',
  withdrawn: 'withdrawn_at'
}

/** patch 可空字段归一：undefined = 保持原值；null/空串 = 清空为 NULL；其余 trim 后使用。 */
function toNullable(value: string | null | undefined, existing: string | null): string | null {
  if (value === undefined) return existing
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
