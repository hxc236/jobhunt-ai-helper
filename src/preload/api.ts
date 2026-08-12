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
export function createRendererApi(bridge: IpcBridge): RendererApi {
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
    resumes: {
      list: () => bridge.invoke(IpcChannel.ResumesList),
      create: (resume) => bridge.invoke(IpcChannel.ResumesCreate, { resume }),
      update: (id, resume) => bridge.invoke(IpcChannel.ResumesUpdate, { id, resume }),
      delete: (id) => bridge.invoke(IpcChannel.ResumesDelete, { id }),
      uploadParse: (filePath) => bridge.invoke(IpcChannel.ResumesUploadParse, { filePath }),
      renderHtml: (id) => bridge.invoke(IpcChannel.ResumesRenderHtml, { id }),
      exportPdf: (id) => bridge.invoke(IpcChannel.ResumesExportPdf, { id })
    },
    crawls: {
      run: (source, options) => bridge.invoke(IpcChannel.CrawlRun, { source, options }),
      runs: () => bridge.invoke(IpcChannel.CrawlRuns),
      getRun: (id) => bridge.invoke(IpcChannel.CrawlGetRun, { id }),
      preview: (runId) => bridge.invoke(IpcChannel.CrawlPreview, { runId }),
      confirmImport: (runId, sourceUrls) =>
        bridge.invoke(IpcChannel.CrawlConfirmImport, { runId, sourceUrls })
    },
    optimize: {
      run: (jobId, resumeId, mode) =>
        bridge.invoke(IpcChannel.OptimizeRun, { jobId, resumeId, mode })
    },
    topics: {
      list: (filters) => bridge.invoke(IpcChannel.TopicsList, filters ?? {}),
      generate: (jobId, extras) => bridge.invoke(IpcChannel.TopicsGenerate, { jobId, extras }),
      create: (input) => bridge.invoke(IpcChannel.TopicsCreate, { input }),
      update: (id, patch) => bridge.invoke(IpcChannel.TopicsUpdate, { id, patch }),
      delete: (id) => bridge.invoke(IpcChannel.TopicsDelete, { id }),
      setStatus: (id, status) => bridge.invoke(IpcChannel.TopicsSetStatus, { id, status })
    },
    on: <E extends IpcEventName>(event: E, listener: (payload: IpcEventMap[E]) => void) =>
      bridge.on(event, (payload) => listener(payload as IpcEventMap[E]))
  }
}
