import type { CrawlCandidate, CrawlMode } from '../../../shared/types'
import type { CrawlParser } from '../crawl'

/**
 * 猎聘校招解析器（F-10/#24，实现 CrawlParser；研究结论见 docs/research/recruit-sources.md）。
 *
 * - 校招首页 `https://www.liepin.com/campus/`：SSR 项目卡（公司级校招项目：公司名+届数项目，
 *   链接 `project-detail/{id}/`）；「热门职位卡」MVP 不解析——公司级项目卡与职位卡语义一致
 *   （一个投递入口）；
 * - 字段映射：卡片标题在「届数」处拆分为 company/title（如 京东2027届JDS校园招聘 →
 *   company=京东、title=2027届JDS校园招聘）；recruit_season 由届数推导（2027届 → 2027校招，
 *   猎聘无批次阶段信息，用「校招」标记）；**猎聘无截止时间字段 → end_date 恒 null**
 *   （spec #13-17：UI 标「待核实」）；
 * - 详情页（project-detail/{id}）职位列表走 XHR（研究结论），SSR 无法补全——不实现
 *   parseDetail/nextListUrl；
 * - 纯函数：HTML → 候选行，无 IO（spec Testing Decisions）。
 */
export class LiepinParser implements CrawlParser {
  readonly source = 'liepin' as const

  private static readonly BASE = 'https://www.liepin.com/campus/'
  /** 项目卡锚点：href 含 /campus/project-detail/{id}/，卡片内部文本为「公司+届数项目」。 */
  private static readonly CARD_RE =
    /<a[^>]+href="([^"]*\/campus\/project-detail\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g

  buildUrls(mode: CrawlMode, _filter: string | undefined): string[] {
    void mode
    return [LiepinParser.BASE]
  }

  parseList(html: string, context: { mode: CrawlMode; filter: string | undefined }): CrawlCandidate[] {
    const keyword = context.filter?.trim() ?? ''
    const candidates: CrawlCandidate[] = []

    for (const match of html.matchAll(LiepinParser.CARD_RE)) {
      const rawHref = match[1] as string
      const cardText = stripTags(match[2] as string)
      const parts = splitProjectTitle(cardText)
      if (parts === null) continue // 非「公司+届数项目」结构（如活动卡）→ 跳过
      const { company, title, season } = parts
      if (keyword !== '' && !company.includes(keyword)) continue

      candidates.push({
        company,
        // 卡片内 meta（行业 · 规模 · 城市数 · 职位数）与项目名同锚点：在首个空格处截断
        title: title.split(' ')[0].trim(),
        jd: '', // 猎聘列表无 JD；职位列表走 XHR，MVP 不抓详情
        city: null, // 项目卡只有城市数，无城市列表
        channel: null,
        channel_url: null,
        // 协议相对 href 归一 https:；带 query 原样保留（去重键稳定）
        source_url: normalizeHref(rawHref),
        batch: null,
        recruit_season: season,
        start_date: null, // 猎聘无网申起止（研究结论）
        end_date: null, // 猎聘无截止时间 → null（UI「待核实」）
        detailUrl: normalizeHref(rawHref)
      })
    }
    return candidates
  }
}

/** 卡片文本「公司+届数项目」在届数处拆分：公司名 / 项目标题 / 秋招季。 */
function splitProjectTitle(
  text: string
): { company: string; title: string; season: string } | null {
  const match = /(\d{2,4}届)/.exec(text)
  if (match === null) return null
  const splitIdx = match.index
  const company = text.slice(0, splitIdx).trim()
  const title = text.slice(splitIdx).trim()
  if (company === '' || title === '') return null

  const yearDigits = match[1].slice(0, -1) // 去掉「届」
  const year = yearDigits.length === 2 ? `20${yearDigits}` : yearDigits
  return { company, title, season: `${year}校招` }
}

/** 去掉标签后的文本（标签间留空格，避免相邻文本粘连）。 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 协议相对 URL（//host/...）→ https: 前缀。 */
function normalizeHref(href: string): string {
  return href.startsWith('//') ? `https:${href}` : href
}
