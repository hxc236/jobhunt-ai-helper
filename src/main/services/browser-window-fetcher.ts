import { BrowserWindow } from 'electron'
import type { CrawlFetcher } from './crawl'

/**
 * 真实抓取器（ADR-0006）：隐藏 BrowserWindow + executeJavaScript 提取 DOM。
 * - 每次 fetch 一个隐藏窗口（独立会话，页面隔离；用后即毁）；
 * - loadURL 等待 did-finish-load，settleMs 后再取 DOM（分页 XHR 自然执行时间）；
 * - 不做自动化测试（spec Testing Decisions），手动冒烟验证。
 */
export class BrowserWindowFetcher implements CrawlFetcher {
  constructor(
    private readonly options: {
      /** did-finish-load 后等待渲染稳定（XHR 补数据）的毫秒数；默认 1500。 */
      settleMs?: number
      /** 抓取前注入的脚本（如设置 UA/屏蔽弹窗）；默认无。 */
      preScript?: string
    } = {}
  ) {}

  async fetch(url: string): Promise<string> {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        // 关闭沙箱便于 executeJavaScript 注入（与主窗口一致）
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    try {
      await win.loadURL(url)
      const settleMs = this.options.settleMs ?? 1500
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs))
      }
      if (this.options.preScript !== undefined) {
        await win.webContents.executeJavaScript(this.options.preScript)
      }
      return (await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      )) as string
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  async dispose(): Promise<void> {
    // 每次 fetch 独立窗口，无长驻资源
  }
}
