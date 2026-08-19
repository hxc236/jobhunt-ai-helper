import {
  IpcChannel,
  type IpcEventMap,
  type IpcEventName,
  type IpcInvoker,
  type RendererApi
} from '../shared/protocol'

/** 注入面：把 Electron ipcRenderer 收窄为两个纯函数（便于单测，不依赖 Electron）。 */
export interface IpcBridge {
  invoke: IpcInvoker
  on: (channel: string, listener: (payload: unknown) => void) => () => void
}

/**
 * 渲染侧 api 客户端：channel → 类型化方法（「无类型绕过」：方法名与载荷类型
 * 均由 shared/protocol 的 IpcProtocol / IpcEventMap 推导，渲染层不出现裸 channel 字符串）。
 */
export function createRendererApi(bridge: IpcBridge): Omit<RendererApi, 'getPathForFile'> {
  return {
    ping: () => bridge.invoke(IpcChannel.Ping),
    settings: {
      get: (key) => bridge.invoke(IpcChannel.SettingsGet, { key }),
      set: (key, value) => bridge.invoke(IpcChannel.SettingsSet, { key, value }),
      getAll: () => bridge.invoke(IpcChannel.SettingsGetAll),
      getStatus: () => bridge.invoke(IpcChannel.SettingsGetStatus),
      configureProvider: (provider, apiKey, model) =>
        bridge.invoke(IpcChannel.SettingsConfigureProvider, { provider, apiKey, model })
    },
    positions: {
      create: (input) => bridge.invoke(IpcChannel.PositionsCreate, input),
      list: (filters) => bridge.invoke(IpcChannel.PositionsList, filters ?? {}),
      get: (id) => bridge.invoke(IpcChannel.PositionsGet, { id }),
      update: (id, patch) => bridge.invoke(IpcChannel.PositionsUpdate, { id, patch }),
      delete: (id) => bridge.invoke(IpcChannel.PositionsDelete, { id }),
      getApplication: (positionId) => bridge.invoke(IpcChannel.PositionsGetApplication, { positionId }),
      setApplication: (positionId, patch) =>
        bridge.invoke(IpcChannel.PositionsSetApplication, { positionId, patch })
    },
    csvImport: {
      preview: (filePath) => bridge.invoke(IpcChannel.CsvImportPreview, { filePath }),
      confirm: (items) => bridge.invoke(IpcChannel.CsvImportConfirm, { items }),
      template: () => bridge.invoke(IpcChannel.CsvImportTemplate)
    },
    resumes: {
      list: () => bridge.invoke(IpcChannel.ResumesList),
      create: (resume) => bridge.invoke(IpcChannel.ResumesCreate, { resume }),
      update: (id, resume) => bridge.invoke(IpcChannel.ResumesUpdate, { id, resume }),
      delete: (id) => bridge.invoke(IpcChannel.ResumesDelete, { id }),
      importDocx: {
        start: (filePath) => bridge.invoke(IpcChannel.ResumesImportStart, { filePath }),
        cancel: (token) => bridge.invoke(IpcChannel.ResumesImportCancel, { token }),
        confirm: (token, resume) => bridge.invoke(IpcChannel.ResumesImportConfirm, { token, resume }),
        dispose: (token) => bridge.invoke(IpcChannel.ResumesImportDispose, { token }),
        decide: (token, kind, choice) => bridge.invoke(IpcChannel.ResumesImportAgentDecide, { token, kind, choice })
      },
      renderHtml: (id) => bridge.invoke(IpcChannel.ResumesRenderHtml, { id }),
      renderFromResume: (resume) => bridge.invoke(IpcChannel.ResumesRenderFromResume, { resume }),
      importPhoto: (filePath) => bridge.invoke(IpcChannel.ResumesImportPhoto, { filePath }),
      removePhoto: (fileName) => bridge.invoke(IpcChannel.ResumesRemovePhoto, { fileName }),
      photoDataUri: (fileName) => bridge.invoke(IpcChannel.ResumesPhotoDataUri, { fileName }),
      export: (id, format) => bridge.invoke(IpcChannel.ResumesExport, { id, format })
    },
    crawls: {
      run: (source, options) => bridge.invoke(IpcChannel.CrawlRun, { source, options }),
      runs: () => bridge.invoke(IpcChannel.CrawlRuns),
      getRun: (id) => bridge.invoke(IpcChannel.CrawlGetRun, { id }),
      preview: (runId) => bridge.invoke(IpcChannel.CrawlPreview, { runId }),
      confirmImport: (runId, sourceUrls) =>
        bridge.invoke(IpcChannel.CrawlConfirmImport, { runId, sourceUrls }),
      bossLogin: {
        open: () => bridge.invoke(IpcChannel.BossLoginOpen),
        status: () => bridge.invoke(IpcChannel.BossLoginStatus),
        clear: () => bridge.invoke(IpcChannel.BossLoginClear)
      },
      ocrExtract: (source) => bridge.invoke(IpcChannel.PositionOcrExtract, { source }),
      crawlPresets: {
        list: () => bridge.invoke(IpcChannel.CrawlPresetsList),
        create: (name, conditions) => bridge.invoke(IpcChannel.CrawlPresetsCreate, { name, conditions }),
        delete: (id) => bridge.invoke(IpcChannel.CrawlPresetsDelete, { id })
      }
    },
    optimize: {
      run: (jobId, resumeId, mode) =>
        bridge.invoke(IpcChannel.OptimizeRun, { jobId, resumeId, mode })
    },
    contentOptimize: {
      start: (resumeId) => bridge.invoke(IpcChannel.ContentOptimizeStart, { resumeId }),
      list: () => bridge.invoke(IpcChannel.ContentOptimizeList),
      get: (taskId) => bridge.invoke(IpcChannel.ContentOptimizeGet, { taskId }),
      submitAnswers: (taskId, answers) =>
        bridge.invoke(IpcChannel.ContentOptimizeSubmitAnswers, { taskId, answers }),
      confirm: (taskId) => bridge.invoke(IpcChannel.ContentOptimizeConfirm, { taskId }),
      cancel: (taskId) => bridge.invoke(IpcChannel.ContentOptimizeCancel, { taskId }),
      retry: (taskId) => bridge.invoke(IpcChannel.ContentOptimizeRetry, { taskId }),
      resume: (taskId) => bridge.invoke(IpcChannel.ContentOptimizeResume, { taskId }),
      void: (taskId) => bridge.invoke(IpcChannel.ContentOptimizeVoid, { taskId })
    },
    learn: {
      start: (topicId) => bridge.invoke(IpcChannel.LearnStart, { topicId }),
      send: (sessionId, text) => bridge.invoke(IpcChannel.LearnSend, { sessionId, text })
    },
    asr: {
      getStatus: () => bridge.invoke(IpcChannel.AsrGetStatus),
      transcribe: (wav) => bridge.invoke(IpcChannel.AsrTranscribe, { wav: Array.from(wav) })
    },
    interview: {
      start: (jobId, style) => bridge.invoke(IpcChannel.InterviewStart, { jobId, style }),
      answer: (sessionId, text) => bridge.invoke(IpcChannel.InterviewAnswer, { sessionId, text }),
      interrupt: (sessionId) => bridge.invoke(IpcChannel.InterviewInterrupt, { sessionId }),
      followUp: (sessionId, text) => bridge.invoke(IpcChannel.InterviewFollowUp, { sessionId, text }),
      end: (sessionId) => bridge.invoke(IpcChannel.InterviewEnd, { sessionId }),
      history: () => bridge.invoke(IpcChannel.InterviewHistory)
    },
    topics: {
      list: (filters) => bridge.invoke(IpcChannel.TopicsList, filters ?? {}),
      generate: (jobId, extras) => bridge.invoke(IpcChannel.TopicsGenerate, { jobId, extras }),
      create: (input) => bridge.invoke(IpcChannel.TopicsCreate, { input }),
      update: (id, patch) => bridge.invoke(IpcChannel.TopicsUpdate, { id, patch }),
      delete: (id) => bridge.invoke(IpcChannel.TopicsDelete, { id }),
      setStatus: (id, status) => bridge.invoke(IpcChannel.TopicsSetStatus, { id, status }),
      createInterviewSuggestion: (title, note, jobId) =>
        bridge.invoke(IpcChannel.TopicsCreateInterviewSuggestion, { title, note, jobId })
    },
    on: <E extends IpcEventName>(event: E, listener: (payload: IpcEventMap[E]) => void) =>
      bridge.on(event, (payload) => listener(payload as IpcEventMap[E]))
  }
}
