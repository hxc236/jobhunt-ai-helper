<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { Resume, StoredResume } from '@shared/types/resume'
import { emptyResumeForm, formToResume, issueSection, resumeToForm, type ResumeForm } from '../resume-form'

/**
 * 简历模块（F-13/#25）：简历列表（基准/派生分组）+ 分节表单编辑器（国企字段）+ JSON 模式。
 * - 列表：基准简历与派生稿分组展示（meta.baseResumeId 分组），可打开编辑/删除；
 * - 编辑器：分节表单（基本信息含政治面貌/生源地/生日/性别等国企字段；教育/技能/项目/
 *   实习/证书/自评/链接可增删条目）⇄ JSON 文本模式切换；
 * - 保存：服务端 resume.schema.json 校验，校验错误按 JSON Pointer 定位显示（issueSection）。
 */

const resumes = ref<StoredResume[]>([])
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

/** 编辑器状态：null = 列表模式；'' = 新建基准简历；其余 = 编辑该 id。 */
const editingId = ref<string | null | ''>(null)
/** 表单 ⇄ JSON 模式。 */
const jsonMode = ref(false)
const jsonText = ref('')
const jsonError = ref('')
/** 校验错误定位列表（保存失败时展示）。 */
const issues = ref<Array<{ path: string; detail: string }>>([])
const saving = ref(false)
/** 删除确认（行内两步）。 */
const deleteTarget = ref<StoredResume | null>(null)

const form = reactive<ResumeForm>(emptyResumeForm())

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

/** 表单 → JSON 模式：当前表单内容序列化（未保存的编辑保留）。 */
function switchToJson(): void {
  jsonText.value = JSON.stringify(formToResume(form), null, 2)
  jsonError.value = ''
  jsonMode.value = true
}

/** JSON → 表单模式：解析失败留在 JSON 模式并提示。 */
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

/** 保存：JSON 模式先解析，再走同一校验/入库路径。 */
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
    // 服务端写入 meta.id/updatedAt：刷新编辑器与列表
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

onMounted(() => void load())
</script>

<template>
  <section class="resumes-view">
    <h1 class="page-title">简历</h1>

    <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>

    <!-- 列表模式 -->
    <template v-if="editingId === null">
      <section class="card">
        <div class="card-head">
          <h2 class="card-title">基准简历 <span class="count">{{ bases.length }}</span></h2>
          <button class="btn btn-primary" type="button" @click="openEditor()">新建基准简历</button>
        </div>

        <p v-if="loading" class="hint">加载中…</p>
        <div v-else-if="bases.length === 0" class="empty-state">
          <p class="hint">
            暂无基准简历——新建后可在分节表单中填写基本信息（含政治面貌/生源地等国企字段）、
            教育/技能/项目/实习/证书等，也可切换到 JSON 模式直接编辑。
          </p>
          <button class="btn btn-primary" type="button" @click="openEditor()">新建基准简历</button>
        </div>
        <ul v-else class="resume-list">
          <li v-for="r in bases" :key="r.meta.id" class="resume-row">
            <span class="resume-name">{{ r.meta.title ?? '未命名简历' }}</span>
            <span class="pill pill-base">基准</span>
            <span class="meta">更新于 {{ fmtDate(r.meta.updatedAt) }}</span>
            <span class="row-actions">
              <button class="btn" type="button" @click="openEditor(r)">编辑</button>
              <button class="btn btn-danger-ghost" type="button" @click="deleteTarget = r">删除</button>
            </span>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2 class="card-title">派生稿 <span class="count">{{ derived.length }}</span></h2>
        <p class="hint">
          针对职位卡按 JD 生成的优化稿（关联基准简历与职位卡）——由「优化」流程产出（见职位详情），
          此处仅展示与编辑。
        </p>
        <ul v-if="derived.length > 0" class="resume-list">
          <li v-for="r in derived" :key="r.meta.id" class="resume-row">
            <span class="resume-name">{{ r.meta.title ?? '未命名优化稿' }}</span>
            <span class="pill pill-derived">派生</span>
            <span class="meta">更新于 {{ fmtDate(r.meta.updatedAt) }}</span>
            <span class="row-actions">
              <button class="btn" type="button" @click="openEditor(r)">编辑</button>
              <button class="btn btn-danger-ghost" type="button" @click="deleteTarget = r">删除</button>
            </span>
          </li>
        </ul>
      </section>

      <!-- 删除确认 -->
      <div v-if="deleteTarget !== null" class="confirm-box">
        <p class="confirm-text">
          确认删除「{{ deleteTarget.meta.title ?? '未命名简历' }}」？删除后不可恢复。
          <template v-if="deleteTarget.meta.baseResumeId != null">（派生稿为独立副本，不影响基准简历）</template>
        </p>
        <div class="confirm-actions">
          <button class="btn btn-danger" type="button" @click="confirmDelete">确认删除</button>
          <button class="btn" type="button" @click="deleteTarget = null">取消</button>
        </div>
      </div>
    </template>

    <!-- 编辑器 -->
    <template v-else>
      <section class="card">
        <div class="card-head">
          <h2 class="card-title">
            {{ editingExisting ? '编辑简历' : '新建基准简历' }}
            <span class="pill" :class="editingExisting ? 'pill-derived' : 'pill-base'">
              {{ editingExisting ? '派生稿可编辑' : '基准' }}
            </span>
          </h2>
          <div class="head-actions">
            <button class="btn" type="button" :disabled="saving" @click="jsonMode ? switchToForm() : switchToJson()">
              {{ jsonMode ? '⇄ 表单模式' : '⇄ JSON 模式' }}
            </button>
            <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="closeEditor">返回列表</button>
          </div>
        </div>

        <p v-if="successMessage" class="message success">{{ successMessage }}</p>

        <!-- 校验错误定位 -->
        <div v-if="issues.length > 0" class="issues-box">
          <p class="issues-title">保存未通过校验（{{ issues.length }} 处）：</p>
          <ul class="issues-list">
            <li v-for="(issue, i) in issues" :key="i">
              <span class="issue-path">{{ issue.path }}</span>
              <span class="issue-detail">{{ issue.detail }}</span>
            </li>
          </ul>
        </div>

        <!-- JSON 模式 -->
        <div v-if="jsonMode" class="json-mode">
          <p class="hint">JSON 模式：直接编辑 resume.schema.json 结构；切换到表单模式或保存时解析校验。</p>
          <p v-if="jsonError" class="message error">{{ jsonError }}</p>
          <textarea v-model="jsonText" class="json-textarea" rows="28" spellcheck="false" />
        </div>

        <!-- 分节表单 -->
        <form v-else class="form" @submit.prevent="save">
          <!-- 基本信息（含国企字段） -->
          <section class="section">
            <h3 class="section-title">基本信息</h3>
            <div class="form-grid">
              <label class="field">
                <span class="label">姓名 <em class="required">*</em></span>
                <input v-model="form.basics.name" class="input" />
              </label>
              <label class="field">
                <span class="label">性别</span>
                <select v-model="form.basics.gender" class="input">
                  <option value="">未填</option>
                  <option value="男">男</option>
                  <option value="女">女</option>
                </select>
              </label>
              <label class="field">
                <span class="label">生日（YYYY-MM）</span>
                <input v-model="form.basics.birthday" class="input" placeholder="2004-06" />
              </label>
              <label class="field">
                <span class="label">政治面貌 <em class="soe">国企必填</em></span>
                <input v-model="form.basics.politicalStatus" class="input" placeholder="中共党员 / 共青团员 / 群众" />
              </label>
              <label class="field">
                <span class="label">生源地 <em class="soe">国企必填</em></span>
                <input v-model="form.basics.hometown" class="input" placeholder="如：四川绵阳" />
              </label>
              <label class="field">
                <span class="label">电话</span>
                <input v-model="form.basics.phone" class="input" placeholder="138-0000-1234" />
              </label>
              <label class="field">
                <span class="label">邮箱</span>
                <input v-model="form.basics.email" class="input" placeholder="name@example.com" />
              </label>
              <label class="field">
                <span class="label">现居城市</span>
                <input v-model="form.basics.location" class="input" />
              </label>
            </div>

            <h4 class="sub-title">求职意向</h4>
            <div class="form-grid">
              <label class="field">
                <span class="label">意向岗位</span>
                <input v-model="form.basics.jobIntention.position" class="input" placeholder="如：后端开发工程师（校招）" />
              </label>
              <label class="field">
                <span class="label">期望城市（每行一个）</span>
                <textarea v-model="form.basics.jobIntention.cityText" class="input textarea" rows="2" placeholder="北京&#10;杭州" />
              </label>
              <label class="field">
                <span class="label">期望薪资</span>
                <input v-model="form.basics.jobIntention.salary" class="input" placeholder="面议" />
              </label>
            </div>

            <h4 class="sub-title">链接（GitHub / 博客 / 作品）</h4>
            <div v-for="(link, i) in form.basics.links" :key="i" class="link-row">
              <input v-model="link.label" class="input" placeholder="名称，如 GitHub" />
              <input v-model="link.url" class="input" placeholder="https://…" />
              <button class="btn btn-danger-ghost" type="button" @click="form.basics.links.splice(i, 1)">删除</button>
            </div>
            <button
              class="btn btn-ghost"
              type="button"
              @click="form.basics.links.push({ label: '', url: '' })"
            >
              + 添加链接
            </button>
          </section>

          <!-- 教育经历 -->
          <section class="section">
            <h3 class="section-title">
              教育经历
              <button class="btn btn-ghost" type="button" @click="addRow('education', EMPTY_EDU)">+ 添加</button>
            </h3>
            <div v-for="(e, i) in form.education" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn btn-danger-ghost" type="button" @click="removeRow('education', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="label">学校 <em class="required">*</em></span>
                  <input v-model="e.school" class="input" />
                </label>
                <label class="field">
                  <span class="label">学历 <em class="required">*</em></span>
                  <input v-model="e.degree" class="input" placeholder="本科 / 硕士 / 博士" />
                </label>
                <label class="field">
                  <span class="label">专业 <em class="required">*</em></span>
                  <input v-model="e.major" class="input" />
                </label>
                <label class="field">
                  <span class="label">开始时间（YYYY-MM）</span>
                  <input v-model="e.startDate" class="input" placeholder="2022-09" />
                </label>
                <label class="field">
                  <span class="label">结束时间（应届可留空）</span>
                  <input v-model="e.endDate" class="input" placeholder="2026-06" />
                </label>
                <label class="field">
                  <span class="label">绩点（如 3.7/4.0）</span>
                  <input v-model="e.gpa" class="input" />
                </label>
                <label class="field">
                  <span class="label">排名 <em class="soe">国企看重</em></span>
                  <input v-model="e.rank" class="input" placeholder="前 10%" />
                </label>
                <label class="field">
                  <span class="label">相关课程（每行一个）</span>
                  <textarea v-model="e.coursesText" class="input textarea" rows="2" />
                </label>
                <label class="field">
                  <span class="label">荣誉/奖学金（每行一个）</span>
                  <textarea v-model="e.honorsText" class="input textarea" rows="2" />
                </label>
              </div>
            </div>
          </section>

          <!-- 技能 -->
          <section class="section">
            <h3 class="section-title">
              技能
              <button class="btn btn-ghost" type="button" @click="addRow('skills', EMPTY_SKILL)">+ 添加</button>
            </h3>
            <div v-for="(s, i) in form.skills" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 组</span>
                <button class="btn btn-danger-ghost" type="button" @click="removeRow('skills', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="label">分类</span>
                  <input v-model="s.category" class="input" placeholder="编程语言 / 框架 / 工具" />
                </label>
                <label class="field">
                  <span class="label">熟练度</span>
                  <select v-model="s.proficiency" class="input">
                    <option value="">未填</option>
                    <option value="熟练">熟练</option>
                    <option value="熟悉">熟悉</option>
                    <option value="了解">了解</option>
                  </select>
                </label>
                <label class="field field-wide">
                  <span class="label">技能项（每行一个）</span>
                  <textarea v-model="s.itemsText" class="input textarea" rows="2" placeholder="Java&#10;Spring Boot" />
                </label>
              </div>
            </div>
          </section>

          <!-- 项目经历 -->
          <section class="section">
            <h3 class="section-title">
              项目经历
              <button class="btn btn-ghost" type="button" @click="addRow('projects', EMPTY_PROJECT)">+ 添加</button>
            </h3>
            <div v-for="(p, i) in form.projects" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn btn-danger-ghost" type="button" @click="removeRow('projects', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="label">项目名</span>
                  <input v-model="p.name" class="input" />
                </label>
                <label class="field">
                  <span class="label">角色</span>
                  <input v-model="p.role" class="input" placeholder="后端开发 / 全栈" />
                </label>
                <label class="field">
                  <span class="label">开始时间（YYYY-MM）</span>
                  <input v-model="p.startDate" class="input" placeholder="2025-03" />
                </label>
                <label class="field">
                  <span class="label">结束时间</span>
                  <input v-model="p.endDate" class="input" placeholder="2025-08" />
                </label>
                <label class="field field-wide">
                  <span class="label">描述</span>
                  <textarea v-model="p.description" class="input textarea" rows="2" />
                </label>
                <label class="field">
                  <span class="label">要点（每行一个，动词开头、量化优先）</span>
                  <textarea v-model="p.highlightsText" class="input textarea" rows="3" />
                </label>
                <label class="field">
                  <span class="label">技术栈（每行一个）</span>
                  <textarea v-model="p.techStackText" class="input textarea" rows="3" />
                </label>
                <label class="field field-wide">
                  <span class="label">链接</span>
                  <input v-model="p.link" class="input" placeholder="https://…（可留空）" />
                </label>
              </div>
            </div>
          </section>

          <!-- 实习经历 -->
          <section class="section">
            <h3 class="section-title">
              实习经历
              <button class="btn btn-ghost" type="button" @click="addRow('experience', EMPTY_EXP)">+ 添加</button>
            </h3>
            <div v-for="(x, i) in form.experience" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn btn-danger-ghost" type="button" @click="removeRow('experience', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="label">公司</span>
                  <input v-model="x.company" class="input" />
                </label>
                <label class="field">
                  <span class="label">岗位</span>
                  <input v-model="x.title" class="input" />
                </label>
                <label class="field">
                  <span class="label">开始时间</span>
                  <input v-model="x.startDate" class="input" placeholder="2026-01" />
                </label>
                <label class="field">
                  <span class="label">结束时间</span>
                  <input v-model="x.endDate" class="input" placeholder="2026-06" />
                </label>
                <label class="field">
                  <span class="label">要点（每行一个）</span>
                  <textarea v-model="x.highlightsText" class="input textarea" rows="3" />
                </label>
                <label class="field">
                  <span class="label">技术栈（每行一个）</span>
                  <textarea v-model="x.techStackText" class="input textarea" rows="3" />
                </label>
              </div>
            </div>
          </section>

          <!-- 证书 -->
          <section class="section">
            <h3 class="section-title">
              证书
              <button class="btn btn-ghost" type="button" @click="addRow('certificates', EMPTY_CERT)">+ 添加</button>
            </h3>
            <div v-for="(c, i) in form.certificates" :key="i" class="entry">
              <div class="entry-head">
                <span class="entry-label">第 {{ i + 1 }} 条</span>
                <button class="btn btn-danger-ghost" type="button" @click="removeRow('certificates', i)">删除</button>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span class="label">证书名</span>
                  <input v-model="c.name" class="input" placeholder="CET-6" />
                </label>
                <label class="field">
                  <span class="label">颁发机构</span>
                  <input v-model="c.issuer" class="input" />
                </label>
                <label class="field">
                  <span class="label">日期（YYYY-MM）</span>
                  <input v-model="c.date" class="input" placeholder="2024-12" />
                </label>
              </div>
            </div>
          </section>

          <!-- 自我评价 -->
          <section class="section">
            <h3 class="section-title">自我评价</h3>
            <textarea v-model="form.selfAssessment" class="input textarea" rows="3" placeholder="可留空（优化稿可生成）" />
          </section>

          <div class="form-actions">
            <button class="btn btn-primary" type="submit" :disabled="saving">
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="closeEditor">取消</button>
          </div>
        </form>
      </section>
    </template>
  </section>
</template>

<style scoped>
.resumes-view {
  max-width: 880px;
}

.page-title {
  margin: 0 0 16px;
  font-size: 20px;
}

.card {
  padding: 16px 20px;
  margin-bottom: 16px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.card-title {
  margin: 0;
  font-size: 15px;
}

.count {
  margin-left: 4px;
  color: #6b7280;
  font-weight: 400;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.resume-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.resume-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f1f3;
}

.resume-row:last-child {
  border-bottom: none;
}

.resume-name {
  font-weight: 600;
}

.pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.pill-base {
  background: #eff6ff;
  color: #1d4ed8;
}

.pill-derived {
  background: #f5f3ff;
  color: #6d28d9;
}

.row-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
}

.confirm-box {
  margin-top: 12px;
  padding: 12px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
}

.confirm-text {
  margin: 0 0 10px;
  font-size: 13px;
  color: #991b1b;
  line-height: 1.6;
}

.confirm-actions,
.form-actions {
  display: flex;
  gap: 10px;
}

.message {
  margin: 12px 0;
  font-size: 13px;
  line-height: 1.6;
}

.error {
  color: #dc2626;
}

.success {
  color: #059669;
}

.issues-box {
  margin: 12px 0;
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
}

.issues-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: #991b1b;
}

.issues-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: #991b1b;
}

.issue-path {
  font-weight: 600;
}

.issue-detail {
  margin-left: 8px;
}

.section {
  margin: 18px 0;
  padding-top: 14px;
  border-top: 1px solid #f0f1f3;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 12px;
  font-size: 14px;
}

.sub-title {
  margin: 14px 0 8px;
  font-size: 13px;
  color: #374151;
}

.entry {
  margin: 0 0 14px;
  padding: 10px 12px;
  background: #fafbfc;
  border: 1px solid #eef0f3;
  border-radius: 6px;
}

.entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.entry-label {
  font-size: 12px;
  color: #6b7280;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-wide {
  grid-column: 1 / -1;
}

.label {
  font-size: 13px;
  color: #374151;
}

.required {
  color: #dc2626;
  font-style: normal;
}

.soe {
  color: #b45309;
  font-style: normal;
  font-size: 11px;
}

.input {
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}

.textarea {
  resize: vertical;
}

.link-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.link-row .input {
  flex: 1;
}

.btn {
  padding: 6px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary {
  background: #2b5ca8;
  border-color: #2b5ca8;
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: #244e8f;
}

.btn-danger {
  background: #dc2626;
  border-color: #dc2626;
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

.btn-danger-ghost {
  border-color: transparent;
  color: #dc2626;
  background: transparent;
}

.btn-danger-ghost:hover {
  background: #fef2f2;
}

.btn-ghost {
  border-color: transparent;
  background: transparent;
  color: #2b5ca8;
}

.btn-ghost:hover {
  background: #f3f6fb;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.hint {
  margin: 0;
  color: #6b7280;
  line-height: 1.7;
}

.json-mode {
  margin-top: 10px;
}

.json-textarea {
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  box-sizing: border-box;
  resize: vertical;
}
</style>
