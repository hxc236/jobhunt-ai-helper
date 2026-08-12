import { describe, expect, it } from 'vitest'
import { NowcoderParser } from './nowcoder'
import type { CrawlCandidate } from '../../../shared/types'

/** 列表页 fixture：__INITIAL_STATE__ 内嵌 scheduleData（研究结论：SSR 首屏 JSON）。 */
const LIST_PAGE_1 = `
<!DOCTYPE html>
<html>
<head><title>牛客网-校招日程</title></head>
<body>
<div id="app"></div>
<script>
window.__INITIAL_STATE__ = {
  "scheduleData": {
    "totalCount": 22116,
    "totalPage": 1106,
    "currentPage": 1,
    "datas": [
      {
        "name": "腾讯",
        "batchName": "27届秋招",
        "companyId": 164,
        "wangshenBeginDate": 1754668800000,
        "wangshenEndDate": 1769788800000,
        "wangshenTime": "8.10-10.31",
        "cityList": ["深圳", "北京"],
        "sourceInformation": "https://careers.tencent.com",
        "companyEvaluation": "以技术丰富互联网用户的生活"
      },
      {
        "name": "国家电网",
        "batchName": "27届秋招",
        "companyId": 512,
        "wangshenBeginDate": 1754755200000,
        "wangshenEndDate": null,
        "wangshenTime": "8.15开始",
        "cityList": null,
        "sourceInformation": "https://zhaopin.sgcc.com.cn",
        "companyEvaluation": ""
      },
      {
        "name": "某神秘公司",
        "batchName": "27届提前批",
        "wangshenBeginDate": null,
        "wangshenEndDate": null,
        "cityList": ["上海"]
      }
    ]
  }
};
</script>
</body>
</html>
`

/** 列表页 fixture：最后一页（currentPage == totalPage）。 */
const LIST_PAGE_LAST = `
<script>
window.__INITIAL_STATE__ = {
  "scheduleData": { "totalCount": 2, "totalPage": 2, "currentPage": 2, "datas": [] }
};
</script>
`

/** 无内嵌状态的列表页（结构变化/空壳）。 */
const LIST_NO_STATE = '<html><body><div id="app">加载中...</div></body></html>'

/** 详情页 fixture：SSR 文本（研究结论：招聘批次/网申时间/招聘城市/招聘岗位/官网投递）。 */
const DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>腾讯 - 牛客网企业校招</title></head>
<body>
<div class="detail-wrap">
  <h1>腾讯</h1>
  <div class="info-item"><span class="label">招聘批次：</span><span class="value">27届秋招</span></div>
  <div class="info-item"><span class="label">网申时间：</span><span class="value">2026/08/10 ~ 2026/10/31</span></div>
  <div class="info-item"><span class="label">招聘城市：</span><span class="value">深圳、北京</span></div>
  <div class="info-item"><span class="label">招聘岗位：</span><span class="value">前端开发、后端开发、客户端开发</span></div>
  <div class="info-item"><span class="label">投递渠道：</span><a class="value" href="https://careers.tencent.com">官网投递</a></div>
</div>
</body>
</html>
`

/** 详情页 fixture：缺招聘岗位/官网投递（字段缺失场景）。 */
const DETAIL_NO_FIELDS = `
<div class="detail-wrap">
  <h1>国家电网</h1>
  <div class="info-item"><span class="label">招聘批次：</span><span class="value">27届秋招</span></div>
  <div class="info-item"><span class="label">网申时间：</span><span class="value">2026/08/15 开始</span></div>
</div>
`

function makeParser(): NowcoderParser {
  return new NowcoderParser()
}

describe('NowcoderParser 列表解析（F-09/#23）', () => {
  it('__INITIAL_STATE__ 内嵌 scheduleData.datas → 候选行（字段映射：公司/时间/城市/渠道/详情入口）', () => {
    const parser = makeParser()
    const candidates = parser.parseList(LIST_PAGE_1, { mode: 'full', filter: undefined })

    expect(candidates).toHaveLength(2) // 无 companyId 的第 3 条被跳过（无详情入口）
    const [tencent, sgcc] = candidates

    expect(tencent).toMatchObject({
      company: '腾讯',
      title: '',
      city: '深圳、北京',
      channel: '官网',
      channel_url: 'https://careers.tencent.com',
      source_url: 'https://www.nowcoder.com/enterprise/164?pageSource=5014&channel=recruitmentSchedule',
      detailUrl: 'https://www.nowcoder.com/enterprise/164?pageSource=5014&channel=recruitmentSchedule',
      batch: '正式批', // 27届秋招 → 正式批
      recruit_season: '2027秋招', // 27届 → 2027 + 阶段
      start_date: '2025-08-09', // epoch ms → YYYY-MM-DD（UTC+8）
      end_date: '2026-01-31'
    })

    // 缺字段场景：无 end_date → null（待核实）；无 cityList → null；提前批映射
    expect(sgcc).toMatchObject({
      company: '国家电网',
      title: '',
      city: null,
      end_date: null,
      start_date: '2025-08-10',
      batch: '正式批',
      recruit_season: '2027秋招'
    })
  })

  it('filter 模式按公司名关键词过滤（大小写/首尾空白宽容）', () => {
    const parser = makeParser()
    const matched = parser.parseList(LIST_PAGE_1, { mode: 'filter', filter: ' 腾讯 ' })
    expect(matched.map((c) => c.company)).toEqual(['腾讯'])

    const none = parser.parseList(LIST_PAGE_1, { mode: 'filter', filter: '字节' })
    expect(none).toEqual([])
  })

  it('无 __INITIAL_STATE__ / 无 datas → 空数组（结构变化不抛错）', () => {
    const parser = makeParser()
    expect(parser.parseList(LIST_NO_STATE, { mode: 'full', filter: undefined })).toEqual([])
    expect(parser.parseList('<html><script>window.__INITIAL_STATE__ = {};</script></html>', { mode: 'full', filter: undefined })).toEqual([])
  })

  it('buildUrls：列表基址 + 翻页 URL（pageSource/channel 参数按研究结论）', () => {
    const parser = makeParser()
    expect(parser.buildUrls('full', undefined)).toEqual([
      'https://www.nowcoder.com/jobs/school/schedule'
    ])
    expect(parser.buildUrls('filter', '腾讯')).toEqual([
      'https://www.nowcoder.com/jobs/school/schedule'
    ])
  })
})

describe('NowcoderParser 翻页（F-09/#23 验收：翻页参数提取正确）', () => {
  it('currentPage < totalPage → 返回下一页 URL（?page=N+1）', () => {
    const parser = makeParser()
    expect(parser.nextListUrl(LIST_PAGE_1)).toBe('https://www.nowcoder.com/jobs/school/schedule?page=2')
  })

  it('currentPage == totalPage → null（无更多页）', () => {
    const parser = makeParser()
    expect(parser.nextListUrl(LIST_PAGE_LAST)).toBeNull()
  })

  it('缺翻页信息（无 __INITIAL_STATE__）→ null', () => {
    const parser = makeParser()
    expect(parser.nextListUrl(LIST_NO_STATE)).toBeNull()
  })
})

describe('NowcoderParser 详情解析（F-09/#23）', () => {
  it('详情页补全：招聘岗位 → title、网申时间 → start/end、官网投递 → channel_url、招聘城市 → city', () => {
    const parser = makeParser()
    const base: CrawlCandidate = {
      company: '腾讯',
      title: '',
      jd: '',
      city: '深圳、北京',
      channel: '官网',
      channel_url: 'https://careers.tencent.com',
      source_url: 'https://www.nowcoder.com/enterprise/164?pageSource=5014&channel=recruitmentSchedule',
      batch: '正式批',
      recruit_season: '2027秋招',
      start_date: '2025-08-09',
      end_date: '2026-01-30',
      detailUrl: 'https://www.nowcoder.com/enterprise/164?pageSource=5014&channel=recruitmentSchedule'
    }

    const merged = parser.parseDetail(DETAIL_PAGE, base)

    expect(merged.title).toBe('前端开发、后端开发、客户端开发')
    expect(merged.start_date).toBe('2026-08-10') // 详情页权威（列表时间仅起止宽泛值）
    expect(merged.end_date).toBe('2026-10-31')
    expect(merged.city).toBe('深圳、北京')
    expect(merged.channel_url).toBe('https://careers.tencent.com')
    expect(merged.recruit_season).toBe('2027秋招')
  })

  it('缺字段详情页：保留列表已有字段，缺失项不覆盖为空', () => {
    const parser = makeParser()
    const base: CrawlCandidate = {
      company: '国家电网',
      title: '',
      jd: '',
      city: null,
      channel: '官网',
      channel_url: 'https://zhaopin.sgcc.com.cn',
      source_url: 'https://www.nowcoder.com/enterprise/512?pageSource=5014&channel=recruitmentSchedule',
      batch: '正式批',
      recruit_season: '2027秋招',
      start_date: '2025-08-10',
      end_date: null,
      detailUrl: 'https://www.nowcoder.com/enterprise/512?pageSource=5014&channel=recruitmentSchedule'
    }

    const merged = parser.parseDetail(DETAIL_NO_FIELDS, base)

    expect(merged.title).toBe('') // 无招聘岗位 → 保留空（缺字段，预览页标记）
    expect(merged.channel_url).toBe('https://zhaopin.sgcc.com.cn') // 无官网投递 → 保留列表值
    expect(merged.end_date).toBeNull() // 详情无截止 → 保持 null（待核实）
    expect(merged.start_date).toBe('2025-08-10') // 详情「2026/08/15 开始」无 ~ 对 → 不覆盖
  })
})
