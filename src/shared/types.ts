/**
 * 领域实体类型（shared）—— 主进程服务与渲染进程共用，是 SQLite 行结构与
 * IPC 载荷的唯一事实来源（docs/architecture.md：shared/types/）。
 */

/** 企业性质枚举（F-01：录入表单只能选枚举值；positions.company_type）。 */
export const COMPANY_TYPES = ['央企', '国企', '大厂', '私企', '外企', '事业单位', '其他'] as const
export type CompanyType = (typeof COMPANY_TYPES)[number]

/** 秋招批次（positions.batch；'未知' 为采集缺省值）。 */
export const BATCHES = ['提前批', '正式批', '补录', '未知'] as const
export type Batch = (typeof BATCHES)[number]

/** 职位卡来源（positions.source）。 */
export const POSITION_SOURCES = ['manual', 'nowcoder', 'liepin'] as const
export type PositionSource = (typeof POSITION_SOURCES)[number]

/** 职位卡生命周期状态（positions.status；投递状态机 planned→… 属 applications 表，见 F-05/#21）。 */
export const POSITION_STATUSES = ['active', 'closed'] as const
export type PositionStatus = (typeof POSITION_STATUSES)[number]

/** positions 表一行（职位卡）。字段名与列名一致，行对象可直接落库/返回。 */
export interface Position {
  id: string
  company: string
  company_type: CompanyType
  title: string
  jd: string
  city: string | null
  channel: string | null
  channel_url: string | null
  source: PositionSource
  source_url: string | null
  /** company|title|recruit_season（手动录入去重键，服务生成）。 */
  dedupe_key: string
  /** 如 '2026秋招'。 */
  recruit_season: string
  batch: Batch | null
  /** 网申开始 YYYY-MM-DD。 */
  start_date: string | null
  /** 网申截止 YYYY-MM-DD（null = 待核实）。 */
  end_date: string | null
  status: PositionStatus
  notes: string
  created_at: string
  updated_at: string
}

/** 职位列表筛选（F-02/#18 四维：企业性质/批次/状态/秋招季；缺省维度 = 不过滤，可任意组合）。 */
export interface PositionFilters {
  company_type?: CompanyType
  batch?: Batch
  status?: PositionStatus
  recruit_season?: string
}

/** 职位列表行 = 职位卡 + 网申截止倒计时天数（null = 无 end_date，UI 显「待核实」）。 */
export type PositionListItem = Position & { days_left: number | null }

/** 手动录入表单输入（source 固定 'manual'；去重键与时间戳由服务生成）。 */
export interface PositionInput {
  company: string
  company_type: CompanyType
  title: string
  jd?: string
  city?: string
  /** 投递渠道：官网/牛客/猎聘/邮箱/内推… */
  channel?: string
  channel_url?: string
  recruit_season: string
  batch?: Batch
  start_date?: string
  end_date?: string
  notes?: string
}

/**
 * 职位卡编辑补丁（F-03/#20）：全部可选，未传字段保持不变；
 * 可空字段传 null 或空串 → 清空为 NULL（与录入时空串归一 null 的语义一致）；
 * 公司/岗位/秋招季变化时服务重算 dedupe_key 并查重（排除自身）。
 */
export interface PositionPatch {
  company?: string
  company_type?: CompanyType
  title?: string
  jd?: string
  city?: string | null
  channel?: string | null
  channel_url?: string | null
  recruit_season?: string
  /** 空串或 null → 清空（未指定批次）。 */
  batch?: Batch | '' | null
  start_date?: string | null
  end_date?: string | null
  status?: PositionStatus
  notes?: string
}
