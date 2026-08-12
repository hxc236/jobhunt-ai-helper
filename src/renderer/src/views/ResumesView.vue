<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { Resume, StoredResume } from '@shared/types/resume'
import { emptyResumeForm, formToResume, issueSection, resumeToForm, type ResumeForm } from '../resume-form'
import { draftToResume, draftWarnings } from '../draft-form'
import type { ResumeDraft } from '@shared/types'
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

/** 上传草稿确认（F-16/#31）。 */
const uploading = ref(false)
const uploadError = ref('')
const draft = ref<ResumeDraft | null>(null)
const draftTitle = ref('')
const draftForm = reactive({
  name: '', phone: '', email: '', gender: '' as '' | '男' | '女', birthday: '',
  school: '', degree: '', major: '', period: '', skillsText: ''
})
const confirmingDraft = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function pickFile(): void {
  fileInput.value?.click()
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) return
  const filePath = (file as unknown as { path?: string }).path
  if (filePath === undefined) {
    uploadError.value = '无法获取文件路径'
    return
  }
  void parseFile(filePath)
}

async function parseFile(filePath: string): Promise<void> {
  uploadError.value = ''
  uploading.value = true
  try {
    const d = await window.api.resumes.uploadParse(filePath)
    draft.value = d
    draftTitle.value = d.fileName.replace(/\.(docx|pdf)$/i, '')
    Object.assign(draftForm, {
      name: d.fields.name ?? '',
      phone: d.fields.phone ?? '',
      email: d.fields.email ?? '',
      gender: d.fields.gender ?? '',
      birthday: d.fields.birthday ?? '',
      school: d.fields.education[0]?.school ?? '',
      degree: d.fields.education[0]?.degree ?? '',
      major: d.fields.education[0]?.major ?? '',
      period: d.fields.education[0]?.period ?? '',
      skillsText: d.fields.skills.join('\n')
    })
  } catch (err) {
    uploadError.value = String(err)
  } finally {
    uploading.value = false
  }
}

async function confirmDraft(): Promise<void> {
  if (draft.value === null) return
  confirmingDraft.value = true
  uploadError.value = ''
  try {
    const resume = draftToResume(
      {
        ...draft.value,
        fields: {
          name: draftForm.name,
          phone: draftForm.phone,
          email: draftForm.email,
          gender: draftForm.gender,
          birthday: draftForm.birthday,
          education:
            draftForm.school === '' && draftForm.degree === '' && draftForm.major === ''
              ? []
              : [{ school: draftForm.school, degree: draftForm.degree, major: draftForm.major, period: draftForm.period }],
          skills: draftForm.skillsText
            .split(/[\n,，、]+/)
            .map((t) => t.trim())
            .filter((t) => t !== '')
        }
      },
      draftTitle.value
    )
    const stored = await window.api.resumes.create(resume)
    successMessage.value = `已保存「${stored.meta.title ?? stored.meta.id}」`
    draft.value = null
    await load()
  } catch (err) {
    uploadError.value = String(err)
  } finally {
    confirmingDraft.value = false
  }
}

function cancelDraft(): void {
  draft.value = null
  uploadError.value = ''
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
  Object.assign(form, resume === undefined ? emptyResumeForm() : resumeToForm(resume))
  editingId.value = resume?.meta.id ?? ''
  jsonMode.value = false
}

function closeEditor(): void {
  editingId.value = null
  issues.value = []
}

function switchToJson(): void {
  jsonText.value = JSON.stringify(formToResume(form), null, 2)
  jsonError.value = ''
  jsonMode.value = true
}

function switchToForm(): void {
  try {
    const parsed = JSON.parse(jsonText.value) as Resume
    Object.assign(form, resumeToForm(parsed))
    jsonError.value = ''
    jsonMode.value = false
  } catch (err) {
    jsonError.value = `JSON 解析失败：${String(err)}`
  }
}

async function save(): Promise<void> {
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
    resume = formToResume(form)
  }

  saving.value = true
  try {
    const targetId = editingId.value
    const stored =
      targetId !== null && targetId !== ''
        ? await window.api.resumes.update(targetId, resume)
        : await window.api.resumes.create(resume)
    successMessage.value = `已保存「${stored.meta.title ?? stored.meta.id}」`
    Object.assign(form, resumeToForm(stored))
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
  school: '', degree: '', major: '', startDate: '', endDate: '', gpa: '', rank: '', coursesText: '', honorsText: ''
}
const EMPTY_SKILL: ResumeForm['skills'][number] = { category: '', itemsText: '', proficiency: '' }
const EMPTY_PROJECT: ResumeForm['projects'][number] = {
  name: '', role: '', startDate: '', endDate: '', description: '', highlightsText: '', techStackText: '', link: ''
}
const EMPTY_EXP: ResumeForm['experience'][number] = {
  company: '', title: '', startDate: '', endDate: '', highlightsText: '', techStackText: ''
}
const EMPTY_CERT: ResumeForm['certificates'][number] = { name: '', issuer: '', date: '' }

function fmtDate(iso: string | undefined): string {
  return iso === undefined ? '' : iso.slice(0, 10)
}

function onRowKeydown(e: KeyboardEvent, resume: StoredResume): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openEditor(resume)
  }
}

onMounted(() => void load())
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
          <button class="btn" type="button" :disabled="uploading" @click="pickFile">
            <Icon name="upload" />{{ uploading ? '解析中…' : '上传解析' }}
          </button>
          <button class="btn primary" type="button" @click="openEditor()">
            <Icon name="plus" />新建
          </button>
        </div>
      </div>
      <input ref="fileInput" type="file" accept=".docx,.pdf" hidden @change="onFilePicked" />

      <p v-if="errorMessage" class="empty">{{ errorMessage }}</p>
      <p v-if="loading" class="empty">加载中…</p>

      <div class="rgroup-title"><span>基准简历</span><span>{{ bases.length }} 份</span></div>
      <div v-if="bases.length === 0 && !loading" class="empty">
        暂无基准简历——点「新建」或「上传解析」创建。
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
        <div class="res-name">{{ r.meta.title ?? '未命名简历' }}</div>
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
        <div class="res-name">{{ r.meta.title ?? '未命名优化稿' }}</div>
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

      <!-- 上传草稿确认 -->
      <div v-if="draft" class="ws-card">
        <div class="ws-head">
          <div>
            <div class="ws-title">上传解析草稿</div>
            <div class="ws-sub">{{ draft.fileName }} · 置信度 {{ Math.round(draft.confidence * 100) }}%</div>
          </div>
          <Pill :tone="draft.scanned ? '' : 'tint'">{{ draft.scanned ? '需人工核对' : '字段完整' }}</Pill>
        </div>
        <ul v-if="draftWarnings(draft).length > 0" class="warnings">
          <li v-for="w in draftWarnings(draft)" :key="w">{{ w }}</li>
        </ul>
        <div class="form-grid">
          <label class="field"><span class="label">简历名</span><input v-model="draftTitle" /></label>
          <label class="field"><span class="label">姓名 <em class="required">*</em></span><input v-model="draftForm.name" /></label>
          <label class="field"><span class="label">电话</span><input v-model="draftForm.phone" /></label>
          <label class="field"><span class="label">邮箱</span><input v-model="draftForm.email" /></label>
          <label class="field">
            <span class="label">性别</span>
            <select v-model="draftForm.gender">
              <option value="">未填</option>
              <option value="男">男</option>
              <option value="女">女</option>
            </select>
          </label>
          <label class="field"><span class="label">生日（YYYY-MM）</span><input v-model="draftForm.birthday" placeholder="2004-06" /></label>
          <label class="field"><span class="label">学校</span><input v-model="draftForm.school" /></label>
          <label class="field"><span class="label">学历</span><input v-model="draftForm.degree" placeholder="本科 / 硕士 / 博士" /></label>
          <label class="field"><span class="label">专业</span><input v-model="draftForm.major" /></label>
          <label class="field"><span class="label">起止时间</span><input v-model="draftForm.period" placeholder="2022.09 ~ 2026.06" /></label>
          <label class="field span2"><span class="label">技能（每行一个）</span><textarea v-model="draftForm.skillsText" rows="3" /></label>
        </div>
        <div class="ws-actions">
          <button class="btn primary" type="button" :disabled="confirmingDraft" @click="confirmDraft">
            {{ confirmingDraft ? '保存中…' : '确认存为基准简历' }}
          </button>
          <button class="btn" type="button" :disabled="confirmingDraft" @click="cancelDraft">放弃</button>
        </div>
      </div>

      <!-- 编辑器 -->
      <template v-else-if="editingId !== null">
        <div class="ws-head">
          <div>
            <div class="ws-title">{{ editingExisting ? '编辑简历' : '新建基准简历' }}</div>
            <div class="ws-sub">
              <Pill v-if="editingExisting" tone="tint">派生稿</Pill>
              <Pill v-else>基准</Pill>
              <span style="margin-left: 6px">分节表单 ⇄ JSON 模式</span>
            </div>
          </div>
          <div class="head-actions">
            <button class="btn" type="button" :disabled="saving" @click="jsonMode ? switchToForm() : switchToJson()">
              {{ jsonMode ? '⇄ 表单模式' : '⇄ JSON 模式' }}
            </button>
            <button class="btn primary" type="button" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
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

        <div v-if="jsonMode" class="editor-sec">
          <h3>JSON 模式</h3>
          <p class="hint">直接编辑 resume.schema.json 结构；切换到表单模式或保存时解析校验。</p>
          <p v-if="jsonError" class="ws-msg err">{{ jsonError }}</p>
          <textarea v-model="jsonText" class="json-textarea" rows="28" spellcheck="false" />
        </div>

        <form v-else @submit.prevent="save">
          <div class="editor-sec">
            <h3>基本信息 <em class="soe">国企字段：政治面貌 / 生源地</em></h3>
            <div class="form-grid">
              <label class="field"><span class="label">姓名 <em class="required">*</em></span><input v-model="form.basics.name" /></label>
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
                <label class="field"><span class="label">荣誉/奖学金（每行一个）</span><textarea v-model="e.honorsText" rows="2" /></label>
              </div>
            </div>
          </div>

          <div class="editor-sec">
            <h3>技能 <button class="btn" type="button" @click="addRow('skills', EMPTY_SKILL)">+ 添加</button></h3>
            <div v-for="(s, i) in form.skills" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 组</span>
                <button class="btn ghost" type="button" @click="removeRow('skills', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field"><span class="label">分类</span><input v-model="s.category" placeholder="编程语言 / 框架 / 工具" /></label>
                <label class="field">
                  <span class="label">熟练度</span>
                  <select v-model="s.proficiency">
                    <option value="">未填</option>
                    <option value="熟练">熟练</option>
                    <option value="熟悉">熟悉</option>
                    <option value="了解">了解</option>
                  </select>
                </label>
                <label class="field span2"><span class="label">技能项（每行一个）</span><textarea v-model="s.itemsText" rows="2" placeholder="Java&#10;Spring Boot" /></label>
              </div>
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
                <label class="field"><span class="label">角色</span><input v-model="p.role" placeholder="后端开发 / 全栈" /></label>
                <label class="field"><span class="label">开始时间（YYYY-MM）</span><input v-model="p.startDate" placeholder="2025-03" /></label>
                <label class="field"><span class="label">结束时间</span><input v-model="p.endDate" placeholder="2025-08" /></label>
                <label class="field span2"><span class="label">描述</span><textarea v-model="p.description" rows="2" /></label>
                <label class="field"><span class="label">要点（每行一个，量化优先）</span><textarea v-model="p.highlightsText" rows="3" /></label>
                <label class="field"><span class="label">技术栈（每行一个）</span><textarea v-model="p.techStackText" rows="3" /></label>
                <label class="field span2"><span class="label">链接</span><input v-model="p.link" placeholder="https://…（可留空）" /></label>
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
            <h3>证书 <button class="btn" type="button" @click="addRow('certificates', EMPTY_CERT)">+ 添加</button></h3>
            <div v-for="(c, i) in form.certificates" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn ghost" type="button" @click="removeRow('certificates', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field"><span class="label">证书名</span><input v-model="c.name" placeholder="CET-6" /></label>
                <label class="field"><span class="label">颁发机构</span><input v-model="c.issuer" /></label>
                <label class="field"><span class="label">日期（YYYY-MM）</span><input v-model="c.date" placeholder="2024-12" /></label>
              </div>
            </div>
          </div>

          <div class="editor-sec">
            <h3>自我评价</h3>
            <textarea v-model="form.selfAssessment" rows="3" placeholder="可留空（优化稿可生成）" />
          </div>

          <div class="ws-actions">
            <button class="btn primary" type="submit" :disabled="saving">
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="closeEditor">取消</button>
          </div>
        </form>
      </template>

      <!-- 空工作区 -->
      <template v-else>
        <div class="ws-empty">
          <p class="hint">从左侧选择一份简历开始编辑，或新建基准简历 / 上传解析。</p>
          <div class="ws-actions">
            <button class="btn primary" type="button" @click="openEditor()">新建基准简历</button>
            <button class="btn" type="button" @click="pickFile">上传 docx / PDF 解析</button>
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
  <Modal :open="previewHtml !== ''" :title="`A4 预览 · ${previewTitle}`" @close="previewHtml = ''">
    <template #head-actions>
      <button class="btn" type="button" :disabled="exporting" @click="exportPdf">
        {{ exporting ? '导出中…' : '导出 PDF' }}
      </button>
    </template>
    <p v-if="exportMessage" class="hint" :style="{ color: exportMessage.startsWith('已导出') ? '#059669' : '#dc2626' }">
      {{ exportMessage }}
    </p>
    <p v-if="previewError" class="hint" style="color: #dc2626">{{ previewError }}</p>
    <div class="a4-body">
      <iframe class="a4-frame" :srcdoc="previewHtml" title="A4 预览" />
    </div>
  </Modal>
</template>

<style scoped>
.workspace {
  overflow-y: auto;
  padding: 20px 24px;
  background: var(--bg);
  min-width: 0;
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

/* A4 预览弹窗 */
.a4-body {
  background: var(--surface);
  display: flex;
  justify-content: center;
  padding: 14px;
}

.a4-frame {
  width: 740px;
  max-width: 100%;
  height: 70vh;
  border: 1px solid var(--border);
  background: #ffffff;
  box-shadow: 0 4px 24px color-mix(in srgb, #000000 12%, transparent);
}
</style>
