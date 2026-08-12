<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  BATCHES,
  COMPANY_TYPES,
  CRAWL_MODES,
  type ApplicationStatus,
  type Batch,
  type CompanyType,
  type CrawlMode,
  type CrawlPreview,
  type CrawlRun,
  type Position,
  type PositionInput,
  type PositionListItem,
  type PositionSource,
  type PositionStatus
} from '@shared/types'
import { IpcEvent } from '@shared/protocol'

const router = useRouter()

/** 采集（F-11/#29）：触发入口（源/模式/筛选）+ 预览确认（统计/勾选/缺字段）+ 留痕列表。 */
const crawlSource = ref<PositionSource>('nowcoder')
const crawlMode = ref<CrawlMode>('full')
const crawlKeyword = ref('')
const crawling = ref(false)
const crawlProgress = ref<{ done: number; total: number } | null>(null)
const crawlError = ref('')
const preview = ref<CrawlPreview | null>(null)
const selectedUrls = ref<Set<string>>(new Set())
const importing = ref(false)
const importMessage = ref('')
const crawlRuns = ref<CrawlRun[]>([])
const runsError = ref('')

const SOURCE_LABELS: Record<PositionSource, string> = {
  manual: '手动',
  nowcoder: '牛客校招日程',
  liepin: '猎聘校招'
}

const CRAWL_RUN_STATUS_LABELS: Record<CrawlRun['status'], string> = {
  running: '执行中',
  success: '成功',
  partial: '部分成功',
  failed: '失败'
}

const MISSING_LABELS: Record<string, string> = { title: '无岗位名', end_date: '无截止' }

async function loadRuns(): Promise<void> {
  try {
    crawlRuns.value = await window.api.crawls.runs()
  } catch (err) {
    runsError.value = `加载留痕失败：${String(err)}`
  }
}

async function startCrawl(): Promise<void> {
  crawlError.value = ''
  importMessage.value = ''
  preview.value = null
  crawling.value = true
  crawlProgress.value = null
  try {
    const result = await window.api.crawls.run(crawlSource.value, {
      mode: crawlMode.value,
      filter: crawlMode.value === 'filter' ? crawlKeyword.value : undefined
    })
    const p = await window.api.crawls.preview(result.run.id)
    preview.value = p
    selectedUrls.value = new Set(p.items.map((i) => i.candidate.source_url))
    await loadRuns()
  } catch (err) {
    crawlError.value = String(err)
  } finally {
    crawling.value = false
    crawlProgress.value = null
  }
}

function toggleSelect(url: string): void {
  const next = new Set(selectedUrls.value)
  if (next.has(url)) next.delete(url)
  else next.add(url)
  selectedUrls.value = next
}

function toggleAll(checked: boolean): void {
  selectedUrls.value = new Set(
    checked ? preview.value?.items.map((i) => i.candidate.source_url) ?? [] : []
  )
}

async function confirmImport(): Promise<void> {
  if (preview.value === null) return
  importing.value = true
  importMessage.value = ''
  try {
    const result = await window.api.crawls.confirmImport(preview.value.run.id, [...selectedUrls.value])
    importMessage.value = `已导入：新增 ${result.inserted} 条，更新 ${result.updated} 条`
    preview.value = await window.api.crawls.preview(preview.value.run.id) // 刷新统计
    await refresh()
  } catch (err) {
    crawlError.value = String(err)
  } finally {
    importing.value = false
  }
}

async function viewRun(runId: number): Promise<void> {
  crawlError.value = ''
  try {
    const p = await window.api.crawls.preview(runId)
    preview.value = p
    selectedUrls.value = new Set(p.items.map((i) => i.candidate.source_url))
  } catch (err) {
    crawlError.value = String(err)
  }
}

function fmtRunTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

onMounted(() => {
  void refresh()
  void loadRuns()
  // 采集进度事件（主 → 渲染）：抓取中 done/total
  const unsubscribe = window.api.on(IpcEvent.CrawlProgress, (payload) => {
    crawlProgress.value = { done: payload.done, total: payload.total }
  })
  onUnmounted(unsubscribe)
})

/** 表单态：batch 额外允许空串（「未指定」选项），提交时转 undefined。 */
type PositionFormState = Omit<PositionInput, 'batch'> & { batch: Batch | '' }

/** 筛选态：空串 = 「全部」（提交时转 undefined）。 */
type FilterState = {
  company_type: CompanyType | ''
  batch: Batch | ''
  status: PositionStatus | ''
  recruit_season: string
  application_status: ApplicationStatus | ''
}

/** 录入表单初始态：必填=公司+岗位（F-01 规则）；企业性质默认「其他」兜底 NOT NULL 约束。 */
function emptyForm(): PositionFormState {
  return {
    company: '',
    company_type: '其他',
    title: '',
    jd: '',
    city: '',
    channel: '',
    channel_url: '',
    recruit_season: '2026秋招',
    batch: '',
    start_date: '',
    end_date: '',
    notes: ''
  }
}

function emptyFilters(): FilterState {
  return { company_type: '', batch: '', status: '', recruit_season: '', application_status: '' }
}

const form = reactive<PositionFormState>(emptyForm())
const filters = reactive<FilterState>(emptyFilters())
const positions = ref<PositionListItem[]>([])
/** 全量列表：仅用于秋招季下拉选项（筛选后仍保留全部季度可选）。 */
const allPositions = ref<Position[]>([])
const seasons = computed(() => [...new Set(allPositions.value.map((p) => p.recruit_season))])
const hasFilters = computed(
  () =>
    filters.company_type !== '' ||
    filters.batch !== '' ||
    filters.status !== '' ||
    filters.recruit_season !== '' ||
    filters.application_status !== ''
)
const submitting = ref(false)
const loading = ref(false)
/** 表单级错误提示（校验失败/重复录入等；主进程 PositionError message 透传）。 */
const errorMessage = ref('')
const successMessage = ref('')
/** 空状态引导「录入第一条」：聚焦表单公司输入框。 */
const companyInput = ref<HTMLInputElement>()

async function loadPositions(): Promise<void> {
  loading.value = true
  try {
    positions.value = await window.api.positions.list({
      company_type: filters.company_type || undefined,
      batch: filters.batch || undefined,
      status: filters.status || undefined,
      recruit_season: filters.recruit_season || undefined,
      application_status: filters.application_status || undefined
    })
  } catch (err) {
    errorMessage.value = `加载职位列表失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  await Promise.all([
    loadPositions(),
    // 全量列表仅用于秋招季选项：加载失败不阻塞已过滤列表展示
    window.api.positions.list().then(
      (rows) => (allPositions.value = rows),
      () => {}
    )
  ])
}

function clearFilters(): void {
  Object.assign(filters, emptyFilters()) // watch 触发重新加载
}

function focusEntryForm(): void {
  companyInput.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  companyInput.value?.focus()
}

/** 四维筛选任一变化即重新查询（服务层组合生效；F-05/#21 增投递状态维度）。 */
watch(
  [
    () => filters.company_type,
    () => filters.batch,
    () => filters.status,
    () => filters.recruit_season,
    () => filters.application_status
  ],
  () => void loadPositions()
)

async function submit(): Promise<void> {
  errorMessage.value = ''
  successMessage.value = ''

  // 客户端必填校验（F-01：缺必填有提示）；服务端仍会再校验（IPC 边界）
  if (form.company.trim() === '' || form.title.trim() === '') {
    errorMessage.value = '公司与岗位为必填项'
    return
  }

  submitting.value = true
  try {
    await window.api.positions.create({
      ...form,
      company: form.company.trim(),
      title: form.title.trim(),
      // 空串转 undefined：服务端把 undefined/空串都归为 null，语义一致
      batch: form.batch === '' ? undefined : form.batch
    })
    successMessage.value = `已录入「${form.company} · ${form.title}」`
    Object.assign(form, emptyForm())
    await refresh()
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    submitting.value = false
  }
}

/** 倒计时徽标文案：null=待核实（灰）；≤0=已截止；其余「剩 N 天」。 */
function badgeText(daysLeft: number | null): string {
  if (daysLeft === null) return '待核实'
  if (daysLeft <= 0) return '已截止'
  return `剩 ${daysLeft} 天`
}

/** 倒计时徽标样式：≤14 天（含已截止）红，其余常规，无截止灰。 */
function badgeClass(daysLeft: number | null): string {
  if (daysLeft === null) return 'badge badge-unknown'
  return daysLeft <= 14 ? 'badge badge-urgent' : 'badge badge-normal'
}

onMounted(() => void refresh())</script>

<template>
  <section class="jobs-view">
    <h1 class="page-title">职位</h1>

    <section class="card">
      <h2 class="card-title">采集职位 <span class="hint-inline">牛客校招日程 / 猎聘校招（节流重试上限自动处理）</span></h2>

      <div class="crawl-bar">
        <label class="filter">
          <span class="label">来源</span>
          <select v-model="crawlSource" class="input" :disabled="crawling">
            <option value="nowcoder">牛客校招日程</option>
            <option value="liepin">猎聘校招</option>
          </select>
        </label>
        <label class="filter">
          <span class="label">模式</span>
          <select v-model="crawlMode" class="input" :disabled="crawling">
            <option v-for="m in CRAWL_MODES" :key="m" :value="m">
              {{ m === 'full' ? '全量' : '关键词筛选' }}
            </option>
          </select>
        </label>
        <label v-if="crawlMode === 'filter'" class="filter">
          <span class="label">关键词（公司名）</span>
          <input v-model="crawlKeyword" class="input" placeholder="如：腾讯" :disabled="crawling" />
        </label>
        <button class="btn btn-primary" type="button" :disabled="crawling" @click="startCrawl">
          {{ crawling ? '采集中…' : '开始采集' }}
        </button>
      </div>
      <p v-if="crawlProgress" class="hint">
        抓取中 {{ crawlProgress.done }}/{{ crawlProgress.total }}（每次请求间隔 ≥2s，失败自动重试）…
      </p>
      <p v-if="crawlError" class="message error">{{ crawlError }}</p>
      <p v-if="importMessage" class="message success">{{ importMessage }}</p>

      <!-- 预览确认：统计 + 勾选 + 缺字段标记 -->
      <div v-if="preview" class="preview">
        <div class="preview-head">
          <span class="preview-stats">
            将新增 <b class="num-new">{{ preview.stats.inserted }}</b> ·
            更新 <b class="num-upd">{{ preview.stats.updated }}</b> ·
            缺字段 <b class="num-miss">{{ preview.stats.missing }}</b>
          </span>
          <label class="select-all">
            <input
              type="checkbox"
              :checked="selectedUrls.size === preview.items.length && preview.items.length > 0"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
            全选
          </label>
        </div>
        <ul class="candidate-list">
          <li v-for="item in preview.items" :key="item.candidate.source_url" class="candidate-row">
            <input
              type="checkbox"
              :checked="selectedUrls.has(item.candidate.source_url)"
              @change="toggleSelect(item.candidate.source_url)"
            />
            <span class="cand-company">{{ item.candidate.company }}</span>
            <span class="cand-title">{{ item.candidate.title || '（无岗位名）' }}</span>
            <span class="pill" :class="item.action === 'new' ? 'pill-app-new' : 'pill-app-upd'">
              {{ item.action === 'new' ? '新增' : '更新' }}
            </span>
            <span v-for="mf in item.missingFields" :key="mf" class="pill pill-missing">
              {{ MISSING_LABELS[mf] ?? mf }}
            </span>
            <span class="meta">{{ item.candidate.recruit_season ?? '—' }}</span>
            <span class="meta">截止：{{ item.candidate.end_date ?? '待核实' }}</span>
          </li>
        </ul>
        <div class="preview-actions">
          <button class="btn btn-primary" type="button" :disabled="importing || selectedUrls.size === 0" @click="confirmImport">
            {{ importing ? '导入中…' : `确认导入（${selectedUrls.size} 条）` }}
          </button>
        </div>
      </div>
    </section>

    <!-- 留痕列表 -->
    <section class="card">
      <h2 class="card-title">采集留痕 <span class="count">{{ crawlRuns.length }}</span></h2>
      <p v-if="runsError" class="message error">{{ runsError }}</p>
      <ul v-if="crawlRuns.length > 0" class="run-list">
        <li v-for="r in crawlRuns" :key="r.id" class="run-row">
          <span class="pill" :class="`run-${r.status}`">{{ CRAWL_RUN_STATUS_LABELS[r.status] }}</span>
          <span class="meta">{{ SOURCE_LABELS[r.source] }}</span>
          <span class="meta">{{ r.mode === 'full' ? '全量' : `筛选：${r.filter ?? ''}` }}</span>
          <span class="meta">候选 {{ r.candidate_count }} 条</span>
          <span v-if="r.truncated" class="pill pill-missing">达上限截断</span>
          <span class="meta">{{ fmtRunTime(r.created_at) }}</span>
          <button class="btn" type="button" @click="viewRun(r.id)">查看预览</button>
        </li>
      </ul>
      <p v-else class="hint">暂无采集记录。</p>
    </section>

    <section class="card">
      <h2 class="card-title">手动录入职位卡</h2>

      <form class="form" @submit.prevent="submit">
        <div class="form-grid">
          <label class="field">
            <span class="label">公司 <em class="required">*</em></span>
            <input ref="companyInput" v-model="form.company" class="input" placeholder="如：腾讯" />
          </label>
          <label class="field">
            <span class="label">岗位 <em class="required">*</em></span>
            <input v-model="form.title" class="input" placeholder="如：前端开发工程师" />
          </label>
          <label class="field">
            <span class="label">企业性质</span>
            <select v-model="form.company_type" class="input">
              <option v-for="t in COMPANY_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
          <label class="field">
            <span class="label">秋招季</span>
            <input v-model="form.recruit_season" class="input" placeholder="如：2026秋招" />
          </label>
          <label class="field">
            <span class="label">城市</span>
            <input v-model="form.city" class="input" placeholder="如：深圳" />
          </label>
          <label class="field">
            <span class="label">批次</span>
            <select v-model="form.batch" class="input">
              <option value="">未指定</option>
              <option v-for="b in BATCHES" :key="b" :value="b">{{ b }}</option>
            </select>
          </label>
          <label class="field">
            <span class="label">投递渠道</span>
            <input v-model="form.channel" class="input" placeholder="官网 / 牛客 / 猎聘 / 邮箱 / 内推…" />
          </label>
          <label class="field">
            <span class="label">渠道链接</span>
            <input v-model="form.channel_url" class="input" placeholder="https://…" />
          </label>
          <label class="field">
            <span class="label">网申开始</span>
            <input v-model="form.start_date" class="input" type="date" />
          </label>
          <label class="field">
            <span class="label">网申截止</span>
            <input v-model="form.end_date" class="input" type="date" />
          </label>
          <label class="field field-wide">
            <span class="label">JD</span>
            <textarea v-model="form.jd" class="input textarea" rows="4" placeholder="职位描述全文…" />
          </label>
          <label class="field field-wide">
            <span class="label">备注</span>
            <textarea v-model="form.notes" class="input textarea" rows="2" placeholder="选填" />
          </label>
        </div>

        <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>
        <p v-if="successMessage" class="message success">{{ successMessage }}</p>

        <button class="btn btn-primary" type="submit" :disabled="submitting">
          {{ submitting ? '录入中…' : '录入职位卡' }}
        </button>
      </form>
    </section>

    <section class="card">
      <h2 class="card-title">职位列表 <span class="count">{{ positions.length }}</span></h2>

      <div class="filters">
        <label class="filter">
          <span class="label">企业性质</span>
          <select v-model="filters.company_type" class="input">
            <option value="">全部</option>
            <option v-for="t in COMPANY_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="filter">
          <span class="label">批次</span>
          <select v-model="filters.batch" class="input">
            <option value="">全部</option>
            <option v-for="b in BATCHES" :key="b" :value="b">{{ b }}</option>
          </select>
        </label>
        <label class="filter">
          <span class="label">状态</span>
          <select v-model="filters.status" class="input">
            <option value="">全部</option>
            <option value="active">进行中</option>
            <option value="closed">已关闭</option>
          </select>
        </label>
        <label class="filter">
          <span class="label">秋招季</span>
          <select v-model="filters.recruit_season" class="input">
            <option value="">全部</option>
            <option v-for="s in seasons" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="filter">
          <span class="label">投递状态</span>
          <select v-model="filters.application_status" class="input">
            <option value="">全部</option>
            <option v-for="s in APPLICATION_STATUSES" :key="s" :value="s">{{ APPLICATION_STATUS_LABELS[s] }}</option>
          </select>
        </label>
        <button
          v-if="hasFilters"
          class="btn btn-ghost"
          type="button"
          @click="clearFilters"
        >
          清空筛选
        </button>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <div v-else-if="positions.length === 0" class="empty-state">
        <template v-if="hasFilters">
          <p class="hint">没有符合条件的职位卡，试试调整或清空筛选。</p>
          <button class="btn btn-ghost" type="button" @click="clearFilters">清空筛选</button>
        </template>
        <template v-else>
          <p class="hint">
            暂无职位卡——录入第一条后即在此可见，并按企业性质/批次/状态/秋招季/投递状态筛选；
            网申截止 ≤14 天会标红提醒，无截止日期显示「待核实」。
          </p>
          <button class="btn btn-primary" type="button" @click="focusEntryForm">录入第一条职位卡</button>
        </template>
      </div>
      <ul v-else class="position-list">
        <li v-for="p in positions" :key="p.id" class="position-row" @click="router.push(`/jobs/${p.id}`)">
          <span class="company">{{ p.company }}</span>
          <span class="title">{{ p.title }}</span>
          <span :class="badgeClass(p.days_left)">{{ badgeText(p.days_left) }}</span>
          <span class="pill">{{ p.company_type }}</span>
          <span v-if="p.batch" class="pill pill-batch">{{ p.batch }}</span>
          <span v-if="p.city" class="meta">{{ p.city }}</span>
          <span class="pill" :class="p.status === 'active' ? 'pill-active' : 'pill-closed'">
            {{ p.status === 'active' ? '进行中' : '已关闭' }}
          </span>
          <span v-if="p.application_status" class="pill" :class="`pill-app-${p.application_status}`">
            {{ APPLICATION_STATUS_LABELS[p.application_status] }}
          </span>
          <span class="meta">
            网申：{{ p.start_date ?? '—' }} ~ {{ p.end_date ?? '待核实' }}
          </span>
          <span class="row-action">详情 ›</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.jobs-view {
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

.card-title {
  margin: 0 0 12px;
  font-size: 15px;
}

.count {
  margin-left: 4px;
  color: #6b7280;
  font-weight: 400;
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

.btn-primary {
  background: #2b5ca8;
  border-color: #2b5ca8;
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: #244e8f;
}

.position-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.position-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f1f3;
  cursor: pointer;
}

.position-row:hover {
  background: #fafbfc;
}

.position-row:last-child {
  border-bottom: none;
}

.row-action {
  margin-left: auto;
  color: #2b5ca8;
  font-size: 12px;
  white-space: nowrap;
}

.company {
  font-weight: 600;
}

.title {
  margin-right: 4px;
}

.pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
  white-space: nowrap;
}

.pill-batch {
  background: #f3f4f6;
  color: #374151;
}

.pill-active {
  background: #ecfdf5;
  color: #059669;
}

.pill-closed {
  background: #f3f4f6;
  color: #6b7280;
}

/* 投递状态徽标（F-05/#21：列表筛选联动可见） */
.pill-app-planned {
  background: #f3f4f6;
  color: #6b7280;
}

.pill-app-applied {
  background: #eff6ff;
  color: #1d4ed8;
}

.pill-app-interviewing {
  background: #fef3c7;
  color: #b45309;
}

.pill-app-offer {
  background: #ecfdf5;
  color: #059669;
}

.pill-app-rejected {
  background: #fee2e2;
  color: #dc2626;
}

.pill-app-withdrawn {
  background: #f3f4f6;
  color: #6b7280;
}

.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

/* 倒计时徽标：≤14 天（含已截止）红（DESIGN.md 组件清单） */
.badge-urgent {
  background: #fee2e2;
  color: #dc2626;
}

.badge-normal {
  background: #eff6ff;
  color: #1d4ed8;
}

/* 无 end_date → 「待核实」灰 */
.badge-unknown {
  background: #f3f4f6;
  color: #6b7280;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f1f3;
}

/* 采集（F-11/#29） */
.hint-inline {
  margin-left: 8px;
  color: #6b7280;
  font-weight: 400;
  font-size: 12px;
}

.crawl-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.preview {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f1f3;
}

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.preview-stats {
  font-size: 13px;
  color: #374151;
}

.num-new {
  color: #059669;
}

.num-upd {
  color: #1d4ed8;
}

.num-miss {
  color: #b45309;
}

.select-all {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #374151;
}

.candidate-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.candidate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f1f3;
  font-size: 13px;
}

.candidate-row:last-child {
  border-bottom: none;
}

.cand-company {
  font-weight: 600;
}

.pill-app-new {
  background: #ecfdf5;
  color: #059669;
}

.pill-app-upd {
  background: #eff6ff;
  color: #1d4ed8;
}

.pill-missing {
  background: #fef3c7;
  color: #b45309;
}

.preview-actions {
  margin-top: 10px;
}

.run-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f1f3;
  font-size: 13px;
}

.run-row:last-child {
  border-bottom: none;
}

.run-success {
  background: #ecfdf5;
  color: #059669;
}

.run-partial {
  background: #fef3c7;
  color: #b45309;
}

.run-failed {
  background: #fee2e2;
  color: #dc2626;
}

.run-running {
  background: #eff6ff;
  color: #1d4ed8;
}

.filter {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 0;
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

.btn-ghost {
  border-color: transparent;
  background: transparent;
  color: #2b5ca8;
}

.btn-ghost:hover {
  background: #f3f6fb;
}

.meta {
  color: #6b7280;
  font-size: 12px;
}

.hint {
  margin: 0;
  color: #6b7280;
  line-height: 1.7;
}
</style>
