<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Resume, StoredResume } from '@shared/types/resume'
import { defaultBaseTitle, emptyResumeForm, formToResume, issueSection, resumeToForm, SKILL_CATEGORIES, type ResumeForm } from '../resume-form'
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
const exporting = ref(false)
const exportMessage = ref('')
const previewError = ref('')

async function openPreview(resume: StoredResume): Promise<void> {
  previewError.value = ''
  exportMessage.value = ''
  previewId.value = resume.meta.id as string
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
  } catch (err) {
    previewError.value = String(err)
  }
}

async function exportPdf(): Promise<void> {
  exporting.value = true
  exportMessage.value = ''
  try {
    const path = await window.api.resumes.exportPdf(previewId.value)
    exportMessage.value = path === null ? '已取消导出' : `已导出：${path}`
  } catch (err) {
    exportMessage.value = `导出失败：${String(err)}`
  } finally {
    exporting.value = false
  }
}

/** 列表行「导出 PDF」：先渲染 A4 预览再导出（原型 pdf 图标按钮语义）。 */
async function exportPdfFromRow(resume: StoredResume): Promise<void> {
  await openPreview(resume)
  if (previewError.value === '') await exportPdf()
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
  // 自动保存兜底：返回列表前仍有未保存改动 → 先存
  if (formDirty && !saving.value) await save()
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
  if (!formDirty || saving.value) return
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

async function save(): Promise<void> {
  if (saving.value) return // 防并发：手动保存与自动保存互斥
  issues.value = []
  successMessage.value = ''
  let resume: Resume
  if (jsonMode.value) {
    try {
      resume = JSON.parse(jsonText.value) as Resume
    } catch (err) {
      jsonError.value = `JSON 解析失败：${String(err)}`
      return
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
    const stored =
      targetId !== null && targetId !== ''
        ? await window.api.resumes.update(targetId, resume)
        : await window.api.resumes.create(resume)
    if (closed) return // 已关闭：不回填表单、不重新打开编辑器
    successMessage.value = `已保存「${stored.meta.title ?? stored.meta.id}」`
    loadingForm = true
    Object.assign(form, resumeToForm(stored))
    loadingForm = false
    formDirty = false
    if (jsonMode.value) jsonText.value = JSON.stringify(stored, null, 2)
    editingId.value = stored.meta.id
    await load()
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
  name: '', startDate: '', endDate: '', description: '', techStackText: ''
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
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onWindowBlur)
  document.addEventListener('wheel', onDocWheel, { passive: false })
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
          <button class="btn" type="button" disabled title="后续版本支持（当前版本解析不可用）">
            <Icon name="upload" />上传解析
          </button>
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
          <button class="icon-btn" type="button" title="导出 PDF" @click.stop="exportPdfFromRow(r)"><Icon name="download" /></button>
          <button class="icon-btn" type="button" title="删除" @click.stop="deleteTarget = r"><Icon name="trash" /></button>
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
          <button class="icon-btn" type="button" title="导出 PDF" @click.stop="exportPdfFromRow(r)"><Icon name="download" /></button>
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
              <Pill v-if="editingExisting" tone="tint">派生稿</Pill>
              <Pill v-else>基准</Pill>
              <span style="margin-left: 6px">分节表单 ⇄ JSON 模式</span>
            </div>
          </div>
          <div class="head-actions">
            <button class="btn primary" type="button" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
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

        <div v-if="jsonMode" class="editor-sec" @focusout="scheduleAutosave">
          <h3>JSON 模式</h3>
          <p class="hint">直接编辑 resume.schema.json 结构；切换到表单模式或保存时解析校验。</p>
          <p v-if="jsonError" class="ws-msg err">{{ jsonError }}</p>
          <textarea v-model="jsonText" class="json-textarea" rows="28" spellcheck="false" />
        </div>

        <form v-else @submit.prevent="save" @focusout="scheduleAutosave">
          <div class="editor-sec">
            <h3>基本信息 <em class="soe">国企字段：政治面貌 / 生源地</em></h3>
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

          <div class="editor-sec">
            <h3>教育经历 <button class="btn" type="button" @click="addRow('education', EMPTY_EDU)">+ 添加</button></h3>
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

          <div class="editor-sec">
            <h3>竞赛和荣誉</h3>
            <div class="form-grid">
              <label class="field span2"><span class="label">荣誉/奖项（每行一个，A4 单行·连接）</span><textarea v-model="form.honorsText" rows="3" placeholder="国家奖学金（2025）&#10;蓝桥杯省一等奖" /></label>
            </div>
          </div>

          <div class="editor-sec">
            <h3>技能</h3>
            <div class="form-grid">
              <label v-for="c in SKILL_CATEGORIES" :key="c" class="field span2">
                <span class="label">{{ c }}</span>
                <textarea v-model="form.skills[c]" rows="2" placeholder="一段话描述……（空分类不会出现在简历中）" />
              </label>
            </div>
          </div>

          <div class="editor-sec">
            <h3>项目经历 <button class="btn" type="button" @click="addRow('projects', EMPTY_PROJECT)">+ 添加</button></h3>
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
                <label class="field span2"><span class="label">技术栈（每行一个）</span><textarea v-model="p.techStackText" rows="2" /></label>
              </div>
            </div>
          </div>

          <div class="editor-sec">
            <h3>实习经历 <button class="btn" type="button" @click="addRow('experience', EMPTY_EXP)">+ 添加</button></h3>
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

          <div class="editor-sec">
            <h3>科研经历 <button class="btn" type="button" @click="addRow('research', EMPTY_RESEARCH)">+ 添加</button></h3>
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

          <div class="editor-sec">
            <h3>自我评价</h3>
            <textarea v-model="form.selfAssessment" rows="3" placeholder="可留空（优化稿可生成）" />
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
      <button class="btn" type="button" :disabled="exporting" @click="exportPdf">
        {{ exporting ? '导出中…' : '导出 PDF' }}
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
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
</style>
