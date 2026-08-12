import { BrowserWindow } from 'electron'
import type { CrawlFetcher } from './crawl'
import { BOSS_PARTITION } from './boss-login'

/**
 * BOSS 真实抓取器（issue #56）。
 *
 * 数据形态：BOSS 是 SPA，职位数据在页面内 XHR（joblist.json / detail.json）——
 * 隐藏窗口（persist:boss 分区，登录态复用 T1）加载搜索页后，页面内 fetch 目标接口
 * （同源、携带 cookie 与浏览器环境，curl 直连必被 code:37 拒绝）。
 *
 * 频率纪律（框架层保证）：每次 fetch 独立窗口（每窗口单导航）、窗口间冷却 30s+
 * （CrawlService cooldownMs）、同 URL 不二次导航（框架队列去重）；本实现不补发
 * 页面稳定后的多余请求（一次 fetch 恰好一次接口调用）。
 */
export class BossFetcher implements CrawlFetcher {
  readonly partition = BOSS_PARTITION

  private static readonly SEARCH_PAGE = 'https://www.zhipin.com/web/geek/job'

  async fetch(url: string): Promise<string> {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: BOSS_PARTITION,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    try {
      // 列表 URL = 搜索页；详情 URL = 接口地址——统一先加载搜索页（真实页面环境），再页面内 fetch
      const pageUrl = url.startsWith(BossFetcher.SEARCH_PAGE) ? url : BossFetcher.SEARCH_PAGE
      await win.loadURL(pageUrl)
      await new Promise((resolve) => setTimeout(resolve, 2000)) // 页面 XHR 自然执行期
      const target = url.startsWith(BossFetcher.SEARCH_PAGE) ? jobListUrlFromSearchUrl(url) : url
      const text = (await win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(target)})
           .then((r) => r.text())
           .catch(() => '')`
      )) as string
      if (typeof text !== 'string' || text === '') {
        throw new Error(`BOSS 接口无响应：${target}`)
      }
      return text
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

/** 搜索页 URL → 列表接口 URL（query/city/page 透传；纯函数可测）。 */
export function jobListUrlFromSearchUrl(searchUrl: string): string {
  const url = new URL(searchUrl)
  const params = new URLSearchParams()
  for (const key of ['query', 'city', 'page']) {
    const value = url.searchParams.get(key)
    if (value !== null && value !== '') params.set(key, value)
  }
  return `/wapi/zpgeek/search/joblist.json?${params.toString()}`
}

/**
 * 按 URL 路由的组合抓取器（issue #56）：BOSS 走 BossFetcher（登录分区），
 * 牛客/猎聘走默认 BrowserWindowFetcher（匿名独立窗口）。
 */
export class CompositeFetcher implements CrawlFetcher {
  constructor(
    private readonly routes: Array<{ match: (url: string) => boolean; fetcher: CrawlFetcher }>,
    private readonly fallback: CrawlFetcher
  ) {}

  async fetch(url: string): Promise<string> {
    const route = this.routes.find((r) => r.match(url))
    return (route?.fetcher ?? this.fallback).fetch(url)
  }

  async dispose(): Promise<void> {
    for (const route of this.routes) {
      await route.fetcher.dispose?.()
    }
    await this.fallback.dispose?.()
  }
}
