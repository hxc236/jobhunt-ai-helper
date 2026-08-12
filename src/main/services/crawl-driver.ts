import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'

/**
 * CrawlDriver（issue #59）：Agent 通道的"手"——真实浏览器交互抽象。
 * 决策循环（CrawlAgentChannel）只依赖本接口，fake 可测；真实实现用
 * playwright-core connectOverCDP 连接应用自身 Chromium（CDP 端口只绑
 * 127.0.0.1、随机端口——启动参数 remote-debugging-port=0，端口号写
 * userData/DevToolsActivePort，用完即关连接）。
 */

/** 驱动动作（决策循环输出 → driver 执行）。 */
export type DriverAction =
  | { type: 'click'; selector: string }
  | { type: 'type'; selector: string; text: string }
  | { type: 'wait'; ms: number }

export interface CrawlDriver {
  /** 导航到 URL（阻塞至页面主框架加载完成）。 */
  navigate(url: string): Promise<void>
  /** 当前页面 DOM 文本快照（决策循环的观察输入；最多截取 maxChars）。 */
  snapshot(maxChars?: number): Promise<string>
  /** 执行一个动作。 */
  act(action: DriverAction): Promise<void>
  /** 登录状态（BOSS 场景：分区 cookie 是否有效）。 */
  loginStatus(): Promise<'logged-in' | 'logged-out'>
  /** 释放连接。 */
  dispose(): Promise<void>
}

/** 从 userData/DevToolsActivePort 读取 CDP 调试端口（Electron remote-debugging-port=0 写入）。 */
export function readDevToolsPort(userDataDir: string): number | null {
  try {
    const raw = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf-8').trim()
    const port = Number(raw.split('\n')[0])
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

export interface PlaywrightCdpDriverOptions {
  /** 应用 userData 目录（读 DevToolsActivePort；缺省传函数可注入）。 */
  userDataDir: string
  /** 窗口 URL 前缀匹配（选择驱动哪个窗口；缺省取第一个页面）。 */
  urlPrefix?: string
  /** 连接超时（ms）。 */
  timeoutMs?: number
}

/** 真实驱动：playwright-core connectOverCDP 连应用自带 Chromium。 */
export class PlaywrightCdpDriver implements CrawlDriver {
  private browser: Browser | null = null
  private page: Page | null = null
  private readonly userDataDir: string
  private readonly urlPrefix: string | undefined
  private readonly timeoutMs: number

  constructor(options: PlaywrightCdpDriverOptions) {
    this.userDataDir = options.userDataDir
    this.urlPrefix = options.urlPrefix
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async navigate(url: string): Promise<void> {
    const page = await this.ensurePage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs })
  }

  async snapshot(maxChars = 3000): Promise<string> {
    const page = await this.ensurePage()
    const text = (await page.evaluate('document.body?.innerText ?? \'\'')) as string
    return text.slice(0, maxChars)
  }

  async act(action: DriverAction): Promise<void> {
    const page = await this.ensurePage()
    switch (action.type) {
      case 'click':
        await page.locator(action.selector).first().click({ timeout: this.timeoutMs })
        break
      case 'type':
        await page.locator(action.selector).first().fill(action.text, { timeout: this.timeoutMs })
        break
      case 'wait':
        await page.waitForTimeout(action.ms)
        break
    }
  }

  async loginStatus(): Promise<'logged-in' | 'logged-out'> {
    try {
      const page = await this.ensurePage()
      const code = (await page.evaluate(() =>
        fetch('/wapi/zpuser/wap/getUserInfo.json')
          .then((r) => r.json())
          .catch(() => ({ code: -1 }))
      )) as { code?: number }
      return code?.code === 0 ? 'logged-in' : 'logged-out'
    } catch {
      return 'logged-out'
    }
  }

  async dispose(): Promise<void> {
    await this.browser?.close().catch(() => undefined)
    this.browser = null
    this.page = null
  }

  private async ensurePage(): Promise<Page> {
    if (this.page !== null && !this.page.isClosed()) return this.page
    if (this.browser === null) {
      const port = readDevToolsPort(this.userDataDir)
      if (port === null) {
        throw new Error('未找到 DevToolsActivePort——应用需以 --remote-debugging-port=0 启动')
      }
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    }
    const contexts = this.browser.contexts()
    let page: Page | null = null
    const prefix = this.urlPrefix
    for (const context of contexts) {
      const candidates = context.pages()
      page =
        prefix === undefined ? candidates[0] : (candidates.find((p) => p.url().startsWith(prefix)) ?? null)
      if (page !== null) break
    }
    if (page === null) {
      throw new Error('CDP 无可用页面窗口')
    }
    this.page = page
    return page
  }
}
