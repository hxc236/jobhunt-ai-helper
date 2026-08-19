<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Resume, StoredResume } from '@shared/types/resume'
import type { ResumeDraft, ContentOptimizeTask, ContentQuestion } from '@shared/types'
import { CONTENT_STATUS_LABELS } from '@shared/types'
import { contentQuestionKey } from '@shared/content-answers'
import { IpcEvent } from '@shared/protocol'
import { defaultBaseTitle, emptyResumeForm, formToResume, issueSection, keepEmptyRows, resumeToForm, SKILL_CATEGORIES, type ResumeForm } from '../resume-form'
import { FACT_SOURCE_LABELS, PROJECT_VERDICT_LABELS, RULE_STATUS_LABELS, ruleName } from '../content-diagnosis-view'
import {
  ANSWER_ACTION_LABELS,
  answerCounts,
  applyCandidate,
  buildAnswersRecord,
  emptyDrafts,
  setAnswerAction,
  type AnswerAction,
  type AnswerDraft
} from '../content-answers-form'
import Modal from '../components/Modal.vue'
import Resizer from '../components/Resizer.vue'
import Icon from '../components/Icon.vue'
import Pill from '../components/Pill.vue'

/**
 * 简历模块（#42 T3）：双栏 = 列表（基准/派生分组）+ 工作区（上传草稿确认 / 分节编辑器 / JSON 模式）。
 * 功能 = 原 ResumesView（F-13/#25 编辑器 + F-15/#30 A4 预览导出 + F-16/#31 上传草稿确认）。
 */

const resumes = ref<StoredResume[]>([])
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

/** 编辑器状态：null = 列表模式；'' = 新建基准简历；其余 = 编辑该 id。 */
const editingId = ref<string | null | ''>(null)
const jsonMode = ref(false)
const jsonText = ref('')
const jsonError = ref('')
const issues = ref<Array<{ path: string; detail: string }>>([])
const saving = ref(false)
const deleteTarget = ref<StoredResume | null>(null)

/** A4 预览与 PDF 导出（F-15/#30）。 */
const previewHtml = ref('')
const previewTitle = ref('')
const previewId = ref('')
/** 预览来源：true = 编辑器内未保存表单（previewCurrent），导出前需先保存/校验。 */
const previewFromForm = ref(false)
const exporting = ref(false)
const exportMessage = ref('')
const previewError = ref('')
/** 列表行导出菜单：当前打开的菜单所属简历 id（null = 关闭）。 */
const exportMenuTarget = ref<string | null>(null)

function closeExportMenu(): void {
  exportMenuTarget.value = null
}

/** 导入流程（#75 DOCX）：null = 无进行中导入；token '' = start 同步校验失败（仅错误展示）。 */
interface ImportState {
  token: string
  phase: string
  error: string | null
  /** 阶段详情（如 OCR 第 N/M 页）。 */
  detail: string | null
  /** #77：待用户决策的 Agent 环节（隐私同意 / 超时）。 */
  pendingKind: 'consent' | 'timeout' | null
}
const importState = ref<ImportState | null>(null)
/** 编辑器导入草稿模式：非 null 时保存 = 确认创建基准简历；携带完整草稿供核对面板展示。 */
const importDraft = ref<{
  token: string
  fileName: string
  draft: ResumeDraft
  /** Agent 最终结构化结果；fallback 时为本地 Resume。 */
  resume: Resume
  agent: { used: boolean; failedReason?: string }
} | null>(null)
/** Agent 未使用原因文案（#77 降级展示）。 */
const AGENT_FAILED_LABEL: Record<string, string> = {
  'agent-not-configured': '未配置模型（可到设置中配置）',
  'agent-disabled': '设置中已关闭 Agent 导入增强',
  'consent-declined': '未同意发送简历内容',
  'user-local': '已选择使用本地草稿',
  'agent-failed': 'Agent 调用失败，已用本地草稿',
  'invalid-output': 'Agent 输出连续非法，已用本地草稿'
}
/** 字段显示名与来源状态文案（#76：替代单一整体置信度）。 */
const FIELD_LABEL: Record<string, string> = {
  name: '姓名', phone: '电话', email: '邮箱', birthday: '生日', gender: '性别', education: '教育经历', skills: '技能'
}
const FIELD_STATUS_LABEL: Record<string, string> = {
  text: '文本提取', ocr: 'OCR 提取', agent: 'Agent 映射', suspected: '疑似修正', missing: '缺失', unmapped: '未映射'
}
/** 逐页路由风险文案（#82）。 */
const PAGE_RISK_LABEL: Record<string, string> = {
  pending: '待确认',
  'low-confidence': '低置信度（请重点核对）',
  reflowed: '双栏已按坐标重排',
  'ocr-needed': '无文本层（需要 OCR）'
}

/** 核对面板：某字段的解析值预览（教育/技能为拼接展示）。 */
function fieldPreview(key: string): string {
  const resume = importDraft.value?.resume
  if (resume === undefined) return ''
  switch (key) {
    case 'name': return resume.basics.name
    case 'phone': return resume.basics.phone ?? ''
    case 'email': return resume.basics.email ?? ''
    case 'birthday': return resume.basics.birthday ?? ''
    case 'gender': return resume.basics.gender ?? ''
    case 'education':
      return resume.education.map((e) => [e.school, e.degree, e.major].filter((v) => v !== undefined && v !== '').join(' ')).join('；')
    case 'skills': return (resume.skills ?? []).map((s) => `${s.category}：${s.text}`).join('；')
    default: return ''
  }
}

function formatResume(resume: Resume): string {
  return JSON.stringify(resume, null, 2)
}
/** 导入进度阶段文案（主进程 phase 码 → 展示）。 */
const IMPORT_PHASE_LABEL: Record<string, string> = {
  read: '读取文件',
  parse: '解析文本',
  map: '生成草稿',
  agent: 'Agent 结构化',
  ocr: 'OCR 识别'
}
/** 离开导入流程前的取消确认弹窗。 */
const importCancelConfirm = ref(false)

const importFileInput = ref<HTMLInputElement | null>(null)

function pickImportFile(): void {
  importFileInput.value?.click()
}

async function onImportFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) return
  const filePath = window.api.getPathForFile(file)
  if (filePath === '') {
    errorMessage.value = '无法获取文件路径'
    return
  }
  try {
    const { token } = await window.api.resumes.importDocx.start(filePath)
    importState.value = { token, phase: 'read', error: null, detail: null, pendingKind: null }
  } catch (err) {
    // start 同步校验失败（类型/大小/不可读）：弹窗展示错误与替代入口
    importState.value = { token: '', phase: 'read', error: String(err), detail: null, pendingKind: null }
  }
}

/** 取消进行中的导入（静默：cancelled 事件关闭弹窗，不当作错误）。 */
async function cancelImport(): Promise<void> {
  const state = importState.value
  importCancelConfirm.value = false
  if (state === null || state.token === '') return
  await window.api.resumes.importDocx.cancel(state.token)
}

/** 关闭导入错误弹窗：有 token 时释放主进程草稿（不写库）。 */
function closeImportError(): void {
  const state = importState.value
  if (state !== null && state.token !== '') {
    void window.api.resumes.importDocx.dispose(state.token)
  }
  importState.value = null
}

/** 放弃导入草稿（离开编辑器/切换列表）：不写库。 */
async function abandonImportDraft(): Promise<void> {
  const draft = importDraft.value
  if (draft === null) return
  await window.api.resumes.importDocx.dispose(draft.token)
  importDraft.value = null
}

/** #77：答复 Agent 决策（同意/拒绝、继续等待/本地草稿）。 */
async function decideAgent(kind: 'consent' | 'timeout', choice: 'agree' | 'decline' | 'continue' | 'local'): Promise<void> {
  const state = importState.value
  if (state === null || state.token === '') return
  state.pendingKind = null
  await window.api.resumes.importDocx.decide(state.token, kind, choice)
}

/** 导入完成 → 打开完整编辑器（草稿模式：确认后创建新基准简历）。 */
function openImportEditor(
  mapped: Resume,
  draft: { token: string; fileName: string; draft: ResumeDraft; agent: { used: boolean; failedReason?: string } }
): void {
  errorMessage.value = ''
  successMessage.value = ''
  issues.value = []
  jsonError.value = ''
  loadingForm = true
  Object.assign(form, resumeToForm(mapped))
  loadingForm = false
  formDirty = false
  editingId.value = ''
  jsonMode.value = false
  importDraft.value = { ...draft, resume: mapped }
}

/** 导入事件订阅（onMounted 注册 / onUnmounted 注销；按 token 过滤）。 */
function subscribeImportEvents(): () => void {
  const offs = [
    window.api.on(IpcEvent.ResumesImportProgress, (payload) => {
      const state = importState.value
      if (state === null || state.token !== payload.token) return
      state.phase = payload.phase
      state.detail = payload.detail ?? null
    }),
    window.api.on(IpcEvent.ResumesImportDone, (payload) => {
      const state = importState.value
      if (state === null || state.token !== payload.token) return
      if (payload.draft.scanned) {
        // OCR 全空/未注入 adapter 的安全兜底：不建空草稿，引导换文件或手动新建
        importState.value = {
          token: '',
          phase: 'read',
          error: '该 PDF 无法提取到可用文本（扫描件且 OCR 未启用或结果为空）。可重试、换用清晰文件或手动新建简历。',
          detail: null,
          pendingKind: null
        }
        void window.api.resumes.importDocx.dispose(payload.token)
        return
      }
      importState.value = null
      openImportEditor(payload.resume, {
        token: payload.token,
        fileName: payload.draft.fileName,
        draft: payload.draft,
        agent: payload.agent
      })
    }),
    window.api.on(IpcEvent.ResumesImportAgentPending, (payload) => {
      const state = importState.value
      if (state === null || state.token !== payload.token) return
      state.pendingKind = payload.kind
    }),
    window.api.on(IpcEvent.ResumesImportError, (payload) => {
      const state = importState.value
      if (state === null || state.token !== payload.token) return
      state.error = payload.message
    }),
    window.api.on(IpcEvent.ResumesImportCancelled, (payload) => {
      const state = importState.value
      if (state === null || state.token !== payload.token) return
      importState.value = null
    })
  ]
  return () => {
    offs.forEach((off) => off())
    // 离开本视图：释放进行中的导入与草稿（不写库；本规格不建设跨页面继续任务）
    const st = importState.value
    if (st !== null && st.token !== '') void window.api.resumes.importDocx.dispose(st.token)
    if (importDraft.value !== null) void window.api.resumes.importDocx.dispose(importDraft.value.token)
    importState.value = null
    importDraft.value = null
  }
}

async function openPreview(resume: StoredResume): Promise<void> {
  previewError.value = ''
  exportMessage.value = ''
  previewId.value = resume.meta.id as string
  previewFromForm.value = false
  try {
    previewHtml.value = await window.api.resumes.renderHtml(resume.meta.id as string)
    previewTitle.value = resume.meta.title ?? '简历'
  } catch (err) {
    previewError.value = String(err)
  }
}

/** A4 预览缩放（弹窗放大 + 默认适配整页 + 按钮/Ctrl+滚轮调节）。 */
const previewZoom = ref(1)
const PREVIEW_ZOOM_MIN = 0.4
const PREVIEW_ZOOM_MAX = 1.5
const a4FrameRef = ref<HTMLIFrameElement | null>(null)
/** iframe 内容实际高度（自适应：内层永不产生滚动条，滚动只留在弹窗最外层）。 */
const a4ContentHeight = ref(1123)

function fitFrameHeight(): void {
  const frame = a4FrameRef.value
  const doc = frame?.contentDocument
  if (doc?.body !== undefined && doc.body.scrollHeight > 0) {
    // +2 缓冲：抵消 iframe 1px 边框对视口的占用，确保内层 0 滚动
    a4ContentHeight.value = doc.body.scrollHeight + 2
    // iframe 内 Ctrl+滚轮缩放：跨文档冒泡不可靠，直接向同源 srcdoc 注入监听（每文档一次）
    const docAny = doc as Document & { __zoomBound?: boolean }
    if (!docAny.__zoomBound) {
      docAny.__zoomBound = true
      doc.addEventListener('wheel', onPreviewWheel, { passive: false })
    }
  }
  // 每次打开预览默认适配整页（用户手动缩放不触发 load，不会被覆盖）
  previewZoom.value = fitPreviewZoom()
}

/** 适配：让整页 A4（834×内容高）在弹窗可视区内完整可见（预留弹窗头/内边距缓冲）。 */
function fitPreviewZoom(): number {
  const widthFit = (960 - 60) / 834
  const heightFit = (window.innerHeight * 0.86 - 140) / a4ContentHeight.value
  return Math.max(PREVIEW_ZOOM_MIN, Math.min(1, widthFit, heightFit))
}

function zoomPreviewBy(delta: number): void {
  previewZoom.value = Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, previewZoom.value + delta))
}

/** Ctrl+滚轮缩放（非 Ctrl 滚轮留给弹窗滚动，不拦截）。 */
function onPreviewWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return
  event.preventDefault()
  zoomPreviewBy(-event.deltaY * 0.001)
}

/** 弹窗区域任意位置的 Ctrl+滚轮（iframe 内部由注入监听处理；此处跳过 iframe 目标避免双倍缩放）。 */
function onDocWheel(event: WheelEvent): void {
  if (!event.ctrlKey || previewHtml.value === '') return
  if (!(event.target instanceof Node)) return
  const mask = document.querySelector('.mask.open')
  if (mask === null || !mask.contains(event.target)) return
  if (event.target instanceof HTMLIFrameElement) return // iframe 内事件已由注入监听处理
  event.preventDefault()
  zoomPreviewBy(-event.deltaY * 0.001)
}

async function previewCurrent(): Promise<void> {
  previewError.value = ''
  exportMessage.value = ''
  try {
    const resume: Resume = jsonMode.value ? (JSON.parse(jsonText.value) as Resume) : formToResume(form)
    previewHtml.value = await window.api.resumes.renderFromResume(resume)
    previewTitle.value = resume.meta.title ?? '简历'
    previewId.value = editingId.value ?? ''
    previewFromForm.value = true
  } catch (err) {
    previewError.value = String(err)
  }
}

/**
 * 导出简历（#74：PDF/DOCX 双格式）。
 * - 编辑器内预览（previewFromForm）导出前先走保存/校验流程：校验失败阻止导出并定位问题；
 * - 列表行预览使用已保存版本（id 导出）；
 * - 取消/成功/失败均返回明确消息。
 */
async function exportResume(format: 'pdf' | 'docx'): Promise<void> {
  exporting.value = true
  exportMessage.value = ''
  try {
    let id = previewId.value
    if (previewFromForm.value) {
      const saved = await save()
      if (!saved || issues.value.length > 0) {
        exportMessage.value = '导出已阻止：当前修改未通过校验（见上方问题列表，修复后重试）'
        return
      }
      if (editingId.value === null || editingId.value === '') {
        exportMessage.value = '导出失败：保存后仍未取得简历标识'
        return
      }
      id = editingId.value
    }
    if (id === '') {
      exportMessage.value = '导出失败：缺少简历标识'
      return
    }
    const path = await window.api.resumes.export(id, format)
    exportMessage.value = path === null ? '已取消导出' : `已导出：${path}`
  } catch (err) {
    exportMessage.value = `导出失败：${String(err)}`
  } finally {
    exporting.value = false
  }
}

/** 列表行「导出」菜单：先渲染 A4 预览（已保存版本）再按所选格式导出。 */
async function exportFromRow(resume: StoredResume, format: 'pdf' | 'docx'): Promise<void> {
  exportMenuTarget.value = null
  await openPreview(resume)
  if (previewError.value === '') await exportResume(format)
}

const form = reactive<ResumeForm>(emptyResumeForm())

/** 照片（ADR-0009）：导入即复制到照片目录，表单只存文件名；缩略图经 IPC 取 data URI。 */
const photoInput = ref<HTMLInputElement | null>(null)
const photoPreviewUrl = ref('')
watch(
  () => form.basics.photo,
  async (photo) => {
    photoPreviewUrl.value = photo === '' ? '' : ((await window.api.resumes.photoDataUri(photo)) ?? '')
  }
)

async function pickPhoto(): Promise<void> {
  photoInput.value?.click()
}

async function onPhotoPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) return
  // Electron 32+ 移除 File.path：路径经 preload webUtils.getPathForFile 解析
  const filePath = window.api.getPathForFile(file)
  if (filePath === '') {
    errorMessage.value = '无法获取文件路径'
    return
  }
  try {
    const photo = await window.api.resumes.importPhoto(filePath)
    if (form.basics.photo !== '') await window.api.resumes.removePhoto(form.basics.photo) // 替换时清旧文件
    form.basics.photo = photo
  } catch (err) {
    errorMessage.value = `照片导入失败：${String(err)}`
  }
}

async function removePhoto(): Promise<void> {
  if (form.basics.photo === '') return
  await window.api.resumes.removePhoto(form.basics.photo)
  form.basics.photo = ''
}

/** 列表行内改名（双击名称）。 */
const renameTarget = ref<StoredResume | null>(null)
const renameTitle = ref('')

function startRename(resume: StoredResume): void {
  renameTarget.value = resume
  renameTitle.value = resume.meta.title ?? ''
}

async function commitRename(): Promise<void> {
  const target = renameTarget.value
  if (target === null) return
  const title = renameTitle.value.trim()
  if (title === '' || title === (target.meta.title ?? '')) {
    renameTarget.value = null
    return
  }
  try {
    // 深拷贝为纯对象：浅拷贝会带 Vue reactive Proxy 嵌套，IPC 结构化克隆失败（"could not be cloned"）
    const payload = structuredClone({ ...target, meta: { ...target.meta, title } })
    await window.api.resumes.update(target.meta.id as string, payload)
    await load()
  } catch (err) {
    errorMessage.value = `改名失败：${String(err)}`
  } finally {
    renameTarget.value = null
  }
}

/** 改名输入按键：IME 组合期间忽略（修复中文输入 Enter 提前提交/静默丢失）。 */
function onRenameKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter') void commitRename()
  else if (event.key === 'Escape') renameTarget.value = null
}

function onRenameFocus(event: FocusEvent): void {
  ;(event.target as HTMLInputElement | null)?.select()
}

const bases = computed(() => resumes.value.filter((r) => r.meta.baseResumeId == null))
const derived = computed(() => resumes.value.filter((r) => r.meta.baseResumeId != null))
const editingExisting = computed(() => editingId.value !== null && editingId.value !== '')

/** 内容优化任务（#90/T02）：任务卡片列表（按创建时间倒序）。 */
const contentTasks = ref<ContentOptimizeTask[]>([])
const contentTaskError = ref('')

/** 追问批量回答草稿（#94/T04：按任务 id → 问题键 → 草稿；任务卡存在期间保留）。 */
const answerDrafts = ref<Record<string, Record<string, AnswerDraft>>>({})

/** 某任务关联的简历标题（任务卡片展示）。 */
function contentResumeTitle(task: ContentOptimizeTask): string {
  const resume = resumes.value.find((r) => r.meta.id === task.resumeId)
  return resume?.meta.title ?? '（简历已删除）'
}

/** 项目显示名（#93 任务卡片诊断区：projectId → 项目名，缺失回退 id）。 */
function projectDisplayName(task: ContentOptimizeTask, projectId: string): string {
  const resume = resumes.value.find((r) => r.meta.id === task.resumeId)
  const project = resume?.projects?.find((p) => p.id === projectId)
  return project?.name ?? projectId
}

async function loadContentTasks(): Promise<void> {
  try {
    contentTasks.value = await window.api.contentOptimize.list()
  } catch (err) {
    contentTaskError.value = `加载内容优化任务失败：${String(err)}`
  }
}

/** 触发内容优化（基准简历行按钮）。 */
async function startContentOptimize(resume: StoredResume): Promise<void> {
  contentTaskError.value = ''
  try {
    await window.api.contentOptimize.start(resume.meta.id as string)
    await loadContentTasks()
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

/** 确认任务（可确认 / 无需修改均走确认；返回新简历 id 或 null）。 */
async function confirmContentTask(task: ContentOptimizeTask): Promise<void> {
  contentTaskError.value = ''
  try {
    const { createdResumeId } = await window.api.contentOptimize.confirm(task.id)
    await Promise.all([loadContentTasks(), load()])
    successMessage.value =
      createdResumeId === null
        ? '内容优化确认完成：无需修改，未创建新版本'
        : '内容优化确认完成：已生成新的基准简历'
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

async function cancelContentTask(task: ContentOptimizeTask): Promise<void> {
  contentTaskError.value = ''
  try {
    await window.api.contentOptimize.cancel(task.id)
    await loadContentTasks()
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

async function retryContentTask(task: ContentOptimizeTask): Promise<void> {
  contentTaskError.value = ''
  try {
    await window.api.contentOptimize.retry(task.id)
    await loadContentTasks()
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

async function resumeContentTask(task: ContentOptimizeTask): Promise<void> {
  contentTaskError.value = ''
  try {
    await window.api.contentOptimize.resume(task.id)
    await loadContentTasks()
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

async function voidContentTask(task: ContentOptimizeTask): Promise<void> {
  contentTaskError.value = ''
  try {
    await window.api.contentOptimize.void(task.id)
    await loadContentTasks()
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

// ---- 追问批量回答表单（#94/T04：分组/候选/四选一/自由输入/跳过） ----

/** 任务的问题草稿（懒初始化；任务卡刷新（事件推送）后仍保留，按任务 id 键控）。 */
function draftsFor(task: ContentOptimizeTask): Record<string, AnswerDraft> {
  const questions = task.diagnosis?.questions ?? []
  let drafts = answerDrafts.value[task.id]
  if (drafts === undefined) {
    drafts = emptyDrafts(questions)
    answerDrafts.value[task.id] = drafts
  }
  return drafts
}

/** 已答 X/Y · 未答 N 计数（Y=问题总数；X=有答案或有明确处置）。 */
function answersCountFor(task: ContentOptimizeTask): { answered: number; total: number; unanswered: number } {
  return answerCounts(draftsFor(task), task.diagnosis?.questions ?? [])
}

/** 按项目分组（保留问题出现顺序；key=稳定问题键）。 */
function answerGroups(
  task: ContentOptimizeTask
): Array<{ projectId: string; questions: Array<{ key: string; question: ContentQuestion }> }> {
  const questions = task.diagnosis?.questions ?? []
  const groups = new Map<string, Array<{ key: string; question: ContentQuestion }>>()
  questions.forEach((q, i) => {
    const key = contentQuestionKey(q, i)
    const list = groups.get(q.projectId) ?? []
    list.push({ key, question: q })
    groups.set(q.projectId, list)
  })
  return [...groups.entries()].map(([projectId, list]) => ({ projectId, questions: list }))
}

/** 选中候选 = 确认属实（答案=候选原文）。 */
function onCandidatePick(task: ContentOptimizeTask, q: ContentQuestion, key: string, index: number): void {
  const draft = draftsFor(task)[key]
  if (draft !== undefined) applyCandidate(draft, q, index)
}

/** 四选一动作按钮（确认属实/编辑后确认/不属实/无法补充）。 */
function onAnswerAction(
  task: ContentOptimizeTask,
  q: ContentQuestion,
  key: string,
  action: Exclude<AnswerAction, 'none'>
): void {
  const draft = draftsFor(task)[key]
  if (draft !== undefined) setAnswerAction(draft, action, q)
}

/** 输入框编辑：未答→自由输入；确认候选后被改动→编辑后确认。 */
function onAnswerInput(task: ContentOptimizeTask, key: string, event: Event): void {
  const draft = draftsFor(task)[key]
  if (draft === undefined) return
  draft.text = (event.target as HTMLTextAreaElement).value
  if (draft.action === 'none' || draft.action === 'confirm') draft.action = 'free'
}

/** 提交追问回答（手动点击「生成优化稿」；未答项保持缺失，不阻塞）。 */
async function submitContentAnswers(task: ContentOptimizeTask): Promise<void> {
  contentTaskError.value = ''
  const questions = task.diagnosis?.questions ?? []
  const answers = buildAnswersRecord(questions, draftsFor(task))
  try {
    await window.api.contentOptimize.submitAnswers(task.id, answers)
    delete answerDrafts.value[task.id]
    await loadContentTasks()
  } catch (err) {
    contentTaskError.value = String(err)
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    resumes.value = await window.api.resumes.list()
  } catch (err) {
    errorMessage.value = `加载简历列表失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

function openEditor(resume?: StoredResume): void {
  errorMessage.value = ''
  successMessage.value = ''
  issues.value = []
  jsonError.value = ''
  loadingForm = true
  Object.assign(form, resume === undefined ? emptyResumeForm() : resumeToForm(resume))
  loadingForm = false
  formDirty = false
  editingId.value = resume?.meta.id ?? ''
  jsonMode.value = false
  renameTarget.value = null
  // 照片缩略图由 watch(form.basics.photo) 统一刷新
}

async function closeEditor(): Promise<void> {
  if (autosaveTimer !== undefined) {
    clearTimeout(autosaveTimer)
    autosaveTimer = undefined
  }
  if (importDraft.value !== null) {
    // 导入草稿：离开即放弃（确认必须显式点击「确认并创建基准简历」，不自动保存/不入库）
    await abandonImportDraft()
  } else if (formDirty && !saving.value) {
    // 自动保存兜底：返回列表前仍有未保存改动 → 先存
    await save()
  }
  editingId.value = null
  issues.value = []
}

/** 自动保存（体验定稿）：脏标记 + 焦点脱离即存（防抖）+ 关闭/切窗兜底。 */
let formDirty = false
let loadingForm = false
let autosaveTimer: ReturnType<typeof setTimeout> | undefined

watch(
  form,
  () => {
    if (!loadingForm) formDirty = true
  },
  { deep: true }
)

function scheduleAutosave(): void {
  // 导入草稿必须显式点击「确认并创建基准简历」，不能被编辑器自动保存提前入库。
  if (importDraft.value !== null || !formDirty || saving.value) return
  if (autosaveTimer !== undefined) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = undefined
    void save()
  }, 500)
}

function onWindowBlur(): void {
  scheduleAutosave()
}

onUnmounted(() => {
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onWindowBlur)
  document.removeEventListener('wheel', onDocWheel)
  document.removeEventListener('click', closeExportMenu)
})

function switchToJson(): void {
  jsonText.value = JSON.stringify(formToResume(form), null, 2)
  jsonError.value = ''
  jsonMode.value = true
}

function switchToForm(): void {
  try {
    const parsed = JSON.parse(jsonText.value) as Resume
    loadingForm = true
    Object.assign(form, resumeToForm(parsed))
    loadingForm = false
    formDirty = false
    jsonError.value = ''
    jsonMode.value = false
  } catch (err) {
    jsonError.value = `JSON 解析失败：${String(err)}`
  }
}

async function save(): Promise<boolean> {
  if (saving.value) return false // 防并发：手动保存与自动保存互斥
  issues.value = []
  successMessage.value = ''
  let resume: Resume
  if (jsonMode.value) {
    try {
      resume = JSON.parse(jsonText.value) as Resume
    } catch (err) {
      jsonError.value = `JSON 解析失败：${String(err)}`
      return false
    }
  } else {
    // 新建基准简历默认名：姓名-基准简历（ADR-0009）
    if (form.meta.title.trim() === '') form.meta.title = defaultBaseTitle(form.basics.name)
    resume = formToResume(form)
  }

  saving.value = true
  const closed = editingId.value === null // 保存期间用户已返回列表（自动保存竞态）
  try {
    const targetId = editingId.value
    const importToken = importDraft.value?.token
    const stored =
      importToken !== undefined
        ? await window.api.resumes.importDocx.confirm(importToken, resume)
        : targetId !== null && targetId !== ''
          ? await window.api.resumes.update(targetId, resume)
          : await window.api.resumes.create(resume)
    if (closed) return false // 已关闭：不回填表单、不重新打开编辑器
    successMessage.value = `已保存「${stored.meta.title ?? stored.meta.id}」`
    if (importToken !== undefined) importDraft.value = null
    loadingForm = true
    // 回填保留空行：自动保存/手动保存不会清掉用户刚添加的空表单（keepEmptyRows）
    Object.assign(form, keepEmptyRows(form, resumeToForm(stored)))
    loadingForm = false
    formDirty = false
    if (jsonMode.value) jsonText.value = JSON.stringify(stored, null, 2)
    editingId.value = stored.meta.id
    await load()
    return true
  } catch (err) {
    const anyErr = err as { issues?: Array<{ instancePath: string; message?: string }> }
    if (Array.isArray(anyErr.issues) && anyErr.issues.length > 0) {
      issues.value = anyErr.issues.map((i) => ({
        path: issueSection(i.instancePath ?? ''),
        detail: i.message ?? i.instancePath ?? ''
      }))
    } else {
      issues.value = [{ path: '保存失败', detail: String(err) }]
    }
    return false
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (target === null) return
  try {
    await window.api.resumes.delete(target.meta.id as string)
    if (editingId.value === String(target.meta.id)) closeEditor()
    deleteTarget.value = null
    await load()
  } catch (err) {
    errorMessage.value = `删除失败：${String(err)}`
  }
}

/** 编辑器分节收起（问题反馈：表单太长时折叠已填内容）。localStorage 持久化。 */
const FOLD_KEYS = ['basics', 'education', 'honors', 'skills', 'projects', 'experience', 'research', 'selfAssessment'] as const
type FoldKey = (typeof FOLD_KEYS)[number]
const FOLD_STORAGE_KEY = 'resume-editor.fold.v1'

function loadFold(): Record<FoldKey, boolean> {
  const init = Object.fromEntries(FOLD_KEYS.map((k) => [k, false])) as Record<FoldKey, boolean>
  try {
    const raw = localStorage.getItem(FOLD_STORAGE_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Record<string, boolean>
      for (const k of FOLD_KEYS) if (typeof parsed[k] === 'boolean') init[k] = parsed[k]
    }
  } catch {
    // 忽略损坏数据，用默认展开
  }
  return init
}

const fold = reactive<Record<FoldKey, boolean>>(loadFold())
watch(fold, () => {
  try {
    localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify(fold))
  } catch {
    // 存储不可用（隐私模式等）时忽略
  }
})

function toggleFold(key: FoldKey): void {
  fold[key] = !fold[key]
}

/** 收起时标题旁徽标：列表节显示条数；单块节显示「已填写」。空时返回 ''。 */
function foldBadge(key: FoldKey): string {
  switch (key) {
    case 'education':
    case 'projects':
    case 'experience':
    case 'research':
      return form[key].length > 0 ? `${form[key].length}条` : ''
    case 'honors':
      return form.honorsText.trim() !== '' ? '已填写' : ''
    case 'skills':
      return SKILL_CATEGORIES.some((c) => form.skills[c].trim() !== '') ? '已填写' : ''
    case 'selfAssessment':
      return form.selfAssessment.trim() !== '' ? '已填写' : ''
    case 'basics': {
      const b = form.basics
      const values = [
        b.name, b.phone, b.email, b.location, b.birthday, b.gender, b.politicalStatus, b.hometown,
        b.jobIntention.position, b.jobIntention.cityText, b.jobIntention.salary, b.photo,
        ...b.links.flatMap((l) => [l.label, l.url])
      ]
      return values.some((v) => v.trim() !== '') ? '已填写' : ''
    }
  }
}

/** 收起状态下点「+ 添加」：先展开该节再添加（避免新行不可见）。 */
function addRowAndExpand<K extends keyof ResumeForm>(
  key: K,
  template: ResumeForm[K] extends Array<infer T> ? T : never
): void {
  if (FOLD_KEYS.includes(key as FoldKey)) fold[key as FoldKey] = false
  addRow(key, template)
}

function addRow<K extends keyof ResumeForm>(key: K, template: ResumeForm[K] extends Array<infer T> ? T : never): void {
  ;(form[key] as unknown[]).push(template)
}

function removeRow<K extends keyof ResumeForm>(key: K, index: number): void {
  ;(form[key] as unknown[]).splice(index, 1)
}

const EMPTY_EDU: ResumeForm['education'][number] = {
  school: '', degree: '', major: '', startDate: '', endDate: '', gpa: '', rank: '', coursesText: ''
}
const EMPTY_PROJECT: ResumeForm['projects'][number] = {
  id: '', name: '', startDate: '', endDate: '', description: '', highlightsText: '', techStackText: ''
}
const EMPTY_EXP: ResumeForm['experience'][number] = {
  company: '', title: '', startDate: '', endDate: '', highlightsText: '', techStackText: ''
}
const EMPTY_RESEARCH: ResumeForm['research'][number] = {
  title: '', startDate: '', endDate: '', description: '', achievement: ''
}

function fmtDate(iso: string | undefined): string {
  return iso === undefined ? '' : iso.slice(0, 10)
}

function onRowKeydown(e: KeyboardEvent, resume: StoredResume): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openEditor(resume)
  }
}

onMounted(() => {
  void load()
  void loadContentTasks()
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onWindowBlur)
  document.addEventListener('wheel', onDocWheel, { passive: false })
  // 点击任意处关闭列表行导出菜单（菜单内点击已 @click.stop）
  document.addEventListener('click', closeExportMenu)
  // #75：导入异步流程事件订阅（onUnmounted 注销）
  const offImportEvents = subscribeImportEvents()
  onUnmounted(() => offImportEvents())
  // #90/T02：内容优化任务变更实时推送（阶段流转/进度/失败/取消）
  const offContentTasks = window.api.on(IpcEvent.ContentOptimizeChanged, () => {
    void loadContentTasks()
  })
  onUnmounted(() => offContentTasks())
})
</script>

<template>
  <section class="view cols">
    <!-- ===== 列表列 ===== -->
    <div class="col">
      <div class="col-head">
        <div>
          <div class="col-title">简历</div>
          <div class="col-count">基准 {{ bases.length }} · 优化稿 {{ derived.length }}</div>
        </div>
        <div class="head-actions">
          <button class="btn" type="button" @click="pickImportFile" title="导入已有 DOCX/PDF 简历">
            <Icon name="upload" />上传解析
          </button>
          <input ref="importFileInput" type="file" accept=".docx,.pdf" hidden @change="onImportFilePicked" />
          <button class="btn primary" type="button" @click="openEditor()">
            <Icon name="plus" />新建
          </button>
        </div>
      </div>

      <p v-if="errorMessage" class="empty">{{ errorMessage }}</p>
      <p v-if="loading" class="empty">加载中…</p>

      <div class="rgroup-title"><span>基准简历</span><span>{{ bases.length }} 份</span></div>
      <div v-if="bases.length === 0 && !loading" class="empty">
        暂无基准简历——点「新建」创建。
      </div>
      <div
        v-for="r in bases"
        :key="r.meta.id"
        class="res-row"
        tabindex="0"
        role="button"
        @click="openEditor(r)"
        @keydown="onRowKeydown($event, r)"
      >
        <template v-if="renameTarget === r">
          <input
            v-model="renameTitle"
            class="rename-input"
            autofocus
            @click.stop
            @keydown.stop="onRenameKeydown"
            @blur="commitRename"
            @focus="onRenameFocus"
          />
        </template>
        <template v-else>
          <div class="res-name" title="双击改名" @click.stop @dblclick.stop="startRename(r)">{{ r.meta.title ?? '未命名简历' }}</div>
        </template>
        <div class="res-meta">更新于 {{ fmtDate(r.meta.updatedAt) }} · 基准</div>
        <div class="res-actions">
          <button class="icon-btn" type="button" title="编辑" @click.stop="openEditor(r)"><Icon name="edit" /></button>
          <button class="icon-btn" type="button" title="A4 预览" @click.stop="openPreview(r)"><Icon name="file" /></button>
          <button class="btn ghost" type="button" title="内容优化（无 JD 通用质量优化）" @click.stop="startContentOptimize(r)">内容优化</button>
          <div class="export-menu-wrap">
            <button class="icon-btn" type="button" title="导出" @click.stop="exportMenuTarget = exportMenuTarget === (r.meta.id as string) ? null : (r.meta.id as string)"><Icon name="download" /></button>
            <div v-if="exportMenuTarget === (r.meta.id as string)" class="export-menu" @click.stop>
              <button type="button" @click="exportFromRow(r, 'pdf')">导出 PDF</button>
              <button type="button" @click="exportFromRow(r, 'docx')">导出 DOCX</button>
            </div>
          </div>
          <button class="icon-btn" type="button" title="删除" @click.stop="deleteTarget = r"><Icon name="trash" /></button>
        </div>
      </div>

      <!-- 内容优化任务卡片（#90/T02）：阶段流转 / 进度 / 失败重试 / 取消续接 -->
      <div class="rgroup-title"><span>内容优化任务</span><span>{{ contentTasks.length }} 项</span></div>
      <p v-if="contentTaskError" class="empty" style="color:#dc2626">{{ contentTaskError }}</p>
      <div v-if="contentTasks.length === 0 && !loading" class="empty">
        暂无内容优化任务——在基准简历行点击「内容优化」触发（无 JD 通用质量优化）。
      </div>
      <div
        v-for="t in contentTasks"
        :key="t.id"
        class="opt-task-card"
        :class="{ failed: t.status === 'failed', ready: t.status === 'ready_for_review' }"
      >
        <div class="opt-task-head">
          <span class="opt-task-title">内容优化 · {{ contentResumeTitle(t) }}</span>
          <Pill :tone="t.status === 'failed' || t.status === 'cancelled' ? 'ghost' : 'tint'">
            {{ CONTENT_STATUS_LABELS[t.status] }}
          </Pill>
        </div>
        <div class="opt-task-progress">{{ t.progress }}</div>
        <p v-if="t.error" class="opt-task-error">{{ t.error }}</p>
        <!-- #93/T03 规则判定与项目判定展示（证据/问题/建议；R2 全局维度作用对象=global） -->
        <div
          v-if="t.diagnosis && (t.diagnosis.rules.length > 0 || t.diagnosis.projects.length > 0)"
          class="opt-diagnosis"
        >
          <template v-if="t.diagnosis.projects.length > 0">
            <div class="opt-diag-heading">项目判定</div>
            <div class="opt-diag-projects">
              <div v-for="p in t.diagnosis.projects" :key="p.projectId" class="opt-diag-project">
                <span class="opt-diag-project-name" :title="p.projectId">{{ projectDisplayName(t, p.projectId) }}</span>
                <Pill tone="ghost">{{ PROJECT_VERDICT_LABELS[p.verdict] }}</Pill>
              </div>
            </div>
          </template>
          <template v-if="t.diagnosis.rules.length > 0">
            <div class="opt-diag-heading">规则判定</div>
            <div class="opt-diag-rules">
              <div v-for="(r, i) in t.diagnosis.rules" :key="`${r.ruleId}:${r.target}:${i}`" class="opt-diag-rule">
                <div class="opt-diag-rule-head">
                  <span class="opt-diag-rule-id">{{ r.ruleId }}</span>
                  <span class="opt-diag-rule-name">{{ ruleName(r.ruleId) }}</span>
                  <span class="opt-diag-rule-status" :class="`st-${r.status}`">{{ RULE_STATUS_LABELS[r.status] }}</span>
                </div>
                <p v-if="r.target" class="opt-diag-line">作用对象：{{ r.target }}</p>
                <p v-if="r.evidence" class="opt-diag-line">原文证据：{{ r.evidence }}</p>
                <p v-if="r.issue" class="opt-diag-line">问题：{{ r.issue }}</p>
                <p v-if="r.suggestion" class="opt-diag-line">建议：{{ r.suggestion }}</p>
                <p class="opt-diag-line">事实来源：{{ FACT_SOURCE_LABELS[r.factSource] }}</p>
              </div>
            </div>
          </template>
        </div>
        <!-- #94/T04 追问批量回答表单（awaiting_answers：分组/证据/候选/四选一/自由输入/跳过） -->
        <div
          v-if="t.status === 'awaiting_answers' && t.diagnosis && t.diagnosis.questions.length > 0"
          class="opt-answers"
        >
          <div class="opt-answers-head">
            <span class="opt-diag-heading">追问回答</span>
            <span class="opt-answers-count">
              已答 {{ answersCountFor(t).answered }}/{{ answersCountFor(t).total }} 项 · 未答
              {{ answersCountFor(t).unanswered }} 项
            </span>
          </div>
          <div v-for="group in answerGroups(t)" :key="group.projectId" class="opt-answers-group">
            <div class="opt-answers-group-title">
              项目：{{ group.projectId === '' ? '（未关联项目）' : projectDisplayName(t, group.projectId) }}
            </div>
            <div v-for="item in group.questions" :key="item.key" class="opt-ans-question">
              <div class="opt-ans-q-head">
                <span class="opt-diag-rule-id">{{ item.question.field }}</span>
                <span class="opt-ans-q-text">{{ item.question.question }}</span>
              </div>
              <p v-if="item.question.evidence" class="opt-diag-line">原文证据：{{ item.question.evidence }}</p>
              <div v-if="item.question.candidates.length > 0" class="opt-ans-candidates">
                <label v-for="(c, ci) in item.question.candidates" :key="ci" class="opt-ans-candidate">
                  <input
                    type="radio"
                    :name="`ans-${t.id}-${item.key}`"
                    :checked="draftsFor(t)[item.key].action === 'confirm' && draftsFor(t)[item.key].candidateIndex === ci"
                    @change="onCandidatePick(t, item.question, item.key, ci)"
                  />
                  <span>{{ c }}</span>
                </label>
              </div>
              <textarea
                class="opt-ans-input"
                :value="draftsFor(t)[item.key].text"
                :placeholder="item.question.candidates.length > 0 ? '编辑候选或自由输入…' : '自由输入…'"
                @input="onAnswerInput(t, item.key, $event)"
              ></textarea>
              <div class="opt-ans-actions">
                <button type="button" @click="onAnswerAction(t, item.question, item.key, 'confirm')">{{ ANSWER_ACTION_LABELS.confirm }}</button>
                <button type="button" @click="onAnswerAction(t, item.question, item.key, 'edit')">{{ ANSWER_ACTION_LABELS.edit }}</button>
                <button type="button" @click="onAnswerAction(t, item.question, item.key, 'deny')">{{ ANSWER_ACTION_LABELS.deny }}</button>
                <button type="button" @click="onAnswerAction(t, item.question, item.key, 'cannot')">{{ ANSWER_ACTION_LABELS.cannot }}</button>
              </div>
            </div>
          </div>
          <div class="opt-answers-submit">
            <button class="btn primary" type="button" @click="submitContentAnswers(t)">
              生成优化稿{{ answersCountFor(t).unanswered > 0 ? `（未答 ${answersCountFor(t).unanswered} 项）` : '' }}
            </button>
          </div>
        </div>
        <div v-if="t.status === 'ready_for_review' && t.noChanges" class="opt-task-note">
          无需修改——确认后不创建新版本。
        </div>
        <div v-if="t.status === 'confirmed'" class="opt-task-note">已完成。</div>
        <div class="opt-task-actions">
          <template v-if="t.status === 'diagnosing' || t.status === 'created' || t.status === 'rewriting'">
            <button class="btn" type="button" @click="cancelContentTask(t)">取消</button>
          </template>
          <template v-else-if="t.status === 'awaiting_answers'">
            <button class="btn" type="button" @click="cancelContentTask(t)">取消</button>
          </template>
          <template v-else-if="t.status === 'failed'">
            <button class="btn" type="button" @click="retryContentTask(t)">重试</button>
          </template>
          <template v-else-if="t.status === 'cancelled'">
            <button class="btn" type="button" @click="resumeContentTask(t)">续接</button>
            <button class="btn" type="button" @click="voidContentTask(t)">作废</button>
          </template>
          <template v-else-if="t.status === 'ready_for_review'">
            <button class="btn primary" type="button" @click="confirmContentTask(t)">确认{{ t.noChanges ? '（无需修改）' : '' }}</button>
          </template>
        </div>
      </div>

      <div class="rgroup-title"><span>优化简历（派生稿）</span><span>{{ derived.length }} 份</span></div>
      <div v-if="derived.length === 0 && !loading" class="empty">
        由「优化简历」流程产出（职位详情内触发），此处展示与编辑。
      </div>
      <div
        v-for="r in derived"
        :key="r.meta.id"
        class="res-row"
        tabindex="0"
        role="button"
        @click="openEditor(r)"
        @keydown="onRowKeydown($event, r)"
      >
        <template v-if="renameTarget === r">
          <input
            v-model="renameTitle"
            class="rename-input"
            autofocus
            @click.stop
            @keydown.stop="onRenameKeydown"
            @blur="commitRename"
            @focus="onRenameFocus"
          />
        </template>
        <template v-else>
          <div class="res-name" title="双击改名" @click.stop @dblclick.stop="startRename(r)">{{ r.meta.title ?? '未命名优化稿' }}</div>
        </template>
        <div class="res-meta">
          更新于 {{ fmtDate(r.meta.updatedAt) }} · 派生
          <template v-if="r.meta.targetJobId"> · 关联职位 {{ r.meta.targetJobId }}</template>
        </div>
        <div class="res-actions">
          <button class="icon-btn" type="button" title="编辑" @click.stop="openEditor(r)"><Icon name="edit" /></button>
          <button class="icon-btn" type="button" title="A4 预览" @click.stop="openPreview(r)"><Icon name="file" /></button>
          <div class="export-menu-wrap">
            <button class="icon-btn" type="button" title="导出" @click.stop="exportMenuTarget = exportMenuTarget === (r.meta.id as string) ? null : (r.meta.id as string)"><Icon name="download" /></button>
            <div v-if="exportMenuTarget === (r.meta.id as string)" class="export-menu" @click.stop>
              <button type="button" @click="exportFromRow(r, 'pdf')">导出 PDF</button>
              <button type="button" @click="exportFromRow(r, 'docx')">导出 DOCX</button>
            </div>
          </div>
          <button class="icon-btn" type="button" title="删除" @click.stop="deleteTarget = r"><Icon name="trash" /></button>
        </div>
      </div>
    </div>

    <Resizer mode="col" />

    <!-- ===== 工作区 ===== -->
    <div class="workspace">
      <p v-if="successMessage" class="ws-msg ok">{{ successMessage }}</p>
      <p v-if="errorMessage" class="ws-msg err">{{ errorMessage }}</p>

      <!-- 编辑器 -->
      <template v-if="editingId !== null">
        <!-- 置顶栏（始终可见）：可编辑的简历名 + 全部操作 -->
        <div class="editor-bar">
          <div class="editor-bar-title">
            <input
              v-model="form.meta.title"
              class="editor-title-input"
              :placeholder="editingExisting ? '未命名' : defaultBaseTitle(form.basics.name) || '新建基准简历'"
              title="修改简历名称（自动保存）"
              @blur="scheduleAutosave"
            />
            <div class="ws-sub">
              <Pill v-if="importDraft !== null" tone="solid">导入草稿（确认后创建基准简历）</Pill>
              <Pill v-else-if="editingExisting" tone="tint">派生稿</Pill>
              <Pill v-else>基准</Pill>
              <span style="margin-left: 6px">分节表单 ⇄ JSON 模式</span>
            </div>
          </div>
          <div class="head-actions">
            <button class="btn primary" type="button" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : importDraft !== null ? '确认并创建基准简历' : '保存' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="previewCurrent">生成 A4 预览</button>
            <button class="btn" type="button" :disabled="saving" @click="jsonMode ? switchToForm() : switchToJson()">
              {{ jsonMode ? '⇄ 表单模式' : '⇄ JSON 模式' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="closeEditor">返回列表</button>
          </div>
        </div>

        <div v-if="issues.length > 0" class="issues-box">
          <p class="issues-title">保存未通过校验（{{ issues.length }} 处）：</p>
          <ul class="issues-list">
            <li v-for="(issue, i) in issues" :key="i">
              <span class="issue-path">{{ issue.path }}</span>
              <span class="issue-detail">{{ issue.detail }}</span>
            </li>
          </ul>
        </div>

        <!-- 导入核对（#76）：提取全文 + 字段来源 + 待确认 + 未映射内容；无单一整体置信度 -->
        <div v-if="importDraft !== null" class="import-audit">
          <div class="audit-head">
            <span>导入核对 · {{ importDraft.fileName }}</span>
            <span class="hint">下方为本地解析结果，请逐项核对后在表单中补齐</span>
          </div>
          <p v-if="importDraft.agent.used" class="hint audit-agent-ok">已使用 Agent 自动结构化（字段标记「Agent 映射」）</p>
          <p v-else-if="importDraft.agent.failedReason !== undefined" class="hint audit-agent-warn">
            Agent 未使用：{{ AGENT_FAILED_LABEL[importDraft.agent.failedReason] ?? importDraft.agent.failedReason }}（已用本地草稿，可人工补齐）
          </p>
          <div class="audit-grid">
            <div class="audit-col">
              <h4>提取全文</h4>
              <pre class="audit-text">{{ importDraft.draft.text }}</pre>
            </div>
            <div class="audit-col">
              <h4>Agent 结构化结果</h4>
              <pre class="audit-json">{{ formatResume(importDraft.resume) }}</pre>
              <h4>字段来源</h4>
              <table class="audit-table">
                <tr v-for="(status, key) in importDraft.draft.fieldStatus" :key="key">
                  <td class="audit-key">{{ FIELD_LABEL[key] ?? key }}</td>
                  <td><span class="pill ghost">{{ FIELD_STATUS_LABEL[status] ?? status }}</span></td>
                  <td class="audit-value">{{ fieldPreview(key) }}</td>
                </tr>
              </table>
              <template v-if="importDraft.draft.missingFields.length > 0">
                <h4>待确认</h4>
                <p class="hint">
                  以下必填项未解析到，请在表单中补齐后才能保存：
                  {{ importDraft.draft.missingFields.map((m) => FIELD_LABEL[m] ?? m).join('、') }}
                </p>
              </template>
              <template v-if="(importDraft.draft.pageRisks ?? []).length > 0">
                <h4>逐页解析（#82 路由）</h4>
                <ul class="audit-unmapped">
                  <li v-for="(r, i) in importDraft.draft.pageRisks ?? []" :key="i">
                    第 {{ r.pageNo }} 页：{{ r.source === 'ocr' ? 'OCR' : '文本提取' }}<template v-if="r.risk !== undefined"> · {{ PAGE_RISK_LABEL[r.risk] ?? r.risk }}</template>
                  </li>
                </ul>
              </template>
              <template v-if="importDraft.draft.unmappedText.length > 0">
                <h4>未映射内容</h4>
                <ul class="audit-unmapped">
                  <li v-for="(line, i) in importDraft.draft.unmappedText" :key="i">{{ line }}</li>
                </ul>
                <p class="hint">
                  Schema 无法表示的原文（证书/语言成绩/校园经历等）：可并入「竞赛荣誉 / 能力 / 自我评价」或舍弃，不会自动写入错误字段。
                </p>
              </template>
            </div>
          </div>
        </div>

        <div v-if="jsonMode" class="editor-sec" @focusout="scheduleAutosave">
          <h3>JSON 模式</h3>
          <p class="hint">直接编辑 resume.schema.json 结构；切换到表单模式或保存时解析校验。</p>
          <p v-if="jsonError" class="ws-msg err">{{ jsonError }}</p>
          <textarea v-model="jsonText" class="json-textarea" rows="28" spellcheck="false" />
        </div>

        <form v-else @submit.prevent="save" @focusout="scheduleAutosave">
          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('basics')" @keydown.enter.prevent="toggleFold('basics')">
              <span class="fold-caret" :class="{ open: !fold.basics }">▸</span>
              <h3>基本信息 <em class="soe">国企字段：政治面貌 / 生源地</em></h3>
              <span v-if="fold.basics && foldBadge('basics') !== ''" class="fold-badge">{{ foldBadge('basics') }}</span>
            </div>
            <div v-show="!fold.basics">
              <div class="form-grid">
              <label class="field span2"><span class="label">简历名称</span><input v-model="form.meta.title" :placeholder="defaultBaseTitle(form.basics.name) || '如：技术向基准简历'" /></label>
              <label class="field"><span class="label">姓名 <em class="required">*</em></span><input v-model="form.basics.name" /></label>
              <div class="field">
                <span class="label">照片</span>
                <div class="photo-field">
                  <img v-if="photoPreviewUrl" :src="photoPreviewUrl" class="photo-thumb" alt="照片预览" />
                  <span v-if="form.basics.photo !== ''" class="photo-ok">已上传</span>
                  <button class="btn ghost" type="button" @click="pickPhoto">上传照片</button>
                  <button v-if="form.basics.photo !== ''" class="btn ghost" type="button" @click="removePhoto">移除</button>
                </div>
                <input ref="photoInput" type="file" accept="image/jpeg,image/png,image/webp" hidden @change="onPhotoPicked" />
              </div>
              <label class="field">
                <span class="label">性别</span>
                <select v-model="form.basics.gender">
                  <option value="">未填</option>
                  <option value="男">男</option>
                  <option value="女">女</option>
                </select>
              </label>
              <label class="field"><span class="label">生日（YYYY-MM）</span><input v-model="form.basics.birthday" placeholder="2004-06" /></label>
              <label class="field"><span class="label">政治面貌</span><input v-model="form.basics.politicalStatus" placeholder="中共党员 / 共青团员 / 群众" /></label>
              <label class="field"><span class="label">生源地</span><input v-model="form.basics.hometown" placeholder="如：四川绵阳" /></label>
              <label class="field"><span class="label">电话</span><input v-model="form.basics.phone" placeholder="138-0000-1234" /></label>
              <label class="field"><span class="label">邮箱</span><input v-model="form.basics.email" placeholder="name@example.com" /></label>
              <label class="field"><span class="label">现居城市</span><input v-model="form.basics.location" /></label>
            </div>
            <h4 class="sub-title">求职意向</h4>
            <div class="form-grid">
              <label class="field"><span class="label">意向岗位</span><input v-model="form.basics.jobIntention.position" placeholder="如：后端开发工程师（校招）" /></label>
              <label class="field"><span class="label">期望城市（每行一个）</span><textarea v-model="form.basics.jobIntention.cityText" rows="2" placeholder="北京&#10;杭州" /></label>
              <label class="field"><span class="label">期望薪资</span><input v-model="form.basics.jobIntention.salary" placeholder="面议" /></label>
            </div>
            <h4 class="sub-title">链接（GitHub / 博客 / 作品）</h4>
            <div v-for="(link, i) in form.basics.links" :key="i" class="link-row">
              <input v-model="link.label" placeholder="名称，如 GitHub" />
              <input v-model="link.url" placeholder="https://…" />
              <button class="btn ghost" type="button" @click="form.basics.links.splice(i, 1)">删除</button>
            </div>
            <button class="btn ghost" type="button" @click="form.basics.links.push({ label: '', url: '' })">+ 添加链接</button>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('education')" @keydown.enter.prevent="toggleFold('education')">
              <span class="fold-caret" :class="{ open: !fold.education }">▸</span>
              <h3>教育经历</h3>
              <span v-if="fold.education && foldBadge('education') !== ''" class="fold-badge">{{ foldBadge('education') }}</span>
              <button class="btn" type="button" @click.stop="addRowAndExpand('education', EMPTY_EDU)">+ 添加</button>
            </div>
            <div v-show="!fold.education">
              <div v-for="(e, i) in form.education" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn ghost" type="button" @click="removeRow('education', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field"><span class="label">学校 <em class="required">*</em></span><input v-model="e.school" /></label>
                <label class="field"><span class="label">学历 <em class="required">*</em></span><input v-model="e.degree" placeholder="本科 / 硕士 / 博士" /></label>
                <label class="field"><span class="label">专业 <em class="required">*</em></span><input v-model="e.major" /></label>
                <label class="field"><span class="label">开始时间（YYYY-MM）</span><input v-model="e.startDate" placeholder="2022-09" /></label>
                <label class="field"><span class="label">结束时间（应届可留空）</span><input v-model="e.endDate" placeholder="2026-06" /></label>
                <label class="field"><span class="label">绩点（如 3.7/4.0）</span><input v-model="e.gpa" /></label>
                <label class="field"><span class="label">排名 <em class="soe">国企看重</em></span><input v-model="e.rank" placeholder="前 10%" /></label>
                <label class="field"><span class="label">相关课程（每行一个）</span><textarea v-model="e.coursesText" rows="2" /></label>
              </div>
            </div>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('honors')" @keydown.enter.prevent="toggleFold('honors')">
              <span class="fold-caret" :class="{ open: !fold.honors }">▸</span>
              <h3>竞赛和荣誉</h3>
              <span v-if="fold.honors && foldBadge('honors') !== ''" class="fold-badge">{{ foldBadge('honors') }}</span>
            </div>
            <div v-show="!fold.honors">
              <div class="form-grid">
                <label class="field span2"><span class="label">荣誉/奖项（每行一个，A4 单行·连接）</span><textarea v-model="form.honorsText" rows="3" placeholder="国家奖学金（2025）&#10;蓝桥杯省一等奖" /></label>
              </div>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('skills')" @keydown.enter.prevent="toggleFold('skills')">
              <span class="fold-caret" :class="{ open: !fold.skills }">▸</span>
              <h3>技能</h3>
              <span v-if="fold.skills && foldBadge('skills') !== ''" class="fold-badge">{{ foldBadge('skills') }}</span>
            </div>
            <div v-show="!fold.skills">
              <div class="form-grid">
                <label v-for="c in SKILL_CATEGORIES" :key="c" class="field span2">
                  <span class="label">{{ c }}</span>
                  <textarea v-model="form.skills[c]" rows="2" placeholder="一段话描述……（空分类不会出现在简历中）" />
                </label>
              </div>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('projects')" @keydown.enter.prevent="toggleFold('projects')">
              <span class="fold-caret" :class="{ open: !fold.projects }">▸</span>
              <h3>项目经历</h3>
              <span v-if="fold.projects && foldBadge('projects') !== ''" class="fold-badge">{{ foldBadge('projects') }}</span>
              <button class="btn" type="button" @click.stop="addRowAndExpand('projects', EMPTY_PROJECT)">+ 添加</button>
            </div>
            <div v-show="!fold.projects">
              <div v-for="(p, i) in form.projects" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn ghost" type="button" @click="removeRow('projects', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field"><span class="label">项目名</span><input v-model="p.name" /></label>
                <label class="field"><span class="label">开始时间（YYYY-MM）</span><input v-model="p.startDate" placeholder="2025-03" /></label>
                <label class="field"><span class="label">结束时间</span><input v-model="p.endDate" placeholder="2025-08" /></label>
                <label class="field span2"><span class="label">描述（每行一条）</span><textarea v-model="p.description" rows="3" placeholder="做了什么、结果如何——每行一条，多条自动分条显示" /></label>
                <label class="field span2"><span class="label">要点（每行一条，最多 4 条）</span><textarea v-model="p.highlightsText" rows="3" placeholder="结构化要点，最多 4 条——每条独立一行；技术栈另填不计条数" /></label>
                <label class="field span2"><span class="label">技术栈（每行一个）</span><textarea v-model="p.techStackText" rows="2" /></label>
              </div>
            </div>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('experience')" @keydown.enter.prevent="toggleFold('experience')">
              <span class="fold-caret" :class="{ open: !fold.experience }">▸</span>
              <h3>实习经历</h3>
              <span v-if="fold.experience && foldBadge('experience') !== ''" class="fold-badge">{{ foldBadge('experience') }}</span>
              <button class="btn" type="button" @click.stop="addRowAndExpand('experience', EMPTY_EXP)">+ 添加</button>
            </div>
            <div v-show="!fold.experience">
              <div v-for="(x, i) in form.experience" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn ghost" type="button" @click="removeRow('experience', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field"><span class="label">公司</span><input v-model="x.company" /></label>
                <label class="field"><span class="label">岗位</span><input v-model="x.title" /></label>
                <label class="field"><span class="label">开始时间</span><input v-model="x.startDate" placeholder="2026-01" /></label>
                <label class="field"><span class="label">结束时间</span><input v-model="x.endDate" placeholder="2026-06" /></label>
                <label class="field"><span class="label">要点（每行一个）</span><textarea v-model="x.highlightsText" rows="3" /></label>
                <label class="field"><span class="label">技术栈（每行一个）</span><textarea v-model="x.techStackText" rows="3" /></label>
              </div>
            </div>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('research')" @keydown.enter.prevent="toggleFold('research')">
              <span class="fold-caret" :class="{ open: !fold.research }">▸</span>
              <h3>科研经历</h3>
              <span v-if="fold.research && foldBadge('research') !== ''" class="fold-badge">{{ foldBadge('research') }}</span>
              <button class="btn" type="button" @click.stop="addRowAndExpand('research', EMPTY_RESEARCH)">+ 添加</button>
            </div>
            <div v-show="!fold.research">
              <div v-for="(r, i) in form.research" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn ghost" type="button" @click="removeRow('research', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field span2"><span class="label">标题（研究课题名）</span><input v-model="r.title" placeholder="如：基于 Transformer 的命名实体识别研究" /></label>
                <label class="field"><span class="label">开始时间（选填）</span><input v-model="r.startDate" placeholder="2025-03" /></label>
                <label class="field"><span class="label">结束时间（选填）</span><input v-model="r.endDate" placeholder="2025-09" /></label>
                <label class="field span2"><span class="label">研究内容（每行一条）</span><textarea v-model="r.description" rows="3" placeholder="研究什么、怎么做的——每行一条，多条自动分条显示" /></label>
                <label class="field span2"><span class="label">成果（单条）</span><input v-model="r.achievement" placeholder="如：以第一作者发表 EI 论文一篇" /></label>
              </div>
            </div>
            </div>
          </div>

          <div class="editor-sec">
            <div class="fold-head" role="button" tabindex="0" @click="toggleFold('selfAssessment')" @keydown.enter.prevent="toggleFold('selfAssessment')">
              <span class="fold-caret" :class="{ open: !fold.selfAssessment }">▸</span>
              <h3>自我评价</h3>
              <span v-if="fold.selfAssessment && foldBadge('selfAssessment') !== ''" class="fold-badge">{{ foldBadge('selfAssessment') }}</span>
            </div>
            <div v-show="!fold.selfAssessment">
              <textarea v-model="form.selfAssessment" rows="3" placeholder="可留空（优化稿可生成）" />
            </div>
          </div>
        </form>
      </template>

      <!-- 空工作区 -->
      <template v-else>
        <div class="ws-empty">
          <p class="hint">从左侧选择一份简历开始编辑，或新建基准简历。</p>
          <div class="ws-actions">
            <button class="btn primary" type="button" @click="openEditor()">新建基准简历</button>
          </div>
        </div>
      </template>
    </div>
  </section>

  <!-- ===== 弹窗：删除确认 ===== -->
  <Modal :open="deleteTarget !== null" title="删除简历" @close="deleteTarget = null">
    <p class="hint">
      确认删除「{{ deleteTarget?.meta.title ?? '未命名简历' }}」？删除后不可恢复。
      <template v-if="deleteTarget?.meta.baseResumeId != null">（派生稿为独立副本，不影响基准简历）</template>
    </p>
    <template #foot>
      <button class="btn" type="button" @click="deleteTarget = null">取消</button>
      <button class="btn primary" type="button" @click="confirmDelete">确认删除</button>
    </template>
  </Modal>

  <!-- ===== 弹窗：A4 预览 + 导出 PDF ===== -->
  <Modal :open="previewHtml !== ''" :title="`A4 预览 · ${previewTitle}`" width="960px" @close="previewHtml = ''">
    <template #head-actions>
      <span class="zoom-hint">Ctrl + 滚轮缩放</span>
      <button class="btn" type="button" @click="previewZoom = fitPreviewZoom()">适配</button>
      <button class="btn" type="button" @click="zoomPreviewBy(-0.1)">−</button>
      <button class="btn" type="button" @click="previewZoom = 1">100%</button>
      <button class="btn" type="button" @click="zoomPreviewBy(0.1)">＋</button>
      <button class="btn" type="button" :disabled="exporting" @click="exportResume('pdf')">
        {{ exporting ? '导出中…' : '导出 PDF' }}
      </button>
      <button class="btn" type="button" :disabled="exporting" @click="exportResume('docx')">
        {{ exporting ? '导出中…' : '导出 DOCX' }}
      </button>
    </template>
    <p v-if="exportMessage" class="hint" :style="{ color: exportMessage.startsWith('已导出') ? '#059669' : '#dc2626' }">
      {{ exportMessage }}
    </p>
    <p v-if="previewError" class="hint" style="color: #dc2626">{{ previewError }}</p>
    <div class="a4-body">
      <!-- transform 缩放（不改 iframe 内部视口，内层永不产生滚动条）；外层容器用缩放后尺寸占位。
           iframe 宽 834 = body padding(20+20) + sheet 794：内容精确适配，无水平溢出 → 无任何内层滚动条 -->
      <div
        class="a4-zoom"
        :style="{ width: `${Math.round(834 * previewZoom)}px`, height: `${Math.round(a4ContentHeight * previewZoom)}px` }"
      >
        <iframe
          ref="a4FrameRef"
          class="a4-frame"
          :style="{ height: `${a4ContentHeight}px`, transform: `scale(${previewZoom})` }"
          :srcdoc="previewHtml"
          title="A4 预览"
          @load="fitFrameHeight"
        />
      </div>
    </div>
  </Modal>

  <!-- ===== 弹窗：简历导入（#75 DOCX）——阶段进度 / Agent 决策 / 错误与替代入口 ===== -->
  <Modal :open="importState !== null" title="导入简历" @close="importCancelConfirm = true">
    <!-- Agent 隐私告知（#77 首次使用） -->
    <template v-if="importState?.pendingKind === 'consent'">
      <p class="hint">
        为使解析结果更完整，简历文本将发送给您已配置的模型用于结构化整理。发送内容仅限文本（不含照片/文件本体），
        不会用于其他用途。可在「设置 → Agent 导入增强」中随时关闭。
      </p>
    </template>
    <!-- Agent 等待超时（#77：继续等待 / 本地草稿 / 取消） -->
    <template v-else-if="importState?.pendingKind === 'timeout'">
      <p class="hint">Agent 结构化已等待超过 30 秒，请选择：</p>
    </template>
    <!-- 错误与替代入口 -->
    <template v-else-if="importState !== null && importState.error !== null">
      <p class="hint" style="color: #dc2626">{{ importState.error }}</p>
    </template>
    <!-- 进度阶段 -->
    <template v-else-if="importState !== null">
      <p class="hint">
        {{ IMPORT_PHASE_LABEL[importState.phase] ?? importState.phase }}{{ importState.detail !== null ? ' ' + importState.detail : '' }}…（解析期间可继续使用其他功能）
      </p>
    </template>
    <template #foot>
      <template v-if="importState?.pendingKind === 'consent'">
        <button class="btn" type="button" @click="decideAgent('consent', 'decline')">不使用 Agent</button>
        <button class="btn primary" type="button" @click="decideAgent('consent', 'agree')">同意并继续</button>
      </template>
      <template v-else-if="importState?.pendingKind === 'timeout'">
        <button class="btn" type="button" @click="importCancelConfirm = true">取消导入</button>
        <button class="btn" type="button" @click="decideAgent('timeout', 'local')">使用本地草稿</button>
        <button class="btn primary" type="button" @click="decideAgent('timeout', 'continue')">继续等待</button>
      </template>
      <template v-else-if="importState?.error !== null">
        <button class="btn" type="button" @click="closeImportError">关闭</button>
        <button class="btn" type="button" @click="pickImportFile">重试 / 换文件</button>
        <button class="btn primary" type="button" @click="closeImportError; openEditor()">手动新建</button>
      </template>
      <template v-else>
        <button class="btn" type="button" :disabled="importState?.token === ''" @click="importCancelConfirm = true">取消</button>
      </template>
    </template>
  </Modal>

  <!-- ===== 弹窗：离开导入流程前的取消确认（#75：避免误以为后台继续） ===== -->
  <Modal :open="importCancelConfirm" title="取消导入" @close="importCancelConfirm = false">
    <p class="hint">导入尚未完成，取消后本次解析结果将被丢弃，不会创建任何简历。确认取消？</p>
    <template #foot>
      <button class="btn" type="button" @click="importCancelConfirm = false">继续等待</button>
      <button class="btn primary" type="button" @click="cancelImport">确认取消</button>
    </template>
  </Modal>
</template>

<style scoped>
.workspace {
  overflow-y: auto;
  /* 顶部不留 padding：置顶栏吸顶时与工作区顶边严丝合缝（裂缝修复） */
  padding: 0 24px 20px;
  background: var(--bg);
  min-width: 0;
}

.editor-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 0 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}

.editor-title-input {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 6px;
  width: min(420px, 100%);
  background: transparent;
  outline: none;
}

.editor-title-input:hover {
  border-color: var(--border);
  background: var(--surface);
}

.editor-title-input:focus {
  border-color: #2b5ca8;
  background: var(--surface);
}

.ws-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.ws-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ws-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}

.ws-msg {
  font-size: 12px;
  margin-top: 12px;
  margin-bottom: 10px;
}

.ws-msg.ok {
  color: #059669;
}

.ws-msg.err {
  color: #dc2626;
}

.ws-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.ws-empty {
  padding: 40px 0;
}

.hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.required {
  color: #dc2626;
  font-style: normal;
}

.soe {
  color: #b45309;
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
}

/* 简历行（原型 res-row） */
.rgroup-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 14px 0 6px;
  display: flex;
  justify-content: space-between;
}

.rgroup-title:first-of-type {
  margin-top: 0;
}

.res-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  margin-bottom: 8px;
  background: var(--bg);
}

.res-row:hover {
  border-color: var(--muted);
}

.res-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.res-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rename-input {
  width: 100%;
  font-size: 13px;
  padding: 4px 6px;
  border: 1px solid #2b5ca8;
  border-radius: 4px;
  outline: none;
}

.photo-field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.photo-thumb {
  width: 76px;
  height: 100px;
  object-fit: cover;
  border: 1px solid #d8d8d8;
  border-radius: 4px;
}

.photo-ok {
  color: #059669;
  font-size: 12px;
  font-weight: 600;
}

.res-meta {
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 3px;
  line-height: 1.6;
}

.res-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}

.res-actions .icon-btn {
  width: 24px;
  height: 24px;
}

.res-actions .icon-btn .ic {
  width: 13px;
  height: 13px;
}

/* 列表行导出菜单（#74：PDF/DOCX 轻量选择） */
.export-menu-wrap {
  position: relative;
}

.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  min-width: 108px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 20px color-mix(in srgb, #000 14%, transparent);
}

.export-menu button {
  border: none;
  background: transparent;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12.5px;
  color: var(--fg);
  cursor: pointer;
}

.export-menu button:hover {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
}

/* 编辑器 */
.editor-sec {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-top: 12px;
}

.editor-sec h3 {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

/* 分节折叠头：整行可点切换收起/展开 */
.fold-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
  margin-bottom: 10px;
}

.fold-head:hover .fold-caret {
  color: var(--fg);
}

.fold-caret {
  font-size: 11px;
  color: #999;
  transition: transform 0.15s;
  flex-shrink: 0;
}

.fold-caret.open {
  transform: rotate(90deg);
}

.fold-badge {
  font-size: 11.5px;
  color: #047857;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 999px;
  padding: 0 8px;
  line-height: 1.7;
}

.fold-head .btn {
  margin-left: auto;
}

.sub-title {
  margin: 14px 0 8px;
  font-size: 12.5px;
  color: var(--fg);
  font-weight: 600;
}

.entry {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 10px;
}

.entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.entry-label {
  font-size: 11.5px;
  color: var(--muted);
}

.link-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.link-row input {
  flex: 1;
}

.issues-box {
  margin: 12px 0;
  padding: 10px 14px;
  background: color-mix(in srgb, #dc2626 6%, #ffffff);
  border: 1px solid color-mix(in srgb, #dc2626 28%, #dbdbdb);
  border-radius: var(--radius);
}

.issues-title {
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: #991b1b;
}

.issues-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: #991b1b;
}

.issue-path {
  font-weight: 600;
}

.issue-detail {
  margin-left: 8px;
}

/* 导入核对面板（#76）：提取全文 / 字段来源 / 待确认 / 未映射内容 */
.import-audit {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-top: 12px;
  background: color-mix(in srgb, var(--accent) 4%, var(--bg));
}

.audit-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}

.audit-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}

.audit-col h4 {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 6px;
}

.audit-col h4:not(:first-child) {
  margin-top: 12px;
}

.audit-text {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

.audit-json {
  max-height: 420px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.audit-table td {
  padding: 3px 8px 3px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.audit-key {
  color: var(--muted);
  white-space: nowrap;
}

.audit-value {
  color: var(--fg);
  word-break: break-all;
}

.audit-unmapped {
  margin: 0 0 6px;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.8;
}

.audit-agent-ok {
  color: #047857;
  margin: 0 0 8px;
}

.audit-agent-warn {
  color: #b45309;
  margin: 0 0 8px;
}

.json-textarea {
  width: 100%;
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

/* 上传草稿 */
.warnings {
  margin: 0 0 12px;
  padding: 8px 12px 8px 28px;
  background: color-mix(in srgb, #d97706 10%, #ffffff);
  border: 1px solid color-mix(in srgb, #d97706 30%, #dbdbdb);
  border-radius: var(--radius);
  font-size: 12.5px;
  color: #92400e;
}

/* A4 预览弹窗：放大 + 缩放适配整页（zoom 包裹，iframe 固定 A4 尺寸）
 * 滚动只保留最外层 .modal-body 一个容器：.a4-body 不再滚动，iframe 内容恰好等于固定尺寸 */
.a4-body {
  background: var(--surface);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 14px;
}

.a4-zoom {
  line-height: 0;
  flex-shrink: 0;
  /* 裁剪未变换 iframe 的溢出：滚动范围 = 缩放后的真实占位尺寸 */
  overflow: hidden;
}

.a4-frame {
  /* 834 = body padding(20+20) + sheet 794：内容精确适配，无水平溢出 → 内层无滚动条 */
  width: 834px;
  height: 1123px;
  border: 1px solid var(--border);
  background: #ffffff;
  box-shadow: 0 4px 24px color-mix(in srgb, #000000 12%, transparent);
  transform-origin: top left;
}

.zoom-hint {
  font-size: 11.5px;
  color: var(--muted);
  margin-right: 4px;
}

/* 内容优化任务卡片（#90/T02） */
.opt-task-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--bg);
}

.opt-task-card.failed {
  border-color: #dc2626;
}

.opt-task-card.ready {
  border-color: #059669;
}

.opt-task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.opt-task-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.opt-task-progress {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}

.opt-task-error {
  font-size: 11.5px;
  color: #dc2626;
  margin: 4px 0 0;
}

.opt-task-note {
  font-size: 12px;
  color: #059669;
  margin-top: 4px;
}

/* #93/T03 规则判定与项目判定展示 */
.opt-diagnosis {
  margin-top: 8px;
  border-top: 1px dashed var(--border, rgba(128, 128, 128, 0.3));
  padding-top: 8px;
}
.opt-diag-heading {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 4px;
}
.opt-diag-projects {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 6px;
}
.opt-diag-project {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.opt-diag-project-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.opt-diag-rule {
  padding: 6px 8px;
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 6px;
  margin-bottom: 6px;
  background: rgba(128, 128, 128, 0.06);
}
.opt-diag-rule-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.opt-diag-rule-id {
  font-size: 11px;
  font-weight: 700;
  color: #2563eb;
  background: rgba(37, 99, 235, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
}

/* #94/T04 追问批量回答表单 */
.opt-answers {
  margin-top: 8px;
  border-top: 1px dashed var(--border, rgba(128, 128, 128, 0.3));
  padding-top: 8px;
}
.opt-answers-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.opt-answers-count {
  font-size: 11.5px;
  font-weight: 600;
  color: #b45309;
}
.opt-answers-group {
  margin-bottom: 8px;
}
.opt-answers-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 4px;
}
.opt-ans-question {
  padding: 6px 8px;
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 6px;
  margin-bottom: 6px;
  background: rgba(128, 128, 128, 0.06);
}
.opt-ans-q-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 2px;
}
.opt-ans-q-text {
  font-size: 12px;
  font-weight: 600;
}
.opt-ans-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 4px 0;
}
.opt-ans-candidate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.opt-ans-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  font-size: 12px;
  font-family: inherit;
  padding: 4px 6px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.4));
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  resize: vertical;
}
.opt-ans-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.opt-ans-actions button {
  font-size: 11.5px;
  padding: 2px 8px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.4));
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
}
.opt-ans-actions button:hover {
  background: rgba(128, 128, 128, 0.12);
}
.opt-answers-submit {
  margin-top: 6px;
  text-align: right;
}
.opt-diag-rule-name {
  font-size: 12px;
  font-weight: 500;
}
.opt-diag-rule-status {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
  padding: 1px 6px;
}
.opt-diag-rule-status.st-pass {
  color: #059669;
  background: rgba(5, 150, 105, 0.1);
}
.opt-diag-rule-status.st-improve {
  color: #d97706;
  background: rgba(217, 119, 6, 0.12);
}
.opt-diag-rule-status.st-insufficient {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.1);
}
.opt-diag-rule-status.st-na {
  color: var(--muted);
  background: rgba(128, 128, 128, 0.12);
}
.opt-diag-line {
  font-size: 11.5px;
  color: var(--muted);
  margin: 3px 0 0;
  word-break: break-word;
}

.opt-task-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
</style>
