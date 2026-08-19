import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './db/database'
import { registerIpcHandlers } from './ipc'
import { IpcEvent } from '../shared/protocol'
import { pushEvent } from './ipc/events'
import { AgentService, type AgentEvent } from './services/agent'
import { PiAgentProvider } from './services/pi-agent-provider'
import { BrowserWindowFetcher } from './services/browser-window-fetcher'
import { BossFetcher, CompositeFetcher } from './services/boss-fetcher'
import { CrawlService } from './services/crawl'
import { CrawlAgentChannelImpl } from './services/crawl-agent-channel'
import { PlaywrightCdpDriver } from './services/crawl-driver'
import { CrawlPresetService } from './services/crawl-presets'
import { OptimizeService } from './services/optimize'
import { migrateLegacyResumes } from './services/resume-migrate'
import { PhotoStore } from './services/photo-store'
import { TopicService } from './services/topic'
import { LearnService } from './services/learn'
import { InterviewService } from './services/interview'
import { AsrService, SherpaAsrProvider } from './services/asr'
import { ResumeImportService } from './services/resume-import'
import { WindowsPdfOcrAdapter } from './services/ocr-import'
import { disposeRasterWindow } from './services/pdf-raster'
import { NowcoderParser } from './services/parsers/nowcoder'
import { LiepinParser } from './services/parsers/liepin'
import { BossParser } from './services/parsers/boss'
import { BossLoginService } from './services/boss-login'
import { collectBossPage, toBossPageDraft } from './services/boss-page-extract'
import { PositionService } from './services/position'
import { CsvImportService } from './services/csv-import'
import { ResumeService } from './services/resume'
import { SettingsService } from './services/settings'

/** agent 事件 → 主 → 渲染事件推送（agent:delta 流式文本 / agent:status 状态与错误）。 */function forwardAgentEvent(sessionId: string, event: AgentEvent): void {
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
    width: 1280,
    height: 800,
    minWidth: 1080, // #42 Q15：设计目标窗口 1280×800 起，下限对齐原型 CSS min-width
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

// issue #59：Agent 通道的 CDP 驱动基础——随机本地调试端口（只绑 127.0.0.1，端口号写
// userData/DevToolsActivePort），playwright-core connectOverCDP 驱动应用自带 Chromium。
app.commandLine.appendSwitch('remote-debugging-port', '0')

app.whenReady().then(() => {
  // 单文件本地库：userData/jobhunt.db（EF-02；测试注入 :memory: 见 db/database.ts）
  const db = openDatabase(join(app.getPath('userData'), 'jobhunt.db'))
  // ADR-0009：旧简历模型（技能条目/项目冗余字段）一次性幂等迁移 → v2
  const migratedResumes = migrateLegacyResumes(db)
  if (migratedResumes > 0) console.log(`[resume-migrate] ${migratedResumes} 份简历已迁移到 v2 模型`)
  const settings = new SettingsService(db)
  // F-01（#17）：职位卡（手动录入 + 去重，见 services/position.ts）
  const positions = new PositionService(db)
  // #68/T3：CSV 批量导入（预览/勾选批量 upsert——复用 PositionService 规范校验与插入/更新路径）
  const csvImport = new CsvImportService(positions)
  // F-12（issue #19）：简历 CRUD（schema 校验 + 删除语义，见 services/resume.ts）
  // ADR-0009：照片存储目录（userData/resume-photos），删除简历随删照片
  const resumePhotos = new PhotoStore(join(app.getPath('userData'), 'resume-photos'))
  const resumes = new ResumeService(db, resumePhotos)
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
  // issue #59：Agent 通道（决策循环 + playwright-core CDP 驱动；登录/异常场景介入）
  const agentChannel = new CrawlAgentChannelImpl(
    new PlaywrightCdpDriver({
      userDataDir: app.getPath('userData'),
      urlPrefix: 'https://www.zhipin.com/'
    }),
    agent
  )
  // F-08（#22）：采集执行框架（隐藏 BrowserWindow 抓取 + 节流/重试/上限 + 留痕；
  // 解析器由 #23 牛客 / #24 猎聘 注册；进度经 crawl:progress 事件推送）
  const crawls = new CrawlService(
    db,
    // issue #56：BOSS 走登录分区抓取器（persist:boss 复用 T1 登录态），牛客/猎聘走默认
    new CompositeFetcher(
      [{ match: (url) => url.startsWith('https://www.zhipin.com/'), fetcher: new BossFetcher() }],
      new BrowserWindowFetcher()
    ),
    {
      // BOSS 频率纪律（issue #55/#56）：窗口间 30s 冷却（调研实测 30-60s）
      cooldownMs: 30_000,
      onProgress: ({ runId, done, total }) => pushEvent(IpcEvent.CrawlProgress, { runId, done, total }),
      agentChannel
    }
  )
  // issue #62：BOSS 窗口 F8 → 只读提取详情页文本 → 事件推送给渲染层预填录入表单
  const bossLogin = new BossLoginService({
    onExtractShortcut: (win) => {
      void (async () => {
        try {
          const raw = await collectBossPage(win)
          pushEvent(IpcEvent.BossPageExtracted, toBossPageDraft(raw))
        } catch (err) {
          pushEvent(IpcEvent.BossPageExtracted, {
            draft: null,
            error: err instanceof Error ? err.message : 'BOSS 页面读取失败'
          })
        }
      })()
    }
  })
  // issue #57：常用采集（crawl_presets 表 CRUD）
  const crawlPresets = new CrawlPresetService(db)
  // F-09（#23）：牛客校招日程解析器（列表/翻页/详情 → 字段映射，纯函数）
  crawls.registerParser(new NowcoderParser())
  // F-10（#24）：猎聘校招项目卡解析器（SSR 列表 → 字段映射；end_date 恒 null → 待核实）
  crawls.registerParser(new LiepinParser())
  // issue #53/#56：BOSS直聘解析器（SPA 接口 JSON → 职位卡；结构化采集条件驱动）
  crawls.registerParser(new BossParser())

  // F-07（#28/#32）：优化流程服务（三轮编排 + jd_analysis 缓存；进度 → optimize:progress）
  const optimize = new OptimizeService(db, positions, resumes, agent, {
    onProgress: ({ jobId, round, phase }) => pushEvent(IpcEvent.OptimizeProgress, { jobId, round, phase }),
    photos: resumePhotos
  })
  // F-19（#33）：学习清单服务（jd_analysis → 优先级 1-5 清单 + 人工 CRUD + 三态）
  const topics = new TopicService(db, positions)
  // F-22（#36）：teach 聊天会话（learn 任务 /skill:teach + continueRecent 跨次续接）
  const learn = new LearnService(agent, topics)
  // F-23（#37）：模拟面试编排（四阶段 + 风格 + 动态难度 + transcript 落库；复盘 #39）
  const interview = new InterviewService(db, positions, resumes, topics, agent)
  // F-26（#40）：语音输入（PTT + sherpa-onnx 流式 + VAD 端点切句；模型缺失 → 降级文字输入）
  const asr = new AsrService(
    new SherpaAsrProvider(join(app.getAppPath(), 'resources', 'sherpa-onnx'))
  )
  // #75/#77：简历导入（DOCX/PDF 本地导入闭环 + Agent 自动结构化）——token 化异步流程，事件推送阶段/结果
  // #81：扫描型 PDF → Windows OCR（栅格化 + 中文 OCR；缺语言包时给出明确错误）
  const resumeImport = new ResumeImportService({
    resumeService: resumes,
    // #77：Agent 结构化（未配置/关闭/失败自动降级本地草稿）；settings 存开关与隐私同意
    agent,
    settings,
    // #81：扫描型 PDF OCR adapter（真实 Windows OCR；自动化测试注入替身）
    ocrAdapter: new WindowsPdfOcrAdapter(),
    emit: (event) => {
      switch (event.type) {
        case 'progress':
          pushEvent(IpcEvent.ResumesImportProgress, { token: event.token, phase: event.phase, ...(event.detail !== undefined ? { detail: event.detail } : {}) })
          break
        case 'done':
          pushEvent(IpcEvent.ResumesImportDone, {
            token: event.token,
            draft: event.draft,
            resume: event.resume,
            agent: { used: event.agent.used, failedReason: event.agent.failedReason }
          })
          break
        case 'error':
          pushEvent(IpcEvent.ResumesImportError, { token: event.token, code: event.code, message: event.message })
          break
        case 'cancelled':
          pushEvent(IpcEvent.ResumesImportCancelled, { token: event.token })
          break
        case 'agent_pending':
          pushEvent(IpcEvent.ResumesImportAgentPending, { token: event.token, kind: event.kind })
          break
      }
    }
  })

  registerIpcHandlers({ settings, agent, positions, resumes, resumeImport, crawls, bossLogin, crawlPresets, optimize, topics, learn, interview, asr, csvImport })
  createWindow()

  app.on('activate', () => {
    // macOS：点击 Dock 图标且无窗口时重建
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    agent.dispose()
    disposeRasterWindow() // #81：释放栅格化隐藏窗口
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
