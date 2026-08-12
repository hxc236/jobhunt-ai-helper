import type { CrawlCandidate, CrawlMode, HireType } from '../../../shared/types'
import type { CrawlParseContext, CrawlParser } from '../crawl'

/**
 * BOSS 直聘解析器（issue #53/#50；研究结论见 docs/research/boss-zhipin-crawlability.md）。
 *
 * 数据形态（与牛客/猎聘的 SSR HTML 不同）：BOSS 是 SPA，职位数据走页面内 XHR——
 * 框架在页面加载早期 fetch 后把响应 JSON 文本交给本解析器（纯函数，fixture 可测）：
 * - 列表：`/wapi/zpgeek/search/joblist.json` 响应 → `zpData.jobList[]`（49 字段）；
 * - 详情：`/wapi/zpgeek/job/detail.json` 响应 → `zpData.jobInfo`（JD 全文 postDescription）；
 * - 翻页：`zpData.hasMore` + 末条 `lid`（格式 `随机串.search.<页码>`）推导下一页；
 * - 薪资：`salaryDesc` 文本 → min/max（K/月）+ 原样文本；匿名会话可能为空（T1 登录态复测）；
 * - 招聘类型来自采集条件（context.hire_type）：校招入口 = 主站搜索 query=届数/校招 + jobType，
 *   社招/实习入口 = 主站搜索 query=关键词（T5 结构化条件透传；buildUrls 接线见 T6）。
 */
export class BossParser implements CrawlParser {
  readonly source = 'boss' as const

  /** 主站搜索页（SPA；query=岗位关键词、city=城市码、page=页码，研究实测有效）。 */
  static readonly SEARCH_BASE = 'https://www.zhipin.com/web/geek/job'

  /**
   * 起始列表 URL（issue #55/#56 结构化条件：关键词/城市/页码；招聘类型映射 jobType——
   * 字典实测 filter/conditions.json：全职=1901、实习=1902；校招走关键词含届数）。
   */
  buildUrls(mode: CrawlMode, _filter: string | undefined, context?: CrawlParseContext): string[] {
    void mode
    const keyword = context?.keyword?.trim()
    const city = context?.city?.trim()
    if (keyword === undefined && city === undefined) {
      return [BossParser.SEARCH_BASE]
    }
    return [searchUrl(keyword ?? '', city ?? '', 1, context?.hire_type ?? '校招')]
  }

  parseList(html: string, context: CrawlParseContext): CrawlCandidate[] {
    let payload: unknown
    try {
      payload = JSON.parse(html)
    } catch {
      return []
    }
    const jobList = readJobList(payload)
    if (jobList === null) return []

    const hireType = context.hire_type ?? '校招'
    return jobList
      .map((item) => this.toCandidate(item, hireType, context.keyword))
      .filter((c) => c !== null) as CrawlCandidate[]
  }

  /** 下一页 URL：hasMore 且末条 lid 含页码 → page+1（条件从 context 取）；否则 null。 */
  nextListUrl(html: string, context: CrawlParseContext): string | null {
    let payload: unknown
    try {
      payload = JSON.parse(html)
    } catch {
      return null
    }
    if (readHasMore(payload) !== true) return null
    const page = lastPageFromLid(payload)
    if (page === null || context.keyword === undefined || context.city === undefined) return null
    return searchUrl(context.keyword, context.city, page + 1, context.hire_type ?? '校招')
  }

  /** 详情 JSON → 补全候选（JD 全文/岗位全名/薪资）。 */
  parseDetail(html: string, candidate: CrawlCandidate): CrawlCandidate {
    let payload: unknown
    try {
      payload = JSON.parse(html)
    } catch {
      return candidate
    }
    const jobInfo = readJobInfo(payload)
    if (jobInfo === null) return candidate
    const salary = parseSalary(String(jobInfo.salaryDesc ?? ''))
    return {
      ...candidate,
      title: String(jobInfo.positionName ?? jobInfo.jobName ?? candidate.title).trim(),
      jd: String(jobInfo.postDescription ?? '').trim(),
      salary_min: salary.min,
      salary_max: salary.max,
      salary_text: salary.text
    }
  }

  private toCandidate(
    item: Record<string, unknown>,
    hireType: HireType,
    keyword: string | undefined
  ): CrawlCandidate | null {
    const company = String(item.brandName ?? '').trim()
    const title = String(item.jobName ?? '').trim()
    const encryptJobId = String(item.encryptJobId ?? '').trim()
    if (company === '' || title === '' || encryptJobId === '') return null
    const securityId = String(item.securityId ?? '').trim()
    const salary = parseSalary(String(item.salaryDesc ?? ''))
    return {
      company,
      title,
      jd: '', // 列表无 JD；详情接口补全（parseDetail）
      city: item.cityName ? String(item.cityName).trim() : null,
      channel: null,
      channel_url: null,
      source_url: `https://www.zhipin.com/job_detail/${encryptJobId}.html`,
      // 详情入口 = detail.json 接口（securityId 主键；框架在页面内 fetch，见 T6）
      detailUrl:
        securityId === ''
          ? undefined
          : `https://www.zhipin.com/wapi/zpgeek/job/detail.json?securityId=${securityId}`,
      batch: null,
      hire_type: hireType,
      recruit_season: hireType === '校招' ? seasonFromKeyword(keyword) : '',
      salary_min: salary.min,
      salary_max: salary.max,
      salary_text: salary.text,
      start_date: null,
      // BOSS 岗位无网申窗口字段：校招走主站搜索亦无截止（缺字段按招聘类型判定，社招/实习=长期有效）
      end_date: null
    }
  }
}

/** 薪资解析结果（K/月 数值 + 原样文本；非 K 单位/面议/空 → 数值 null）。 */
export interface SalaryParts {
  min: number | null
  max: number | null
  text: string | null
}

/**
 * 薪资文本 → min/max（K/月，整数）。支持形态（研究实录/公开格式）：
 * - "20-40K·14薪" / "15-20K·13薪" → 区间（14薪/13薪 等后缀忽略，原文本保留）；
 * - "30K以上" → 仅下限；"20K-30K" → 双侧带 K；
 * - "薪资面议" / "200-300元/天"（日薪，非 K/月）→ 数值 null，原文本保留；
 * - 空串 → 全 null（匿名会话常见，T1 登录态复测）。
 */
export function parseSalary(desc: string): SalaryParts {
  const text = desc.trim()
  if (text === '') return { min: null, max: null, text: null }

  const range = text.match(/(\d+(?:\.\d+)?)\s*K?\s*[-~至]\s*(\d+(?:\.\d+)?)\s*K/i)
  if (range !== null) {
    return { min: toK(range[1]), max: toK(range[2]), text }
  }
  const minOnly = text.match(/(\d+(?:\.\d+)?)\s*K\s*以上/i)
  if (minOnly !== null) {
    return { min: toK(minOnly[1]), max: null, text }
  }
  return { min: null, max: null, text }
}

/** 数值字符串 → 正整数 K（四舍五入；非正数返回 null）。 */
function toK(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Math.round(Number(raw))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 校招届数推导：关键词含 4 位年份 → 'YYYY校招'；否则空（入库兜底"未知"）。 */
function seasonFromKeyword(keyword: string | undefined): string {
  const year = keyword?.match(/(20\d{2})届?/)
  return year === null || year === undefined ? '' : `${year[1]}校招`
}

/** 列表 JSON → jobList 数组（结构异常返回 null）。 */
function readJobList(payload: unknown): Array<Record<string, unknown>> | null {
  if (typeof payload !== 'object' || payload === null) return null
  const zpData = (payload as { zpData?: unknown }).zpData
  if (typeof zpData !== 'object' || zpData === null) return null
  const jobList = (zpData as { jobList?: unknown }).jobList
  return Array.isArray(jobList) ? (jobList as Array<Record<string, unknown>>) : null
}

/** 列表 JSON → hasMore 布尔（结构异常返回 null）。 */
function readHasMore(payload: unknown): boolean | null {
  if (typeof payload !== 'object' || payload === null) return null
  const zpData = (payload as { zpData?: unknown }).zpData
  if (typeof zpData !== 'object' || zpData === null) return null
  const hasMore = (zpData as { hasMore?: unknown }).hasMore
  return typeof hasMore === 'boolean' ? hasMore : null
}

/** 末条 lid（`随机串.search.<页码>`）→ 页码；无 → null。 */
function lastPageFromLid(payload: unknown): number | null {
  const jobList = readJobList(payload)
  if (jobList === null || jobList.length === 0) return null
  const lastLid = String(jobList[jobList.length - 1]?.lid ?? '')
  const match = lastLid.match(/\.search\.(\d+)$/)
  if (match === null) return null
  const page = Number(match[1])
  return Number.isInteger(page) && page > 0 ? page : null
}

/** 详情 JSON → jobInfo（结构异常返回 null）。 */
function readJobInfo(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) return null
  const zpData = (payload as { zpData?: unknown }).zpData
  if (typeof zpData !== 'object' || zpData === null) return null
  const jobInfo = (zpData as { jobInfo?: unknown }).jobInfo
  return typeof jobInfo === 'object' && jobInfo !== null ? (jobInfo as Record<string, unknown>) : null
}

/** 搜索页 URL（query/city/page 拼接；jobType 按招聘类型映射，字典实测：全职=1901/实习=1902）。 */
function searchUrl(keyword: string, city: string, page: number, hireType: HireType): string {
  const params = new URLSearchParams({ query: keyword, city, page: String(page) })
  params.set('jobType', hireType === '实习' ? '1902' : '1901')
  return `${BossParser.SEARCH_BASE}?${params.toString()}`
}
