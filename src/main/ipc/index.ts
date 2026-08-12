import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  IpcChannel,
  IpcEvent,
  type AgentStatusInfo,
  type IpcChannelName,
  type IpcRequest,
  type IpcResponse,
  type PingResponse
} from '../../shared/protocol'
import { ping } from '../services/ping'
import type { AgentService } from '../services/agent'
import type { CrawlService } from '../services/crawl'
import type { OptimizeService } from '../services/optimize'
import type { TopicService } from '../services/topic'
import type { LearnService } from '../services/learn'
import type { InterviewService } from '../services/interview'
import type { AsrService } from '../services/asr'
import type { PositionService } from '../services/position'
import { exportResumePdf } from '../services/resume-export'
import type { ResumeService } from '../services/resume'
import type { SettingsService } from '../services/settings'
import { pushEvent } from './events'
import type { BossLoginService } from '../services/boss-login'

/** 类型化 handler 注册：通道与请求/响应类型由 IpcProtocol 推导（无类型绕过）。 */
function handleRequest<C extends IpcChannelName>(
  channel: C,
  handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>
): void {
  ipcMain.handle(channel, (_event: IpcMainInvokeEvent, request: IpcRequest<C>) => handler(request))
}

export interface IpcDeps {
  settings: SettingsService
  agent: AgentService
  positions: PositionService
  resumes: ResumeService
  crawls: CrawlService
  bossLogin: BossLoginService
  optimize: OptimizeService
  topics: TopicService
  learn: LearnService
  interview: InterviewService
  asr: AsrService
}

/**
 * 注册全部 IPC handler（薄层：仅参数校验 + 转调服务）。
 * 主进程启动时调用一次；后续通道（EF-04 起）在此追加。
 */
export function registerIpcHandlers({ settings, agent, positions, resumes, crawls, bossLogin, optimize, topics, learn, interview, asr }: IpcDeps): void {
  handleRequest(IpcChannel.Ping, (): PingResponse => ping())

  handleRequest(IpcChannel.SettingsGet, (request) => settings.get(request.key))
  handleRequest(IpcChannel.SettingsSet, (request) => {
    settings.set(request.key, request.value)
    // settings 变更广播：主 → 渲染事件推送（EF-03 验收：事件可达）
    pushEvent(IpcEvent.SettingsChanged, { key: request.key, value: request.value })
  })
  handleRequest(IpcChannel.SettingsGetAll, () => settings.getAll())

  // EF-04：agent 认证状态与配置（分层降级依据：get-status 未配置时渲染层引导）
  handleRequest(IpcChannel.SettingsGetStatus, (): AgentStatusInfo => agent.getStatus())
  handleRequest(IpcChannel.SettingsConfigureProvider, (request) =>
    agent.configureProvider(request.provider, request.apiKey, request.model)
  )

  // F-01（#17）：职位录入 —— 服务层负责校验/去重（dedupe_key），错误 message 透传渲染层提示
  handleRequest(IpcChannel.PositionsCreate, (request) => positions.create(request))
  // F-02（#18）：职位列表 —— 四维筛选 + days_left 倒计时（服务层计算，null=待核实）
  handleRequest(IpcChannel.PositionsList, (request) => positions.list(request))
  // F-03（#20）：职位详情/编辑/删除 —— get 详情页数据源；update patch 语义（校验/查重服务层完成）；
  // delete 级联删投递记录（applications 表由 #21 建，服务层探测兼容）
  handleRequest(IpcChannel.PositionsGet, (request) => positions.get(request.id))
  handleRequest(IpcChannel.PositionsUpdate, (request) => positions.update(request.id, request.patch))
  handleRequest(IpcChannel.PositionsDelete, (request) => positions.delete(request.id))
  // F-05（#21）：投递状态流转 —— 状态机校验在服务层（非法流转抛 transition，message 透传）
  handleRequest(IpcChannel.PositionsGetApplication, (request) => positions.getApplication(request.positionId))
  handleRequest(IpcChannel.PositionsSetApplication, (request) =>
    positions.setApplicationState(request.positionId, request.patch)
  )

  // F-08（#22）：采集执行框架 —— 进度经 crawl:progress 事件推送（服务层 onProgress 回调接入）
  handleRequest(IpcChannel.CrawlRun, (request) =>
    crawls.run(request.source, request.options)
  )
  handleRequest(IpcChannel.CrawlRuns, () => crawls.runs())
  handleRequest(IpcChannel.CrawlGetRun, (request) => crawls.getRun(request.id))
  handleRequest(IpcChannel.BossLoginOpen, () => bossLogin.openLoginWindow())
  handleRequest(IpcChannel.BossLoginStatus, () => bossLogin.isLoggedIn())
  // F-11（#29）：预览统计 + 确认导入（upsert：source_url 优先 + dedupe_key 兜底）
  handleRequest(IpcChannel.CrawlPreview, (request) => crawls.preview(request.runId))
  // #32：优化流程触发（三轮进度已由 OptimizeService onProgress → optimize:progress 推送）
  handleRequest(IpcChannel.OptimizeRun, (request) =>
    optimize.run(request.jobId, request.resumeId, request.mode)
  )
  // F-19（#33）：学习清单生成与人工 CRUD
  handleRequest(IpcChannel.TopicsList, (request) => topics.list(request))
  handleRequest(IpcChannel.TopicsGenerate, (request) =>
    topics.generateFromJob(request.jobId, request.extras)
  )
  handleRequest(IpcChannel.TopicsCreate, (request) => topics.create(request.input))
  handleRequest(IpcChannel.TopicsUpdate, (request) => topics.update(request.id, request.patch))
  handleRequest(IpcChannel.TopicsDelete, (request) => topics.delete(request.id))
  handleRequest(IpcChannel.TopicsSetStatus, (request) => topics.setStatus(request.id, request.status))
  handleRequest(IpcChannel.TopicsCreateInterviewSuggestion, (request) =>
    topics.createInterviewSuggestion(request.title, request.note, request.jobId)
  )
  // F-22（#36）：teach 聊天会话（流式增量经全局 agent:delta 推送，UI 打字机消费）
  handleRequest(IpcChannel.LearnStart, (request) => learn.start(request.topicId))
  handleRequest(IpcChannel.LearnSend, (request) => learn.send(request.sessionId, request.text))
  // F-23（#37）：面试会话编排（阶段推进/风格/动态难度/transcript 落库）
  handleRequest(IpcChannel.InterviewStart, (request) => interview.start(request.jobId, request.style))
  handleRequest(IpcChannel.InterviewAnswer, (request) => interview.answer(request.sessionId, request.text))
  handleRequest(IpcChannel.InterviewInterrupt, (request) => interview.interrupt(request.sessionId))
  handleRequest(IpcChannel.InterviewFollowUp, (request) => interview.followUp(request.sessionId, request.text))
  handleRequest(IpcChannel.InterviewEnd, (request) => interview.end(request.sessionId))
  handleRequest(IpcChannel.InterviewHistory, () => interview.history())
  // F-26（#40）：语音输入（PTT）——未就绪抛 ASR_NOT_READY（渲染层降级文字输入）
  handleRequest(IpcChannel.AsrGetStatus, () => asr.getStatus())
  handleRequest(IpcChannel.AsrTranscribe, (request) => asr.stopRecording(new Uint8Array(request.wav)))
  handleRequest(IpcChannel.CrawlConfirmImport, (request) =>
    crawls.confirmImport(request.runId, request.sourceUrls)
  )

  // F-12（issue #19）：简历 CRUD —— 服务层负责 schema 校验与删除语义（基准删除不影响派生稿）
  handleRequest(IpcChannel.ResumesList, () => resumes.list())
  handleRequest(IpcChannel.ResumesCreate, (request) => resumes.create(request.resume))
  handleRequest(IpcChannel.ResumesUpdate, (request) => resumes.update(request.id, request.resume))
  handleRequest(IpcChannel.ResumesDelete, (request) => resumes.delete(request.id))
  // F-14（#26）：简历上传解析（docx/pdf → 草稿；不支持类型/解析失败错误 message 透传）
  handleRequest(IpcChannel.ResumesUploadParse, (request) => resumes.parseUpload(request.filePath))
  // F-15（#30）：A4 渲染（纯函数）与 PDF 导出（printToPDF + 保存对话框）
  handleRequest(IpcChannel.ResumesRenderHtml, (request) => resumes.renderHtml(request.id))
  handleRequest(IpcChannel.ResumesExportPdf, (request) => {
    const html = resumes.renderHtml(request.id)
    const title = resumes.get(request.id)?.meta.title ?? '简历'
    return exportResumePdf(html, title)
  })
}
