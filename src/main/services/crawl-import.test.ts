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
