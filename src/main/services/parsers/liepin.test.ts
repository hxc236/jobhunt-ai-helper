import { describe, expect, it } from 'vitest'
import { LiepinParser } from './liepin'

/** 猎聘校招首页 fixture：SSR 项目卡（研究结论：公司名+届数项目，链接 project-detail/{id}）。 */
const LEPIN_PAGE = `
<!DOCTYPE html>
<html>
<head><title>猎聘校园招聘</title></head>
<body>
<div class="campus-wrap">
  <div class="project-list">
    <a class="project-card" href="//www.liepin.com/campus/project-detail/10001/">
      <div class="project-name">京东2027届JDS校园招聘</div>
      <div class="project-meta">互联网 · 上市 · 10000人以上 · 覆盖40+城市 · 30个职位</div>
    </a>
    <a class="project-card" href="https://www.liepin.com/campus/project-detail/10002/">
      <div class="project-name">中国钢研科技集团2027届校园招聘</div>
      <div class="project-meta">国企 · 1000-9999人 · 8个职位</div>
    </a>
    <a class="project-card" href="//www.liepin.com/campus/project-detail/10003/?from=campus">
      <div class="project-name">韬润半导体2026届校园招聘</div>
      <div class="project-meta">半导体 · 融资B轮 · 500-999人 · 覆盖20+城市 · 12个职位</div>
    </a>
    <!-- 非项目卡链接：不应被解析 -->
    <a class="banner" href="//www.liepin.com/campus/activity/2026/">秋招活动页</a>
  </div>
  <div class="job-list">
    <div class="job-card">
      <span class="job-name">前端开发工程师</span>
      <span class="job-company">某公司</span>
      <span class="job-city">北京</span>
    </div>
  </div>
</div>
</body>
</html>
`

/** 无项目卡页面（结构变化/空壳）。 */
const EMPTY_PAGE = '<html><body><div id="app">加载中...</div></body></html>'

function makeParser(): LiepinParser {
  return new LiepinParser()
}

describe('LiepinParser 列表解析（F-10/#24）', () => {
  it('SSR 项目卡 → 候选行：公司名/项目名（届数处拆分）/秋招季/详情入口；end_date 恒 null（验收：待核实）', () => {
    const parser = makeParser()
    const candidates = parser.parseList(LEPIN_PAGE, { mode: 'full', filter: undefined })

    expect(candidates).toHaveLength(3)
    const [jd, steel, taorun] = candidates

    // 京东2027届JDS校园招聘 → 公司=京东，title=2027届JDS校园招聘
    expect(jd).toMatchObject({
      company: '京东',
      title: '2027届JDS校园招聘',
      recruit_season: '2027校招',
      source_url: 'https://www.liepin.com/campus/project-detail/10001/',
      detailUrl: 'https://www.liepin.com/campus/project-detail/10001/',
      // 猎聘无截止时间字段 → end_date null（UI 标「待核实」，spec #13-17）
      end_date: null,
      start_date: null,
      city: null,
      batch: null,
      channel: null,
      channel_url: null
    })

    expect(steel).toMatchObject({ company: '中国钢研科技集团', title: '2027届校园招聘' })
    // 26届 → 2026校招；带 query 的 href 原样保留（去重键稳定）
    expect(taorun).toMatchObject({
      company: '韬润半导体',
      title: '2026届校园招聘',
      recruit_season: '2026校招',
      source_url: 'https://www.liepin.com/campus/project-detail/10003/?from=campus'
    })
  })

  it('filter 模式按公司名关键词过滤', () => {
    const parser = makeParser()
    const matched = parser.parseList(LEPIN_PAGE, { mode: 'filter', filter: '京东' })
    expect(matched.map((c) => c.company)).toEqual(['京东'])
    expect(parser.parseList(LEPIN_PAGE, { mode: 'filter', filter: '不存在' })).toEqual([])
  })

  it('无项目卡 → 空数组（不抛错）；热门职位卡不解析（MVP 只做公司级校招项目）', () => {
    const parser = makeParser()
    expect(parser.parseList(EMPTY_PAGE, { mode: 'full', filter: undefined })).toEqual([])
  })

  it('buildUrls：校招首页为唯一起始 URL（首页即含项目卡列表）', () => {
    const parser = makeParser()
    expect(parser.buildUrls('full', undefined)).toEqual(['https://www.liepin.com/campus/'])
    expect(parser.buildUrls('filter', '京东')).toEqual(['https://www.liepin.com/campus/'])
  })
})
