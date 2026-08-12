import { describe, expect, it } from 'vitest'
import { BossFetcher, CompositeFetcher, jobListUrlFromSearchUrl } from './boss-fetcher'
import type { CrawlFetcher } from './crawl'

describe('jobListUrlFromSearchUrl（搜索页 URL → 列表接口 URL，纯函数）', () => {
  it('提取 query/city/page 并映射到 joblist.json', () => {
    expect(jobListUrlFromSearchUrl('https://www.zhipin.com/web/geek/job?query=%E5%89%8D%E7%AB%AF&city=101020100&page=2')).toBe(
      '/wapi/zpgeek/search/joblist.json?query=%E5%89%8D%E7%AB%AF&city=101020100&page=2'
    )
  })

  it('缺少参数时不带该参数', () => {
    expect(jobListUrlFromSearchUrl('https://www.zhipin.com/web/geek/job')).toBe(
      '/wapi/zpgeek/search/joblist.json?'
    )
  })
})

describe('CompositeFetcher（按 URL 路由到对应抓取器）', () => {
  it('boss URL 走 boss 抓取器，其余走默认抓取器', async () => {
    const bossCalls: string[] = []
    const defaultCalls: string[] = []
    const boss: CrawlFetcher = {
      async fetch(url) {
        bossCalls.push(url)
        return 'boss-html'
      }
    }
    const def: CrawlFetcher = {
      async fetch(url) {
        defaultCalls.push(url)
        return 'default-html'
      }
    }
    const composite = new CompositeFetcher(
      [{ match: (url) => url.startsWith('https://www.zhipin.com/'), fetcher: boss }],
      def
    )

    await expect(composite.fetch('https://www.zhipin.com/web/geek/job?query=x')).resolves.toBe('boss-html')
    await expect(composite.fetch('https://www.nowcoder.com/jobs/school/schedule')).resolves.toBe('default-html')
    expect(bossCalls).toHaveLength(1)
    expect(defaultCalls).toHaveLength(1)
  })

  it('dispose 传递给子抓取器', async () => {
    let bossDisposed = false
    const boss: CrawlFetcher = {
      async fetch() {
        return ''
      },
      dispose() {
        bossDisposed = true
      }
    }
    const composite = new CompositeFetcher(
      [{ match: () => false, fetcher: boss }],
      { async fetch() { return '' } }
    )
    await composite.dispose?.()
    expect(bossDisposed).toBe(true)
  })
})

describe('BossFetcher（真实窗口接线，逻辑断言）', () => {
  it('构造时使用 persist:boss 分区（登录态复用 T1）', () => {
    const fetcher = new BossFetcher()
    // 分区常量与 T1 登录服务一致（cookie 落盘复用）
    expect(fetcher.partition).toBe('persist:boss')
  })
})
