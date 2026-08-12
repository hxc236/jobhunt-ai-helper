import type { Resume } from './types/resume'

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
export const POSITION_SOURCES = ['manual', 'nowcoder', 'liepin', 'boss'] as const
export type PositionSource = (typeof POSITION_SOURCES)[number]

/** 招聘类型（issue #52：社招/实习无网申窗口，recruit_season 为空串）。 */
export const HIRE_TYPES = ['校招', '社招', '实习'] as const
export type HireType = (typeof HIRE_TYPES)[number]

/** 职位卡生命周期状态（positions.status；投递状态机 planned→… 属 applications 表，见 F-05/#21）。 */
export const POSITION_STATUSES = ['active', 'closed'] as const
export type PositionStatus = (typeof POSITION_STATUSES)[number]

/** 投递状态机状态（applications.status；ADR-0005 / spec #13-52）。 */
export const APPLICATION_STATUSES = [
  'planned',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn'
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

/**
 * 投递状态机流转表（F-05/#21）：planned → applied → interviewing → offer/rejected，
 * withdrawn 任意态可入且为终态（spec #13-52「可放弃」）；非法流转服务层拒绝。
 * 服务与渲染层共用（UI 据此展示可用操作）。
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  planned: ['applied', 'withdrawn'],
  applied: ['interviewing', 'offer', 'rejected', 'withdrawn'],
  interviewing: ['offer', 'rejected', 'withdrawn'],
  offer: ['withdrawn'],
  rejected: ['withdrawn'],
  withdrawn: []
}

/** 投递状态中文标签（列表徽标/详情展示）。 */
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  planned: '未投递',
  applied: '已投递',
  interviewing: '面试中',
  offer: '已拿 offer',
  rejected: '已拒绝',
  withdrawn: '已放弃'
}

/** applications 表一行（F-05/#21：投递状态机记录，与职位卡 1:1；时间戳为状态进入时刻，复盘数据来源）。 */
export interface Application {
  id: string
  position_id: string
  status: ApplicationStatus
  /** 投递渠道（默认复制职位卡渠道，可改）。 */
  channel: string | null
  /** 实际投递日期 YYYY-MM-DD（进入 applied 时自动填当天，可改）。 */
  applied_date: string | null
  planned_at: string | null
  applied_at: string | null
  interviewing_at: string | null
  offer_at: string | null
  rejected_at: string | null
  withdrawn_at: string | null
  created_at: string
  updated_at: string
}

/**
 * 投递状态操作载荷（F-05/#21）：status 必传（同状态调用 = 编辑渠道/日期，不触发流转）；
 * appliedDate/channel 可空字段 null/空串 → 清空。
 */
export interface ApplicationPatch {
  status: ApplicationStatus
  /** 实际投递日期 YYYY-MM-DD（null/空串 → 清空）。 */
  appliedDate?: string | null
  /** 投递渠道（null/空串 → 清空）。 */
  channel?: string | null
}

/** 采集模式（spec #13-16：按关键词筛选 / 全量拉取当季列表）。 */
export const CRAWL_MODES = ['filter', 'full'] as const
export type CrawlMode = (typeof CRAWL_MODES)[number]

/** 采集运行状态（crawl_runs.status；running=执行中，终态 success/partial/failed）。 */
export const CRAWL_RUN_STATUSES = ['running', 'success', 'partial', 'failed'] as const
export type CrawlRunStatus = (typeof CRAWL_RUN_STATUSES)[number]

/**
 * 采集候选职位行（F-08/#22 解析器产出；source_url 为去重主键，spec #13-18；
 * detailUrl 存在时执行框架抓详情页经 parseDetail 补全）。
 */
export interface CrawlCandidate {
  company: string
  title: string
  jd: string
  city: string | null
  channel: string | null
  channel_url: string | null
  source_url: string
  batch: Batch | null
  /** 秋招季（如 '2027秋招'；解析器从批次名推导，如牛客 27届秋招 → 2027秋招；社招/实习为空串）。 */
  recruit_season?: string | null
  /** 招聘类型（缺省按校招处理）。 */
  hire_type?: HireType
  /** 薪资下限（K/月；可空）。 */
  salary_min?: number | null
  /** 薪资上限（K/月；可空）。 */
  salary_max?: number | null
  /** 薪资原样文本（如 '20-40K·14薪'）。 */
  salary_text?: string | null
  /** 网申开始 YYYY-MM-DD。 */
  start_date: string | null
  /** 网申截止 YYYY-MM-DD（null = 待核实，猎聘无截止时间置空）。 */
  end_date: string | null
  /** 详情页 URL（抓取补全 JD 等；缺省不抓详情）。 */
  detailUrl?: string
}

/**
 * crawl_runs 一行（采集留痕；candidates_json 为候选快照——#29 预览确认的数据源）。
 * errors 为失败 URL 列表（含原因）；truncated 表示达上限截断（spec #13-22/23）。
 */
export interface CrawlRun {
  id: number
  source: PositionSource
  mode: CrawlMode
  /** 关键词（mode='filter' 时）。 */
  filter: string | null
  /** 结构化采集条件快照（hire_type/keyword/city；issue #55；旧行为 null）。 */
  conditions: CrawlConditions | null
  status: CrawlRunStatus
  url_count: number
  fetched_count: number
  candidate_count: number
  truncated: boolean
  errors: string[]
  created_at: string
}

/** 采集运行入参（F-08/#22；issue #55 结构化采集条件扩展）。 */
export interface CrawlRunOptions {
  mode: CrawlMode
  /** 关键词（mode='filter' 时传给解析器筛选；牛客按公司名过滤）。 */
  filter?: string
  /** 招聘类型（BOSS 采集条件）。 */
  hire_type?: HireType
  /** 岗位关键词（BOSS 搜索 query）。 */
  keyword?: string
  /** 城市码（BOSS city 参数，如 101020100=上海）。 */
  city?: string
  /** 本次运行的抓取冷却间隔覆盖（ms；缺省用服务默认 cooldownMs）。 */
  cooldownMs?: number
  /** 本次运行的候选上限覆盖（缺省用服务默认 maxItems=100）。 */
  maxItems?: number
}

/** 结构化采集条件快照（crawl_runs.conditions_json；issue #55 留痕）。 */
export interface CrawlConditions {
  hire_type?: HireType
  keyword?: string
  city?: string
}

/** 采集执行结果（run 为留痕行；candidates 供 #29 预览）。 */
export interface CrawlRunResult {
  run: CrawlRun
  candidates: CrawlCandidate[]
}

/** 优化模式（ADR-0004：strict 默认——不虚构；balanced——适度润色）。 */
export type OptimizationMode = 'strict' | 'balanced'

/** JD 分析缓存（positions.jd_analysis JSON 列；JD 指纹变化失效重算）。 */
export interface JdAnalysis {
  skills: string[]
  keywords: string[]
  requirements: string[]
  hardRequirements: string[]
  parsedAt: string
  /** JD 文本指纹：缓存有效性判断。 */
  jdFingerprint: string
}

/** 优化稿改动说明（UI 对比展示 + 防幻觉依据）。 */
export interface OptimizeChange {
  section: string
  before: string
  after: string
  reason: string
}

/** 优化流程输出（不落库——确认入库属 #34 UI 流程）。 */
export interface OptimizeResult {
  jobId: string
  resumeId: string
  mode: OptimizationMode
  jdAnalysis: JdAnalysis
  gaps: string[]
  optimizedResume: Resume
  changes: OptimizeChange[]
}

/** 预览行（F-11/#29）：候选 + 预测动作 + 缺字段标记。 */
export interface CrawlPreviewItem {
  candidate: CrawlCandidate
  /** 入库动作预测：source_url 或 dedupe_key 命中 → update。 */
  action: 'new' | 'update'
  /** 缺字段（title/end_date 为空；UI 标「待补全/待核实」）。 */
  missingFields: string[]
}

/** 采集预览（F-11/#29：「将新增 N / 更新 M / 缺字段 K」摘要 + 候选勾选）。 */
export interface CrawlPreview {
  run: CrawlRun
  items: CrawlPreviewItem[]
  stats: { inserted: number; updated: number; missing: number }
}

/** 确认导入结果（upsert 计数）。 */
export interface CrawlImportResult {
  inserted: number
  updated: number
}

/** 语音识别就绪状态（F-26/#40：模型缺失 → ready=false + 原因，UI 降级文字输入）。 */
export interface AsrStatus {
  ready: boolean
  /** 未就绪原因（降级提示文案）。 */
  reason?: string
}

/** 复盘维度（F-25/#39：技术深度/表达逻辑/应变/匹配度）。 */
export interface ReviewDimension {
  name: string
  /** 0-100。 */
  score: number
  comment: string
}

/** 面试复盘（F-25/#39：LLM 生成，结构校验后存 interviews.review）。 */
export interface InterviewReview {
  total: number
  dimensions: ReviewDimension[]
  strengths: string[]
  weaknesses: Array<{ item: string; reference: string }>
  nextSteps: string[]
}

/** 学习条目三态（topics.status；F-19/#33）。 */
export const TOPIC_STATUSES = ['todo', 'learning', 'learned'] as const
export type TopicStatus = (typeof TOPIC_STATUSES)[number]

/** 学习条目来源（topics.source；interview = 复盘回填，#39）。 */
export const TOPIC_SOURCES = ['hard', 'mentioned', 'gap', 'project', 'manual', 'interview'] as const
export type TopicSource = (typeof TOPIC_SOURCES)[number]

/**
 * 学习条目（F-19/#33）：优先级 1-5（hard 1 / mentioned 2 / gap 3 / project 4 / manual 5），
 * 三态流转 todo → learning → learned。
 */
export interface Topic {
  id: string
  title: string
  status: TopicStatus
  priority: number
  source: TopicSource
  /** 关联职位（清单生成来源；人工条目可为 null）。 */
  job_id: string | null
  note: string
  created_at: string
  updated_at: string
}

/** 人工创建学习条目（F-19/#33）。 */
export interface TopicInput {
  title: string
  note?: string
  jobId?: string | null
}

/** 清单生成输入（F-19/#33）：缺口/项目 techStack 可选——缺省时降级为仅 JD 分析来源。 */
export interface TopicGenerateInput {
  /** 缺口项（来自优化流程结果 gaps）。 */
  gaps?: string[]
  /** 项目 techStack（来自所选基准简历）。 */
  techStack?: string[]
}

/**
 * 上传解析草稿（F-14/#26：docx/pdf → 文本 → 结构化字段 + 置信度）。
 * 渲染层（#31 上传草稿确认 UI）据此展示待确认字段；扫描件走降级提示。
 */
export interface ResumeDraft {
  /** 原始文件名。 */
  fileName: string
  /** 提取的全文文本（扫描件为空）。 */
  text: string
  fields: {
    name?: string
    phone?: string
    email?: string
    /** YYYY-MM。 */
    birthday?: string
    gender?: string
    education: Array<{ school?: string; degree?: string; major?: string; period?: string }>
    skills: string[]
  }
  /** 0-1：关键字段（姓名/电话/邮箱/教育）命中比例；扫描件恒 0。 */
  confidence: number
  /** 缺失关键字段（UI 提示用户补全）。 */
  missingFields: string[]
  /** 扫描件（无可提取文本）→ UI 降级提示手动录入。 */
  scanned: boolean
}

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
  /** 招聘类型（去重键组成部分；社招/实习 recruit_season 为空串）。 */
  hire_type: HireType
  /** 薪资下限（K/月；可空，未登录/未填写时为空）。 */
  salary_min: number | null
  /** 薪资上限（K/月；可空）。 */
  salary_max: number | null
  /** 薪资原样文本（如 '20-40K·14薪'）。 */
  salary_text: string | null
  status: PositionStatus
  notes: string
  created_at: string
  updated_at: string
}

/** 职位列表筛选（F-02/#18 四维：企业性质/批次/状态/秋招季；缺省维度 = 不过滤，可任意组合；
 *  F-05/#21 增投递状态维度 application_status）。 */
export interface PositionFilters {
  company_type?: CompanyType
  batch?: Batch
  status?: PositionStatus
  recruit_season?: string
  /** 投递状态（applications.status）：planned 含无投递记录职位（未投递）；其余只匹配有记录的职位。 */
  application_status?: ApplicationStatus
}

/** 职位列表行 = 职位卡 + 网申截止倒计时天数（null = 无 end_date，UI 显「待核实」）+ 投递状态（无记录为 null）。 */
export type PositionListItem = Position & { days_left: number | null; application_status: ApplicationStatus | null }

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
  /** 校招必填（去重键组成部分）；社招/实习服务端归一为空串。 */
  recruit_season?: string
  batch?: Batch
  start_date?: string
  end_date?: string
  /** 招聘类型（缺省校招；社招/实习时 recruit_season 服务端置空串）。 */
  hire_type?: HireType
  /** 薪资下限（K/月）。 */
  salary_min?: number | null
  /** 薪资上限（K/月）。 */
  salary_max?: number | null
  /** 薪资原样文本。 */
  salary_text?: string
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
  /** 招聘类型变化时重算 dedupe_key（社招/实习 recruit_season 置空串）。 */
  hire_type?: HireType
  /** 薪资下限（null → 清空）。 */
  salary_min?: number | null
  /** 薪资上限（null → 清空）。 */
  salary_max?: number | null
  /** 薪资原样文本（空串或 null → 清空）。 */
  salary_text?: string | null
  status?: PositionStatus
  notes?: string
}
