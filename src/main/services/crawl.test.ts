import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { CrawlService, type CrawlFetcher, type CrawlParseContext, type CrawlParser } from './crawl'
import type { CrawlCandidate, CrawlRunOptions } from '../../shared/types'

/** 记录型 fetcher：可编程成功/失败；记录调用序列与 sleep 序列（节流/退避断言）。 */
function makeFakeFetcher(
  pages: Record<string, string>,
  failUrls: string[] = []
): CrawlFetcher & { calls: string[]; sleeps: number[] } {
  const calls: string[] = []
  const sleeps: number[] = []
  return {
    calls,
    sleeps,
    async fetch(url) {
      calls.push(url)
      if (failUrls.includes(url)) throw new Error(`fetch failed: ${url}`)
      const html = pages[url]
      if (html === undefined) throw new Error(`no page for ${url}`)
      return html
    }
  }
}

/** 记录型 parser：列表页产出可编程候选（detailUrl 可触发详情补全）。 */
function makeFakeParser(
  urls: string[],
  candidatesByUrl: Record<string, CrawlCandidate[]>,
  detailResult?: CrawlCandidate
): CrawlParser & {
  builds: Array<{ mode: string; filter: string | undefined }>
  detailFetched: string[]
  contexts: CrawlParseContext[]
} {
  const builds: Array<{ mode: string; filter: string | undefined }> = []
  const detailFetched: string[] = []
  const contexts: CrawlParseContext[] = []
  return {
    source: 'nowcoder',
    builds,
    detailFetched,
    contexts,
    buildUrls(mode, filter) {
      builds.push({ mode, filter })
      return urls
    },
    parseList(html, context) {
      contexts.push(context)
      // 测试里每个 html 内容唯一，直接按内容取候选
      for (const [key, cands] of Object.entries(candidatesByUrl)) {
        if (html === key) return cands
      }
      return []
    },
    parseDetail(_html, candidate) {
      detailFetched.push(candidate.source_url)
      return detailResult ?? candidate
    }
  }
}

function makeService(
  fetcher: CrawlFetcher,
  parser: CrawlParser,
  opts: ConstructorParameters<typeof CrawlService>[2] = {}
): CrawlService {
  const svc = new CrawlService(openDatabase(':memory:'), fetcher, {
    // 默认注入空睡眠：节流/退避的时序由专门用例注入记录器断言
    sleep: async () => {},
    ...opts
  })
  svc.registerParser(parser)
  return svc
}

/** 三页列表：页 1 两条、页 2 一条、页 3 两条。 */
const PAGES = {
  'https://nowcoder.test/list?p=1': '<html>page1</html>',
  'https://nowcoder.test/list?p=2': '<html>page2</html>',
  'https://nowcoder.test/list?p=3': '<html>page3</html>'
} as const

function candidate(company: string, title: string, page: string, extra: Partial<CrawlCandidate> = {}): CrawlCandidate {
  return {
    company,
    title,
    jd: `${company}-${title} JD`,
    city: '北京',
    channel: '牛客',
    channel_url: 'https://nowcoder.test',
    source_url: `https://nowcoder.test/${page}/${company}/${title}`,
    batch: null,
    start_date: null,
    end_date: null,
    ...extra
  }
}

const page1Candidates = [candidate('腾讯', '前端', 'p1'), candidate('华为', '后端', 'p1')]
const page2Candidates = [candidate('字节', '算法', 'p2')]
const page3Candidates = [candidate('美团', '前端', 'p3'), candidate('小米', '测试', 'p3')]
const ALL_PAGES: Record<string, CrawlCandidate[]> = {
  '<html>page1</html>': page1Candidates,
  '<html>page2</html>': page2Candidates,
  '<html>page3</html>': page3Candidates
}

const runOptions: CrawlRunOptions = { mode: 'full' }

describe('CrawlService 采集执行框架（F-08/#22）', () => {
  describe('执行流程', () => {
    it('按 buildUrls 顺序抓取列表页，合并各页候选；filter 模式透传关键词', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser)

      const result = await svc.run('nowcoder', { mode: 'filter', filter: '腾讯' })

      expect(fetcher.calls).toEqual(Object.keys(PAGES))
      expect(parser.builds).toEqual([{ mode: 'filter', filter: '腾讯' }])
      expect(result.candidates).toHaveLength(5)
      expect(result.candidates[0]).toMatchObject({ company: '腾讯', title: '前端' })
      expect(result.candidates[4]).toMatchObject({ company: '小米', title: '测试' })
    })

    it('列表页候选带 detailUrl 且解析器有 parseDetail → 抓详情页并用其结果替换候选', async () => {
      const listCand = candidate('腾讯', '前端', 'p1', {
        detailUrl: 'https://nowcoder.test/detail/1'
      })
      const enriched = { ...listCand, jd: '详情页补全的 JD 全文', end_date: '2026-10-31' }
      const fetcher = makeFakeFetcher({
        ...PAGES,
        'https://nowcoder.test/detail/1': '<html>detail</html>'
      })
      const parser = makeFakeParser(['https://nowcoder.test/list?p=1'], {
        '<html>page1</html>': [listCand]
      }, enriched)
      const svc = makeService(fetcher, parser)

      const result = await svc.run('nowcoder', runOptions)

      expect(parser.detailFetched).toEqual([listCand.source_url])
      expect(fetcher.calls).toEqual([
        'https://nowcoder.test/list?p=1',
        'https://nowcoder.test/detail/1'
      ])
      expect(result.candidates[0]).toMatchObject({ jd: '详情页补全的 JD 全文', end_date: '2026-10-31' })
    })

    it('未注册解析器 → 报错且不产生留痕', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const svc = new CrawlService(openDatabase(':memory:'), fetcher)

      await expect(svc.run('nowcoder', runOptions)).rejects.toThrow(/解析器未注册/)
      await expect(svc.run('liepin', runOptions)).rejects.toThrow(/解析器未注册/)
      expect(fetcher.calls).toEqual([])
      expect(svc.runs()).toEqual([])
    })
  })

  describe('结构化采集条件（issue #55）', () => {
    it('运行选项透传结构化条件给解析器（旧 filter 兼容并存）', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser)

      const result = await svc.run('nowcoder', {
        mode: 'filter',
        filter: '腾讯',
        hire_type: '社招',
        keyword: '前端',
        city: '101020100'
      })

      expect(parser.contexts).toHaveLength(3) // 每页一次 parseList
      expect(parser.contexts[0]).toEqual({
        mode: 'filter',
        filter: '腾讯',
        hire_type: '社招',
        keyword: '前端',
        city: '101020100'
      })
      expect(parser.builds).toEqual([{ mode: 'filter', filter: '腾讯' }])
      expect(result.candidates).toHaveLength(5)
    })

    it('留痕记录结构化条件快照；无条件运行的 conditions=null', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser)

      const withCond = await svc.run('nowcoder', { mode: 'full', hire_type: '校招', keyword: '前端', city: '101020100' })
      expect(svc.getRun(withCond.run.id)?.conditions).toEqual({ hire_type: '校招', keyword: '前端', city: '101020100' })
      expect(svc.runs()[0]?.conditions).toEqual({ hire_type: '校招', keyword: '前端', city: '101020100' })

      const plain = await svc.run('nowcoder', { mode: 'full' })
      expect(svc.getRun(plain.run.id)?.conditions).toBeNull()
    })
  })

  describe('频率纪律（issue #55）', () => {
    it('运行级 maxItems 覆盖服务默认上限（截断标记）', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser)

      const result = await svc.run('nowcoder', { mode: 'full', maxItems: 2 })
      expect(result.candidates).toHaveLength(2)
      expect(result.run.truncated).toBe(true)
    })

    it('cooldownMs 生效：除首个请求外每次 fetch 前等待冷却间隔', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const sleeps: number[] = []
      const svc = makeService(fetcher, parser, {
        cooldownMs: 30000,
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      })

      await svc.run('nowcoder', { mode: 'full' })
      expect(sleeps).toEqual([30000, 30000]) // 3 页 → 2 次冷却间隔
    })

    it('运行级 cooldownMs 覆盖服务默认', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const sleeps: number[] = []
      const svc = makeService(fetcher, parser, {
        cooldownMs: 30000,
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      })

      await svc.run('nowcoder', { mode: 'full', cooldownMs: 45000 })
      expect(sleeps).toEqual([45000, 45000])
    })

    it('同 URL 不重复导航（队列去重，防翻页循环）', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      // 从第 1 页开始，翻页驱动：p1 → p2 → p1（循环）→ 框架不再抓已抓 URL
      const parser = makeFakeParser(['https://nowcoder.test/list?p=1'], ALL_PAGES)
      parser.nextListUrl = (html: string) => {
        if (html === '<html>page1</html>') return 'https://nowcoder.test/list?p=2'
        if (html === '<html>page2</html>') return 'https://nowcoder.test/list?p=1'
        return null
      }
      const svc = makeService(fetcher, parser)

      await svc.run('nowcoder', { mode: 'full' })
      expect(fetcher.calls).toEqual(['https://nowcoder.test/list?p=1', 'https://nowcoder.test/list?p=2'])
    })
  })

  describe('节流（spec #13-21：请求间隔 ≥2s）', () => {
    it('除首个请求外，每次 fetch 前 sleep(throttleMs)', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser, {
        throttleMs: 2000,
        sleep: async (ms) => {
          fetcher.sleeps.push(ms)
        }
      })

      await svc.run('nowcoder', runOptions)

      expect(fetcher.sleeps).toEqual([2000, 2000]) // 3 次 fetch → 2 次间隔
    })

    it('详情页抓取同样受节流（与列表页同一节奏）', async () => {
      const fetcher = makeFakeFetcher({
        'https://nowcoder.test/list?p=1': '<html>page1</html>',
        'https://nowcoder.test/detail/1': '<html>detail</html>'
      })
      const listCand = candidate('腾讯', '前端', 'p1', { detailUrl: 'https://nowcoder.test/detail/1' })
      const parser = makeFakeParser(['https://nowcoder.test/list?p=1'], {
        '<html>page1</html>': [listCand]
      }, { ...listCand, jd: 'x' })
      const svc = makeService(fetcher, parser, {
        throttleMs: 2000,
        sleep: async (ms) => {
          fetcher.sleeps.push(ms)
        }
      })

      await svc.run('nowcoder', runOptions)

      expect(fetcher.sleeps).toEqual([2000])
    })
  })

  describe('重试（spec #13-21：失败重试 2 次，指数退避）', () => {
    it('前两次失败第三次成功：按 backoff*1、backoff*2 退避后拿到结果，不留错误', async () => {
      const failUrl = 'https://nowcoder.test/list?p=2'
      const fetcher = makeFakeFetcher({ ...PAGES }, [failUrl])
      // p2 前两次尝试失败、第三次成功（模拟瞬断恢复）：按 URL 计尝试次数
      let p2Attempts = 0
      const flakyFetcher: CrawlFetcher = {
        async fetch(url) {
          fetcher.calls.push(url)
          if (url === failUrl) {
            p2Attempts++
            if (p2Attempts <= 2) throw new Error('transient')
          }
          return PAGES[url as keyof typeof PAGES] ?? '<html>page2</html>'
        }
      }
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const sleeps: number[] = []
      const svc = makeService(flakyFetcher, parser, {
        retries: 2,
        backoffMs: 500,
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      })

      const result = await svc.run('nowcoder', runOptions)

      expect(result.candidates).toHaveLength(5) // 第 3 次成功拿到页 2
      // 页间节流 2000 + 两次退避 500/1000 + 页间节流 2000
      expect(sleeps).toEqual([2000, 500, 1000, 2000])
      expect(result.run.errors).toEqual([])
    })

    it('重试耗尽：该 URL 记入 errors（含 URL 与原因），其余页正常，status=partial', async () => {
      const badUrl = 'https://nowcoder.test/list?p=2'
      const fetcher = makeFakeFetcher({ ...PAGES }, [badUrl])
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser, { retries: 2, sleep: async () => {} })

      const result = await svc.run('nowcoder', runOptions)

      // 1 次 + 2 次重试 = 3 次尝试
      expect(fetcher.calls.filter((u) => u === badUrl)).toHaveLength(3)
      expect(result.run.errors).toHaveLength(1)
      expect(result.run.errors[0]).toMatch(badUrl)
      expect(result.run.errors[0]).toMatch(/fetch failed/)
      expect(result.candidates).toHaveLength(4) // 页 1 + 页 3
      expect(result.run.status).toBe('partial')
    })
  })

  describe('上限（spec #13-22：100 条截断）', () => {
    it('候选数达 maxItems 即截断：不再抓后续页，truncated=true，status=partial', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser, { maxItems: 3 })

      const result = await svc.run('nowcoder', runOptions)

      expect(result.candidates).toHaveLength(3)
      expect(result.run.truncated).toBe(true)
      expect(result.run.status).toBe('partial')
      // 只抓了页 1（2 条）+ 页 2（第 3 条达上限）；页 3 未抓
      expect(fetcher.calls).toEqual(['https://nowcoder.test/list?p=1', 'https://nowcoder.test/list?p=2'])
    })

    it('截断发生在详情补全之后（详情抓取不占候选名额，但达上限后不再抓新列表页）', async () => {
      const listCand = candidate('腾讯', '前端', 'p1', { detailUrl: 'https://nowcoder.test/detail/1' })
      const fetcher = makeFakeFetcher({
        'https://nowcoder.test/list?p=1': '<html>page1</html>',
        'https://nowcoder.test/detail/1': '<html>detail</html>',
        'https://nowcoder.test/list?p=2': '<html>page2</html>'
      })
      const parser = makeFakeParser(
        ['https://nowcoder.test/list?p=1', 'https://nowcoder.test/list?p=2'],
        { '<html>page1</html>': [listCand], '<html>page2</html>': page2Candidates },
        { ...listCand, jd: '详情 JD' }
      )
      const svc = makeService(fetcher, parser, { maxItems: 1 })

      const result = await svc.run('nowcoder', runOptions)

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0].jd).toBe('详情 JD')
      expect(fetcher.calls).toEqual(['https://nowcoder.test/list?p=1', 'https://nowcoder.test/detail/1'])
      expect(result.run.truncated).toBe(true)
    })
  })

  describe('crawl_runs 留痕（spec #13-23）', () => {
    it('run 落库：来源/模式/筛选词/URL 数/抓取数/候选数/状态/错误；runs() 倒序可查', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser)

      await svc.run('nowcoder', { mode: 'filter', filter: '腾讯' })
      await svc.run('nowcoder', { mode: 'full' })

      const runs = svc.runs()
      expect(runs).toHaveLength(2)
      const [latest, earlier] = runs
      expect(latest.mode).toBe('full')
      expect(latest.source).toBe('nowcoder')
      expect(latest.status).toBe('success')
      expect(latest.url_count).toBe(3)
      expect(latest.fetched_count).toBe(3)
      expect(latest.candidate_count).toBe(5)
      expect(latest.truncated).toBe(false)
      expect(latest.errors).toEqual([])
      expect(earlier.filter).toBe('腾讯')
      expect(earlier.id).toBeLessThan(latest.id)
    })

    it('getRun 返回候选快照（#29 预览确认的数据源）', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser)

      const { run } = await svc.run('nowcoder', runOptions)
      const stored = svc.getRun(run.id)

      expect(stored).not.toBeNull()
      expect(stored?.candidate_count).toBe(5)
      expect(svc.getRun(99999)).toBeNull()
    })

    it('全部 URL 失败 → status=failed，fetched_count=0', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES }, Object.keys(PAGES))
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const svc = makeService(fetcher, parser, { sleep: async () => {} })

      const result = await svc.run('nowcoder', runOptions)

      expect(result.candidates).toEqual([])
      expect(result.run.status).toBe('failed')
      expect(result.run.fetched_count).toBe(0)
      expect(result.run.errors).toHaveLength(3)
    })

    it('进度回调：每个 URL 处理后收到 { runId, done, total }', async () => {
      const fetcher = makeFakeFetcher({ ...PAGES })
      const parser = makeFakeParser(Object.keys(PAGES), ALL_PAGES)
      const progress: Array<{ runId: number; done: number; total: number }> = []
      const svc = makeService(fetcher, parser, { onProgress: (p) => progress.push(p) })

      const { run } = await svc.run('nowcoder', runOptions)

      expect(progress).toEqual([
        { runId: run.id, done: 1, total: 3 },
        { runId: run.id, done: 2, total: 3 },
        { runId: run.id, done: 3, total: 3 }
      ])
    })
  })
})
