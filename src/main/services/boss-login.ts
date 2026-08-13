import { BrowserWindow } from 'electron'

/**
 * BOSS 登录态（issue #51）：持久化会话 + 扫码登录窗口 + 状态检测。
 *
 * - 登录窗口与检测窗口统一用 `persist:boss` 分区：cookie 落盘到应用 userData
 *   （重启应用登录态不丢；T6 抓取窗口复用同一分区继承登录态）；
 * - 登录方式：打开可见窗口加载 BOSS 主站，用户点击登录/扫码后自行关闭窗口；
 * - 状态检测：分区内隐藏窗口加载搜索页，页面内 fetch getUserInfo（SPA 自身
 *   登录态探测接口），code===0 = 已登录；失败/异常一律视为未登录（不抛）；
 * - issue #62：窗口内 F8 快捷键 → onExtractShortcut 回调（人工浏览详情页时
 *   只读提取页面文本；before-input-event 拦截，不向页面注入任何内容）。
 */
export const BOSS_PARTITION = 'persist:boss'

/** 登录/检测窗口的 webPreferences（与采集隐藏窗口一致：sandbox 关、隔离开）。 */
const BOSS_WINDOW_PREFERENCES = {
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false,
  partition: BOSS_PARTITION
} as const

export interface BossLoginServiceOptions {
  /** issue #62：BOSS 窗口内 F8 提取快捷键回调（携窗口引用；由调用方执行只读采集）。 */
  onExtractShortcut?: (win: BrowserWindow) => void
}

export class BossLoginService {
  private loginWindow: BrowserWindow | null = null

  constructor(private readonly options: BossLoginServiceOptions = {}) {}

  /** 打开可见登录窗口（已开则聚焦）。用户扫码登录后自行关闭。 */
  openLoginWindow(): void {
    if (this.loginWindow !== null && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return
    }
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      title: 'BOSS直聘登录',
      autoHideMenuBar: true,
      webPreferences: { ...BOSS_WINDOW_PREFERENCES }
    })
    this.loginWindow = win
    win.on('closed', () => {
      this.loginWindow = null
    })
    // issue #62：F8 提取（keyDown 拦截；页面不可见该按键）
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F8') {
        event.preventDefault()
        this.options.onExtractShortcut?.(win)
      }
    })
    void win.loadURL('https://www.zhipin.com/web/geek/job')
  }

  /**
   * 登录状态检测：分区内隐藏窗口加载搜索页，页面内 fetch getUserInfo
   * （真实端点 /wapi/zpuser/wap/getUserInfo.json，网络捕获实测；code===0 = 已登录）。
   * 等待 settleMs 让页面 XHR 自然执行（与采集抓取同一节奏）；任何异常 → false。
   */
  async isLoggedIn(settleMs = 1500): Promise<boolean> {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { ...BOSS_WINDOW_PREFERENCES }
    })
    try {
      await win.loadURL('https://www.zhipin.com/web/geek/job')
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs))
      }
      const result = (await win.webContents.executeJavaScript(
        `fetch('/wapi/zpuser/wap/getUserInfo.json')
           .then((r) => r.json())
           .catch(() => ({ code: -1 }))`
      )) as { code?: number }
      return result?.code === 0
    } catch {
      return false
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
