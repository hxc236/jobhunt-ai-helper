import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { CrawlService, type CrawlFetcher, type CrawlParser } from './crawl'
import { PositionService } from './position'
import type { CrawlCandidate } from '../../shared/types'

function candidate(
  company: string,
  title: string,
  sourceUrl: string,
  extra: Partial<CrawlCandidate> = {}
): CrawlCandidate {
  return {
    company,
    title,
    jd: `${company}-${title} JD`,
    city: '北京',
    channel: '牛客',
    channel_url: 'https://nowcoder.test',
    source_url: sourceUrl,
    batch: null,
    recruit_season: '2026秋招',
    start_date: null,
    end_date: '2026-10-31',
    ...extra
  }
}

const URL_A = 'https://nowcoder.test/company/1'
const URL_B = 'https://nowcoder.test/company/2'
const URL_C = 'https://nowcoder.test/company/3'

const candidates = [
  candidate('腾讯', '前端开发工程师', URL_A),
  candidate('华为', '软件工程师', URL_B, { end_date: null }), // 缺字段：无截止 → 待核实
  candidate('字节', '', URL_C) // 缺字段：无岗位名
]

function makeFetcher(): CrawlFetcher {
  return {
    async fetch(url) {
      if (url === 'https://nowcoder.test/list') return '<html>page</html>'
      throw new Error(`no page: ${url}`)
    }
  }
}

function makeParser(urls: string[]): CrawlParser {
  return {
    source: 'nowcoder',
    buildUrls() {
      return urls
    },
    parseList() {
      return candidates
    }
  }
}

async function runCrawl(svc: CrawlService): Promise<number> {
  const { run } = await svc.run('nowcoder', { mode: 'full' })
  return run.id
}


describe('CrawlService.preview 采集预览（F-11/#29）', () => {
  it('统计：将新增 N / 更新 M / 缺字段 K；无历史职位时全部为新增', async () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlService(db, makeFetcher())
    svc.registerParser(makeParser(['https://nowcoder.test/list']))
    const runId = await runCrawl(svc)

    const preview = svc.preview(runId)

    expect(preview.items).toHaveLength(3)
    expect(preview.stats).toEqual({ inserted: 3, updated: 0, missing: 2 })
    // 缺字段标记：无截止（待核实）+ 无岗位名
    const missing = preview.items.filter((i) => i.missingFields.length > 0)
    expect(missing).toHaveLength(2)
    expect(missing[0]!.missingFields).toEqual(['end_date'])
    expect(missing[1]!.missingFields).toEqual(['title'])
  })

  it('source_url 命中已有职位 → 动作 update（预览预测）；无命中 → new', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    positions.create({
      company: '腾讯',
      company_type: '大厂',
      title: '前端开发工程师',
      jd: '旧 JD',
      channel_url: 'https://old.example.com',
      recruit_season: '2026秋招'
    })
    // 手动创建后把 source_url 置为采集 URL（模拟上次采集入库的职位）
    db.prepare('UPDATE positions SET source_url = ? WHERE company = ?').run(URL_A, '腾讯')

    const svc = new CrawlService(db, makeFetcher())
    svc.registerParser(makeParser(['https://nowcoder.test/list']))
    const runId = await runCrawl(svc)

    const preview = svc.preview(runId)
    const byUrl = Object.fromEntries(preview.items.map((i) => [i.candidate.source_url, i.action]))
    expect(byUrl[URL_A]).toBe('update')
    expect(byUrl[URL_B]).toBe('new')
    expect(preview.stats).toEqual({ inserted: 2, updated: 1, missing: 2 })
  })
})

describe('CrawlService.confirmImport upsert（F-11/#29 验收）', () => {
  it('确认导入：新增入库（source/source_url 落库）；重复 source_url 再次导入 → 更新而非新建', async () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlService(db, makeFetcher())
    svc.registerParser(makeParser(['https://nowcoder.test/list']))
    const positions = new PositionService(db)
    const runId = await runCrawl(svc)

    const first = svc.confirmImport(runId, [URL_A, URL_B, URL_C])
    expect(first).toEqual({ inserted: 3, updated: 0 })
    expect(positions.list()).toHaveLength(3)

    const tencent = positions.list().find((p) => p.company === '腾讯')
    expect(tencent?.source).toBe('nowcoder')
    expect(tencent?.source_url).toBe(URL_A)
    expect(tencent?.title).toBe('前端开发工程师')
    expect(tencent?.end_date).toBe('2026-10-31')
    expect(tencent?.recruit_season).toBe('2026秋招')

    // 再次确认（JD 刷新场景）：更新而非新建
    const second = svc.confirmImport(runId, [URL_A])
    expect(second).toEqual({ inserted: 0, updated: 1 })
    expect(positions.list()).toHaveLength(3)
  })

  it('dedupe_key 兜底：与手动录入同公司+岗位+秋招季 → 合并更新（不新建）', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    positions.create({
      company: '腾讯',
      company_type: '大厂',
      title: '前端开发工程师',
      jd: '手动录入的 JD',
      recruit_season: '2026秋招'
    })

    const svc = new CrawlService(db, makeFetcher())
    svc.registerParser(makeParser(['https://nowcoder.test/list']))
    const runId = await runCrawl(svc)

    const result = svc.confirmImport(runId, [URL_A])
    expect(result).toEqual({ inserted: 0, updated: 1 })
    const rows = positions.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.jd).toBe('腾讯-前端开发工程师 JD') // 采集内容刷新
    expect(rows[0]?.source_url).toBe(URL_A) // 升级为 URL 去重主键
  })

  it('只导入勾选子集；不存在的 runId → 报错', async () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlService(db, makeFetcher())
    svc.registerParser(makeParser(['https://nowcoder.test/list']))
    const positions = new PositionService(db)
    const runId = await runCrawl(svc)

    const result = svc.confirmImport(runId, [URL_B])
    expect(result).toEqual({ inserted: 1, updated: 0 })
    expect(positions.list()).toHaveLength(1)
    expect(positions.list()[0]?.company).toBe('华为')

    expect(() => svc.confirmImport(99999, [URL_A])).toThrowError(/不存在/)
  })
})

describe('CrawlService 导入新字段（issue #52：招聘类型/薪资/BOSS 源/去重键）', () => {
  /** boss 源抓取：任意 URL 返回页面（本组只测解析/入库，不测抓取）。 */
  const anyPageFetcher: CrawlFetcher = {
    async fetch() {
      return '<html>page</html>'
    }
  }

  const bossParser = (): CrawlParser => ({
    source: 'boss',
    buildUrls: () => ['https://boss.test/list'],
    parseList: () => [
      candidate('某公司', '后端工程师', 'https://boss.test/job/1', {
        hire_type: '社招',
        recruit_season: '',
        salary_min: 20,
        salary_max: 40,
        salary_text: '20-40K·14薪',
        end_date: null
      })
    ]
  })

  it('候选 hire_type/薪资/源 → 入库落 hire_type/salary/source；dedupe_key 含招聘类型', async () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlService(db, anyPageFetcher)
    svc.registerParser(bossParser())
    const { run } = await svc.run('boss', { mode: 'full' })

    const result = svc.confirmImport(run.id, ['https://boss.test/job/1'])
    expect(result).toEqual({ inserted: 1, updated: 0 })
    const row = db.prepare('SELECT * FROM positions WHERE company = ?').get('某公司') as Record<string, unknown>
    expect(row.source).toBe('boss') // 源来自运行（修正硬编码 nowcoder）
    expect(row.hire_type).toBe('社招')
    expect(row.recruit_season).toBe('')
    expect(row.dedupe_key).toBe('某公司|后端工程师|社招|')
    expect(row.salary_min).toBe(20)
    expect(row.salary_max).toBe(40)
    expect(row.salary_text).toBe('20-40K·14薪')
  })

  it('社招候选与手动社招职位 dedupe 兜底命中 → 合并更新（不新建）', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    positions.create({
      company: '某公司',
      company_type: '其他',
      title: '后端工程师',
      hire_type: '社招',
      jd: '手动 JD'
    })

    const svc = new CrawlService(db, anyPageFetcher)
    svc.registerParser(bossParser())
    const { run } = await svc.run('boss', { mode: 'full' })

    const result = svc.confirmImport(run.id, ['https://boss.test/job/1'])
    expect(result).toEqual({ inserted: 0, updated: 1 })
    const rows = positions.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.jd).toBe('某公司-后端工程师 JD') // 采集内容刷新
    expect(rows[0]?.hire_type).toBe('社招')
  })
})
