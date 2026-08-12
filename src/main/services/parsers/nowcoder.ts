import type { CrawlCandidate, CrawlMode, Batch } from '../../../shared/types'
import type { CrawlParser } from '../crawl'

/**
 * 牛客校招日程解析器（F-09/#23，实现 CrawlParser；研究结论见 docs/research/recruit-sources.md）。
 *
 * - 列表页 `https://www.nowcoder.com/jobs/school/schedule`：SSR 内嵌 `window.__INITIAL_STATE__`
 *   JSON，`scheduleData.datas[]` 每条 = 公司校招日程（name/batchName/companyId/
 *   wangshenBeginDate/wangshenEndDate（epoch ms）/cityList/sourceInformation）；
 *   岗位名（title）牛客列表不提供——由详情页（enterprise/{companyId}）补全；
 * - 翻页：`__INITIAL_STATE__.scheduleData` 带 totalPage/currentPage，生成 `?page=N+1`；
 *   （研究：分页数据实走混淆 XHR，SSR 翻页参数为尽力而为，失败由框架重试/留痕兜底）
 * - 详情页：SSR 文本（招聘批次/网申时间/招聘城市/招聘岗位/官网投递），补全 title/
 *   start_date/end_date/city/channel_url；
 * - 纯函数：HTML → 候选行，无 IO；解析与抓取分离（spec Testing Decisions）。
 */
export class NowcoderParser implements CrawlParser {
  readonly source = 'nowcoder' as const

  private static readonly BASE = 'https://www.nowcoder.com/jobs/school/schedule'

  buildUrls(mode: CrawlMode, _filter: string | undefined): string[] {
    void mode
    return [NowcoderParser.BASE]
  }

  parseList(html: string, context: { mode: CrawlMode; filter: string | undefined }): CrawlCandidate[] {
    const state = extractInitialState(html)
    if (state === null) return []
    let scheduleData: { datas?: unknown; totalPage?: unknown; currentPage?: unknown }
    try {
      scheduleData = JSON.parse(state).scheduleData
    } catch {
      return []
    }
    if (!Array.isArray(scheduleData?.datas)) return []

    const keyword = context.filter?.trim() ?? ''
    const candidates: CrawlCandidate[] = []
    for (const item of scheduleData.datas as Array<Record<string, unknown>>) {
      const company = String(item.name ?? '').trim()
      if (company === '') continue
      // filter 模式：按公司名关键词过滤（页面无服务端关键词参数，spec #13-16 关键词筛选在此实现）
      if (keyword !== '' && !company.includes(keyword)) continue
      // 详情入口 = 去重主键：无 companyId 的条目跳过（无法补全岗位/稳定去重）
      const companyId = item.companyId ?? item.id
      if (companyId === undefined || companyId === '') continue
      const detailUrl = `https://www.nowcoder.com/enterprise/${String(companyId)}?pageSource=5014&channel=recruitmentSchedule`
      const batchName = String(item.batchName ?? '').trim()

      candidates.push({
        company,
        title: '', // 牛客列表无岗位名；详情页补全（缺字段由预览标记）
        jd: '', // 牛客无 JD 全文（研究结论：岗位只有名称列表）
        city: toCity(item.cityList),
        channel: item.sourceInformation ? '官网' : null,
        channel_url: item.sourceInformation ? String(item.sourceInformation) : null,
        source_url: detailUrl,
        batch: batchFromName(batchName),
        recruit_season: seasonFromName(batchName),
        start_date: epochToDate(item.wangshenBeginDate),
        end_date: epochToDate(item.wangshenEndDate),
        detailUrl
      })
    }
    return candidates
  }

  /** 翻页：currentPage < totalPage → `?page=N+1`；缺信息/末页 → null。 */
  nextListUrl(html: string): string | null {
    const state = extractInitialState(html)
    if (state === null) return null
    let scheduleData: { totalPage?: unknown; currentPage?: unknown }
    try {
      scheduleData = JSON.parse(state).scheduleData
    } catch {
      return null
    }
    const current = Number(scheduleData?.currentPage ?? 1)
    const total = Number(scheduleData?.totalPage ?? 1)
    if (!Number.isFinite(current) || !Number.isFinite(total) || current >= total) return null
    return `${NowcoderParser.BASE}?page=${current + 1}`
  }

  /** 详情页补全：招聘岗位 → title；网申时间（权威）→ start/end；招聘城市；官网投递 → channel_url。 */
  parseDetail(html: string, candidate: CrawlCandidate): CrawlCandidate {
    const text = stripTags(html)

    const title = extractLabeled(text, '招聘岗位')
    const city = extractLabeled(text, '招聘城市')
    const batchName = extractLabeled(text, '招聘批次')
    const season = seasonFromName(batchName ?? '')
    const time = /网申时间\s*[:：]?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*~\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(text)
    const channelUrl = /官网投递[\s\S]*?href="([^"]+)"/.exec(html)

    return {
      ...candidate,
      // 详情字段权威；缺失时保留列表已有值（不覆盖为空）
      title: title !== null ? title : candidate.title,
      city: city ?? candidate.city,
      recruit_season: season ?? candidate.recruit_season,
      start_date: time !== null ? normalizeDate(time[1], time[2], time[3]) : candidate.start_date,
      end_date: time !== null ? normalizeDate(time[4], time[5], time[6]) : candidate.end_date,
      channel_url: channelUrl !== null ? channelUrl[1] : candidate.channel_url
    }
  }
}

/**
 * 提取 `window.__INITIAL_STATE__ = {...}` 的 JSON 文本：定位赋值号后做花括号配平，
 * 跳过字符串字面量（含转义），保证内嵌 JSON 中的花括号不影响配平。
 */
function extractInitialState(html: string): string | null {
  const marker = 'window.__INITIAL_STATE__'
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return null
  const assignIdx = html.indexOf('=', markerIdx + marker.length)
  if (assignIdx === -1) return null

  let i = assignIdx + 1
  while (i < html.length && html[i] !== '{') i++
  if (html[i] !== '{') return null

  const start = i
  let depth = 0
  let inString = false
  let escaped = false
  for (; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  return null
}

/** 去掉标签后的页面文本（标签间留空格，避免相邻文本粘连）。 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取「标签：」后的值文本（到下一个同类标签或行尾；去标签后匹配，兼容换行/嵌套）。 */
function extractLabeled(text: string, label: string): string | null {
  const pattern = new RegExp(`${label}\\s*[:：]?\\s*([\\s\\S]*?)(?=\\s*(?:招聘批次|网申时间|招聘城市|招聘岗位|投递渠道|公司简介|$))`)
  const match = pattern.exec(text)
  if (match === null) return null
  const value = match[1].replace(/<[^>]+>/g, '').trim()
  return value === '' ? null : value
}

/** 批次名 → 批次枚举（提前批 > 补录 > 正式批/秋招/春招；未知返回 null）。 */
function batchFromName(batchName: string): Batch | null {
  if (batchName === '') return null
  if (batchName.includes('提前批')) return '提前批'
  if (batchName.includes('补录')) return '补录'
  if (batchName.includes('正式批') || batchName.includes('秋招') || batchName.includes('春招')) {
    return '正式批'
  }
  return null
}

/** 批次名 → 秋招季（如 '27届秋招' → '2027秋招'；'27届提前批' → '2027提前批'）。 */
function seasonFromName(batchName: string): string | null {
  const match = /(\d{2})届/.exec(batchName)
  if (match === null) return null
  const year = `20${match[1]}`
  const phase = ['秋招', '春招', '提前批', '补录'].find((p) => batchName.includes(p))
  return phase === undefined ? null : `${year}${phase}`
}

/** epoch ms → YYYY-MM-DD（UTC+8；牛客时间戳为北京时间零点）。 */
function epochToDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 城市字段归一：数组 → '、' 连接；字符串 → 原样。 */
function toCity(value: unknown): string | null {
  if (Array.isArray(value)) {
    const cities = value.map((v) => String(v).trim()).filter((v) => v !== '')
    return cities.length === 0 ? null : cities.join('、')
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return null
}

/** 'YYYY/MM/DD' 各段 → 'YYYY-MM-DD'（补零）。 */
function normalizeDate(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}
