import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './db/database'
import { registerIpcHandlers } from './ipc'
import { IpcEvent } from '../shared/protocol'
import { pushEvent } from './ipc/events'
import { AgentService, type AgentEvent } from './services/agent'
import { PiAgentProvider } from './services/pi-agent-provider'
import { BrowserWindowFetcher } from './services/browser-window-fetcher'
import { CrawlService } from './services/crawl'
import { NowcoderParser } from './services/parsers/nowcoder'
import { PositionService } from './services/position'
import { ResumeService } from './services/resume'
import { SettingsService } from './services/settings'

/** agent 事件 → 主 → 渲染事件推送（agent:delta 流式文本 / agent:status 状态与错误）。 */
function forwardAgentEvent(sessionId: string, event: AgentEvent): void {
  switch (event.type) {
    case 'text_delta':
      pushEvent(IpcEvent.AgentDelta, { sessionId, delta: event.delta })
      break
    case 'status':
      pushEvent(IpcEvent.AgentStatus, { sessionId, status: event.status })
      break
    case 'error':
      pushEvent(IpcEvent.AgentStatus, { sessionId, status: 'error', detail: event.message })
      break
    default:
      // turn_end / tool_* 暂不推送（业务服务按会话订阅消费）
      break
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: '求职助手',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload 脚本要求关闭沙箱（Electron 限制）
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 外部链接交给系统浏览器，不在应用内新开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    // dev：加载 electron-vite 渲染进程 dev server
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // 构建产物
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 单文件本地库：userData/jobhunt.db（EF-02；测试注入 :memory: 见 db/database.ts）
  const db = openDatabase(join(app.getPath('userData'), 'jobhunt.db'))
  const settings = new SettingsService(db)
  // F-01（#17）：职位卡（手动录入 + 去重，见 services/position.ts）
  const positions = new PositionService(db)
  // F-12（issue #19）：简历 CRUD（schema 校验 + 删除语义，见 services/resume.ts）
  const resumes = new ResumeService(db)
  // F-08（#22）：采集执行框架（隐藏 BrowserWindow 抓取 + 节流/重试/上限 + 留痕；
  // 解析器由 #23 牛客 / #24 猎聘 注册；进度经 crawl:progress 事件推送）
  const crawls = new CrawlService(db, new BrowserWindowFetcher(), {
    onProgress: ({ runId, done, total }) => pushEvent(IpcEvent.CrawlProgress, { runId, done, total })
  })
  // F-09（#23）：牛客校招日程解析器（列表/翻页/详情 → 字段映射，纯函数）
  crawls.registerParser(new NowcoderParser())

  // EF-04：AgentService（pi SDK 封装 + fake 可注入）。认证目录为应用自有 userData/pi
  // （auth.json/models.json/sessions），不依赖用户 ~/.pi/agent；teach 技能用仓库内置副本。
  const agent = new AgentService(
    new PiAgentProvider({
      dataDir: join(app.getPath('userData'), 'pi'),
      teachSkillDir: join(app.getAppPath(), 'resources', 'teach'),
      settings
    }),
    { onEvent: forwardAgentEvent }
  )

  registerIpcHandlers({ settings, agent, positions, resumes, crawls })
  createWindow()

  app.on('activate', () => {
    // macOS：点击 Dock 图标且无窗口时重建
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => agent.dispose())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
