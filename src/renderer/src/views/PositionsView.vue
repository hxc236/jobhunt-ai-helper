<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  BATCHES,
  BOSS_CITIES,
  BOSS_SALARY_RANGES,
  COMPANY_TYPES,
  CRAWL_MODES,
  HIRE_TYPES,
  type ApplicationStatus,
  type Batch,
  type CompanyType,
  type CrawlConditions,
  type CrawlMode,
  type CrawlPreset,
  type CrawlPreview,
  type CrawlRun,
  type HireType,
  type Position,
  type PositionInput,
  type PositionListItem,
  type PositionSource,
  type PositionStatus
} from '@shared/types'
import { IpcEvent } from '@shared/protocol'
import PositionDetailView from './PositionDetailView.vue'
import Resizer from '../components/Resizer.vue'
import Modal from '../components/Modal.vue'
import CountdownBadge from '../components/CountdownBadge.vue'
import Pill from '../components/Pill.vue'
import Icon from '../components/Icon.vue'

/** 职位模块（#42 T2）：双栏 = 列表（筛选/搜索/行）+ 详情列；录入/采集走弹窗。 */

/* ---------- 采集（F-11/#29） ---------- */
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

/* ---------- BOSS 采集条件 + 常用采集（issue #57） ---------- */
const bossConditions = reactive<{
  hire_type: HireType
  keyword: string
  city: string
  salary: string
  companyKeyword: string
}>({
  hire_type: '社招',
  keyword: '',
  city: '',
  salary: '0',
  companyKeyword: ''
})
const presets = ref<CrawlPreset[]>([])
const presetName = ref('')
const presetMessage = ref('')

/** 当前 BOSS 条件摘要（预览/留痕展示用）。 */
function bossConditionsSummary(c: CrawlConditions | null | undefined): string {
  if (c === null || c === undefined) return ''
  const parts: string[] = [c.hire_type ?? '']
  if (c.keyword) parts.push(c.keyword)
  if (c.city) parts.push(BOSS_CITIES.find((x) => x.code === c.city)?.name ?? c.city)
  if (c.salary && c.salary !== '0') parts.push(BOSS_SALARY_RANGES.find((x) => x.code === c.salary)?.label ?? c.salary)
  return parts.filter(Boolean).join(' · ')
}

async function loadPresets(): Promise<void> {
  try {
    presets.value = await window.api.crawls.crawlPresets.list()
  } catch {
    presets.value = []
  }
}

async function savePreset(): Promise<void> {
  presetMessage.value = ''
  try {
    await window.api.crawls.crawlPresets.create(presetName.value, {
      hire_type: bossConditions.hire_type,
      keyword: bossConditions.keyword || undefined,
      city: bossConditions.city || undefined,
      salary: bossConditions.salary === '0' ? undefined : bossConditions.salary
    })
    presetName.value = ''
    presetMessage.value = '已保存'
    await loadPresets()
  } catch (err) {
    presetMessage.value = String(err)
  }
}

function applyPreset(p: CrawlPreset): void {
  bossConditions.hire_type = p.conditions.hire_type ?? '校招'
  bossConditions.keyword = p.conditions.keyword ?? ''
  bossConditions.city = p.conditions.city ?? ''
  bossConditions.salary = p.conditions.salary ?? '0'
  presetMessage.value = ''
}

async function removePreset(id: number): Promise<void> {
  await window.api.crawls.crawlPresets.delete(id)
  await loadPresets()
}

const SOURCE_LABELS: Record<PositionSource, string> = {
  manual: '手动',
  nowcoder: '牛客校招日程',
  liepin: '猎聘校招',
  boss: 'BOSS直聘'
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
    const result =
      crawlSource.value === 'boss'
        ? await window.api.crawls.run(crawlSource.value, {
            mode: 'full',
            hire_type: bossConditions.hire_type,
            keyword: bossConditions.keyword || undefined,
            city: bossConditions.city || undefined,
            salary: bossConditions.salary === '0' ? undefined : bossConditions.salary,
            filter: bossConditions.companyKeyword || undefined
          })
        : await window.api.crawls.run(crawlSource.value, {
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

/* ---------- BOSS 登录态（issue #51） ---------- */
const bossLoginStatus = ref(false)
const bossLoginChecking = ref(false)

async function checkBossLogin(): Promise<void> {
  bossLoginChecking.value = true
  try {
    bossLoginStatus.value = await window.api.crawls.bossLogin.status()
  } finally {
    bossLoginChecking.value = false
  }
}

async function openBossLogin(): Promise<void> {
  // 只开可见窗口，不再紧随隐藏窗口检测（issue #62）：一次点击两次导航，
  // 是隐性 BOSS 请求；登录态显示以「刷新状态」手动为准
  await window.api.crawls.bossLogin.open()
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
    preview.value = await window.api.crawls.preview(preview.value.run.id)
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

/* ---------- 表单态 ---------- */
type PositionFormState = Omit<PositionInput, 'batch' | 'hire_type' | 'salary_min' | 'salary_max' | 'salary_text'> & {
  batch: Batch | ''
  hire_type: HireType
  salary_min: string
  salary_max: string
  salary_text: string
}

function emptyForm(): PositionFormState {
  return {
    company: '',
    company_type: '其他',
    title: '',
    jd: '',
    city: '',
    channel: '',
    channel_url: '',
    hire_type: '校招',
    recruit_season: '2026秋招',
    salary_min: '',
    salary_max: '',
    salary_text: '',
    batch: '',
    start_date: '',
    end_date: '',
    notes: ''
  }
}

const form = reactive<PositionFormState>(emptyForm())
const submitting = ref(false)
const formError = ref('')
const formSuccess = ref('')

async function submit(): Promise<void> {
  formError.value = ''
  formSuccess.value = ''
  if (form.company.trim() === '' || form.title.trim() === '') {
    formError.value = '公司与岗位为必填项'
    return
  }
  submitting.value = true
  try {
    await window.api.positions.create({
      ...form,
      company: form.company.trim(),
      title: form.title.trim(),
      batch: form.batch === '' ? undefined : form.batch,
      salary_min: form.salary_min === '' ? undefined : Number(form.salary_min),
      salary_max: form.salary_max === '' ? undefined : Number(form.salary_max),
      salary_text: form.salary_text.trim() || undefined
    })
    formSuccess.value = `已录入「${form.company} · ${form.title}」`
    Object.assign(form, emptyForm())
    addOpen.value = false
    await refresh()
  } catch (err) {
    formError.value = String(err)
  } finally {
    submitting.value = false
  }
}

/* ---------- 筛选（issue #58：+ 招聘类型/薪资下限） ---------- */
type FilterState = {
  company_type: CompanyType | ''
  batch: Batch | ''
  status: PositionStatus | ''
  recruit_season: string
  application_status: ApplicationStatus | ''
  hire_type: HireType | ''
  salary_min: string
}

function emptyFilters(): FilterState {
  return {
    company_type: '',
    batch: '',
    status: '',
    recruit_season: '',
    application_status: '',
    hire_type: '',
    salary_min: ''
  }
}

const filters = reactive<FilterState>(emptyFilters())
const searchQ = ref('')

/** pill 组定义：key → 选项（'' = 全部）。 */
const filterGroups: Array<{
  key: keyof FilterState
  label: string
  options: Array<{ value: string; label: string }>
}> = [
  {
    key: 'company_type',
    label: '性质',
    options: [{ value: '', label: '全部' }, ...COMPANY_TYPES.map((t) => ({ value: t, label: t }))]
  },
  {
    key: 'batch',
    label: '批次',
    options: [{ value: '', label: '全部' }, ...BATCHES.map((b) => ({ value: b, label: b }))]
  },
  {
    key: 'hire_type',
    label: '招聘',
    options: [{ value: '', label: '全部' }, ...HIRE_TYPES.map((h) => ({ value: h, label: h }))]
  },
  {
    key: 'status',
    label: '卡片',
    options: [
      { value: '', label: '全部' },
      { value: 'active', label: '进行中' },
      { value: 'closed', label: '已关闭' }
    ]
  },
  {
    key: 'application_status',
    label: '状态',
    options: [
      { value: '', label: '全部' },
      ...APPLICATION_STATUSES.map((s) => ({ value: s, label: APPLICATION_STATUS_LABELS[s] }))
    ]
  }
]

const positions = ref<PositionListItem[]>([])
const allPositions = ref<Position[]>([])
const seasons = computed(() => [...new Set(allPositions.value.map((p) => p.recruit_season))])
const loading = ref(false)
const listError = ref('')

const hasFilters = computed(
  () =>
    filters.company_type !== '' ||
    filters.batch !== '' ||
    filters.status !== '' ||
    filters.recruit_season !== '' ||
    filters.application_status !== '' ||
    filters.hire_type !== '' ||
    filters.salary_min !== '' ||
    searchQ.value !== ''
)

/** 服务端五维筛选结果 + 客户端搜索（公司/岗位）收窄。 */
const filteredPositions = computed(() => {
  const q = searchQ.value.trim().toLowerCase()
  if (q === '') return positions.value
  return positions.value.filter(
    (p) => p.company.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
  )
})

async function loadPositions(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    positions.value = await window.api.positions.list({
      company_type: filters.company_type || undefined,
      batch: filters.batch || undefined,
      status: filters.status || undefined,
      recruit_season: filters.recruit_season || undefined,
      application_status: filters.application_status || undefined,
      hire_type: filters.hire_type || undefined,
      salary_min: filters.salary_min === '' ? undefined : Number(filters.salary_min)
    })
  } catch (err) {
    listError.value = `加载职位列表失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  await Promise.all([
    loadPositions(),
    window.api.positions.list().then(
      (rows) => (allPositions.value = rows),
      () => {}
    )
  ])
  // 顶栏统计联动（#42 T1：Topbar 监听此事件刷新）
  window.dispatchEvent(new CustomEvent('jobhunt:positions-changed'))
}

function clearFilters(): void {
  Object.assign(filters, emptyFilters())
  searchQ.value = ''
}

watch(
  [
    () => filters.company_type,
    () => filters.batch,
    () => filters.status,
    () => filters.recruit_season,
    () => filters.application_status,
    () => filters.hire_type,
    () => filters.salary_min
  ],
  () => void loadPositions()
)

/* ---------- 选中态（详情列） ---------- */
const selectedId = ref('')

/** 详情列数据变更（删除/编辑/投递状态/优化等）后刷新列表。 */
function onDetailChanged(): void {
  void refresh()
}

/** 列表行选中：优先保持当前选中，失效时回落到第一行。 */
watch(
  [filteredPositions],
  () => {
    if (selectedId.value !== '' && filteredPositions.value.some((p) => p.id === selectedId.value)) return
    selectedId.value = filteredPositions.value[0]?.id ?? ''
  },
  { immediate: true }
)

function selectRow(id: string): void {
  selectedId.value = id
}

function onRowKeydown(e: KeyboardEvent, id: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    selectRow(id)
  }
}

/** 投递状态 pill 色调：面试中/offer 高亮，未投递/放弃/拒绝弱化。 */
function appStatusTone(status: ApplicationStatus | null): '' | 'tint' | 'ghost' {
  if (status === null) return 'ghost'
  if (status === 'interviewing' || status === 'offer') return 'tint'
  if (status === 'applied') return ''
  return 'ghost'
}

function endLabel(p: Pick<PositionListItem, 'end_date' | 'hire_type'>): string {
  if (p.end_date === null) {
    // issue #58：社招/实习无网申窗口 → 长期有效；校招无截止 → 待核实
    return p.hire_type === '校招' ? '待核实' : '长期'
  }
  return `截止 ${p.end_date.slice(5)}`
}

/* ---------- 弹窗开关 ---------- */
const addOpen = ref(false)
const crawlOpen = ref(false)

function openAdd(): void {
  formError.value = ''
  formSuccess.value = ''
  addOpen.value = true
}

function openCrawl(): void {
  crawlError.value = ''
  importMessage.value = ''
  crawlOpen.value = true
  void loadPresets()
  // 不在弹窗打开时自动检测 BOSS 登录态（issue #62）：隐藏窗口加载搜索页
  // 是隐性 BOSS 请求，会喂养风控累积评分；需检查时点「刷新状态」
}

onMounted(() => {
  void refresh()
  void loadRuns()
  const unsubscribe = window.api.on(IpcEvent.CrawlProgress, (payload) => {
    crawlProgress.value = { done: payload.done, total: payload.total }
  })
  onUnmounted(unsubscribe)
})
</script>

<template>
  <section class="view cols">
    <!-- ===== 列表列 ===== -->
    <div class="col">
      <div class="col-head">
        <div>
          <div class="col-title">职位</div>
          <div class="col-count">显示 {{ filteredPositions.length }} / {{ allPositions.length }}</div>
        </div>
        <div class="head-actions">
          <button class="btn" type="button" @click="openCrawl">
            <Icon name="refresh" />采集
          </button>
          <button class="btn primary" type="button" @click="openAdd">
            <Icon name="plus" />录入
          </button>
        </div>
      </div>

      <div class="search">
        <Icon name="search" />
        <input v-model="searchQ" placeholder="搜索公司 / 岗位" aria-label="搜索公司 / 岗位" />
      </div>

      <div v-for="group in filterGroups" :key="group.key" class="fgroup">
        <span class="f-label">{{ group.label }}</span>
        <div class="f-pills">
          <button
            v-for="opt in group.options"
            :key="opt.value"
            class="fpill"
            :class="{ active: filters[group.key] === opt.value }"
            type="button"
            @click="filters[group.key] = opt.value as never"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div v-if="seasons.length > 0" class="fgroup">
        <span class="f-label">季</span>
        <div class="f-pills">
          <button class="fpill" :class="{ active: filters.recruit_season === '' }" type="button" @click="filters.recruit_season = ''">
            全部
          </button>
          <button
            v-for="s in seasons"
            :key="s"
            class="fpill"
            :class="{ active: filters.recruit_season === s }"
            type="button"
            @click="filters.recruit_season = s"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <div class="fgroup">
        <span class="f-label">薪资</span>
        <div class="f-pills">
          <input
            v-model="filters.salary_min"
            class="salary-input"
            type="number"
            min="1"
            placeholder="下限 K/月"
            style="width: 96px"
          />
          <span class="hint">区间匹配（如填 20 → 薪资区间覆盖 20K 的职位）</span>
        </div>
      </div>

      <p v-if="listError" class="empty">{{ listError }}</p>
      <p v-else-if="loading" class="empty">加载中…</p>

      <div v-else-if="filteredPositions.length === 0" class="empty">
        <template v-if="hasFilters">
          <p>没有符合条件的职位卡</p>
          <button class="link" type="button" style="margin-top: 6px" @click="clearFilters">清空筛选</button>
        </template>
        <template v-else>
          <p>暂无职位卡——录入第一条或采集导入后即在此可见。</p>
          <button class="btn primary" type="button" style="margin-top: 10px" @click="openAdd">录入第一条职位卡</button>
        </template>
      </div>

      <div v-else class="pos-list">
        <div
          v-for="p in filteredPositions"
          :key="p.id"
          class="pos-row"
          :class="{ active: p.id === selectedId }"
          tabindex="0"
          role="button"
          @click="selectRow(p.id)"
          @keydown="onRowKeydown($event, p.id)"
        >
          <div class="pr-main">
            <span class="pr-company">{{ p.company }}</span>
            <CountdownBadge :days-left="p.days_left" />
          </div>
          <div class="pr-title">{{ p.title }}</div>
          <div class="pr-meta">
            <Pill>{{ p.company_type }}</Pill>
            <Pill v-if="p.hire_type" :tone="p.hire_type === '校招' ? '' : 'tint'">{{ p.hire_type }}</Pill>
            <span v-if="p.salary_text" class="pr-salary">{{ p.salary_text }}</span>
            <span v-if="p.city" class="pr-city">{{ p.city }}</span>
            <Pill v-if="p.batch">{{ p.batch }}</Pill>
          </div>
          <div class="pr-foot">
            <Pill :tone="appStatusTone(p.application_status)">
              {{ p.application_status ? APPLICATION_STATUS_LABELS[p.application_status] : '未开始' }}
            </Pill>
            <span class="pr-date">{{ endLabel(p) }}</span>
          </div>
        </div>
      </div>
    </div>

    <Resizer mode="col" />

    <!-- ===== 详情列 ===== -->
    <PositionDetailView
      v-if="selectedId !== ''"
      :position-id="selectedId"
      @changed="onDetailChanged"
    />
    <div v-else class="detail">
      <div class="empty">从左侧选择一条职位卡查看详情</div>
    </div>
  </section>

  <!-- ===== 弹窗：手动录入 ===== -->
  <Modal :open="addOpen" title="手动录入职位卡" @close="addOpen = false">
    <form class="form-grid" @submit.prevent="submit">
      <label class="field">
        <span class="label">公司 <em class="required">*</em></span>
        <input v-model="form.company" placeholder="例如：招商银行" />
      </label>
      <label class="field">
        <span class="label">岗位 <em class="required">*</em></span>
        <input v-model="form.title" placeholder="例如：软件开发工程师" />
      </label>
      <label class="field">
        <span class="label">企业性质</span>
        <select v-model="form.company_type">
          <option v-for="t in COMPANY_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </label>
      <label class="field">
        <span class="label">招聘类型</span>
        <select v-model="form.hire_type">
          <option v-for="h in HIRE_TYPES" :key="h" :value="h">{{ h }}</option>
        </select>
      </label>
      <label v-if="form.hire_type === '校招'" class="field">
        <span class="label">秋招季 <em class="required">*</em></span>
        <input v-model="form.recruit_season" placeholder="如：2026秋招" />
      </label>
      <label v-else class="field">
        <span class="label">秋招季</span>
        <input :value="'社招/实习无网申窗口'" disabled />
      </label>
      <label class="field">
        <span class="label">薪资下限（K/月）</span>
        <input v-model="form.salary_min" type="number" min="1" placeholder="如：20" />
      </label>
      <label class="field">
        <span class="label">薪资上限（K/月）</span>
        <input v-model="form.salary_max" type="number" min="1" placeholder="如：40" />
      </label>
      <label class="field span2">
        <span class="label">薪资原文本</span>
        <input v-model="form.salary_text" placeholder="如：20-40K·14薪（展示用）" />
      </label>
      <label class="field">
        <span class="label">城市</span>
        <input v-model="form.city" placeholder="例如：杭州" />
      </label>
      <label class="field">
        <span class="label">批次</span>
        <select v-model="form.batch">
          <option value="">未指定</option>
          <option v-for="b in BATCHES" :key="b" :value="b">{{ b }}</option>
        </select>
      </label>
      <label class="field">
        <span class="label">投递渠道</span>
        <input v-model="form.channel" placeholder="官网 / 牛客 / 猎聘 / 邮箱 / 内推…" />
      </label>
      <label class="field">
        <span class="label">渠道链接</span>
        <input v-model="form.channel_url" placeholder="https://…" />
      </label>
      <label class="field">
        <span class="label">网申开始</span>
        <input v-model="form.start_date" type="date" />
      </label>
      <label class="field">
        <span class="label">网申截止</span>
        <input v-model="form.end_date" type="date" />
      </label>
      <label class="field span2">
        <span class="label">JD 全文</span>
        <textarea v-model="form.jd" rows="6" placeholder="粘贴职位描述…" />
      </label>
      <label class="field span2">
        <span class="label">备注</span>
        <textarea v-model="form.notes" rows="2" placeholder="选填" />
      </label>
    </form>
    <p v-if="formError" class="empty" style="margin-top: 12px">{{ formError }}</p>
    <p v-if="formSuccess" class="empty" style="margin-top: 12px">{{ formSuccess }}</p>

    <template #foot>
      <span class="note">带 * 为必填 · 保存后进入「未投递」状态</span>
      <button class="btn" type="button" @click="addOpen = false">取消</button>
      <button class="btn primary" type="button" :disabled="submitting" @click="submit">
        {{ submitting ? '保存中…' : '保存职位卡' }}
      </button>
    </template>
  </Modal>

  <!-- ===== 弹窗：采集 ===== -->
  <Modal :open="crawlOpen" :title="`采集职位 · ${SOURCE_LABELS[crawlSource]}`" @close="crawlOpen = false">
    <div class="crawl-bar">
      <label class="field" style="flex: 1">
        <span class="label">来源</span>
        <select v-model="crawlSource" :disabled="crawling">
          <option value="nowcoder">牛客校招日程</option>
          <option value="liepin">猎聘校招</option>
          <option value="boss">BOSS直聘</option>
        </select>
      </label>
      <label v-if="crawlSource !== 'boss'" class="field" style="flex: 1">
        <span class="label">模式</span>
        <select v-model="crawlMode" :disabled="crawling">
          <option v-for="m in CRAWL_MODES" :key="m" :value="m">
            {{ m === 'full' ? '全量' : '关键词筛选' }}
          </option>
        </select>
      </label>
      <label v-if="crawlSource !== 'boss' && crawlMode === 'filter'" class="field" style="flex: 1">
        <span class="label">关键词（公司名）</span>
        <input v-model="crawlKeyword" placeholder="如：腾讯" :disabled="crawling" />
      </label>
      <button
        v-if="crawlSource !== 'boss'"
        class="btn primary"
        type="button"
        :disabled="crawling"
        style="align-self: flex-end"
        @click="startCrawl"
      >
        {{ crawling ? '采集中…' : '开始采集' }}
      </button>
      <!-- issue #62：BOSS 自动采集会触发风控，已停用；改人工浏览 + F8 提取 -->
      <button
        v-else
        class="btn primary"
        type="button"
        disabled
        style="align-self: flex-end"
        title="BOSS 自动采集会触发风控，已停用"
      >
        人工浏览提取（详情页按 F8）
      </button>
    </div>
    <!-- issue #51：BOSS 登录态（薪资可见性前提）——扫码登录 + 状态检测 -->
    <div v-if="crawlSource === 'boss'" class="crawl-boss-login">
      <span class="hint">
        BOSS 采集需登录后薪资才可见（匿名会话薪资为空）。登录态持久化，重启不丢。
      </span>
      <div style="display: flex; gap: 8px; align-items: center">
        <button
          class="btn"
          type="button"
          :disabled="bossLoginChecking"
          @click="openBossLogin"
        >
          {{ bossLoginStatus ? '已登录' : '未登录' }}
        </button>
        <button class="btn ghost" type="button" :disabled="bossLoginChecking" @click="checkBossLogin">
          {{ bossLoginChecking ? '检测中…' : '刷新状态' }}
        </button>
      </div>
    </div>

    <!-- issue #57：BOSS 采集条件（招聘类型/岗位关键词/城市/薪资/公司名可选） -->
    <div v-if="crawlSource === 'boss'" class="crawl-conditions">
      <label class="field" style="flex: 1">
        <span class="label">招聘类型</span>
        <select v-model="bossConditions.hire_type" :disabled="crawling">
          <option v-for="h in HIRE_TYPES" :key="h" :value="h">{{ h }}</option>
        </select>
      </label>
      <label class="field" style="flex: 2">
        <span class="label">岗位关键词</span>
        <input v-model="bossConditions.keyword" placeholder="如：前端" :disabled="crawling" />
      </label>
      <label class="field" style="flex: 1">
        <span class="label">城市</span>
        <select v-model="bossConditions.city" :disabled="crawling">
          <option value="">不限</option>
          <option v-for="c in BOSS_CITIES" :key="c.code" :value="c.code">{{ c.name }}</option>
        </select>
      </label>
      <label class="field" style="flex: 1">
        <span class="label">薪资</span>
        <select v-model="bossConditions.salary" :disabled="crawling">
          <option v-for="s in BOSS_SALARY_RANGES" :key="s.code" :value="s.code">{{ s.label }}</option>
        </select>
      </label>
      <label class="field" style="flex: 1">
        <span class="label">公司名（可选）</span>
        <input v-model="bossConditions.companyKeyword" placeholder="如：字节" :disabled="crawling" />
      </label>
    </div>

    <!-- issue #57：常用采集（保存/复用/删除） -->
    <div v-if="crawlSource === 'boss'" class="crawl-presets">
      <div style="display: flex; gap: 8px; align-items: center">
        <input
          v-model="presetName"
          placeholder="保存当前条件为常用采集，如：上海前端20K以上"
          :disabled="crawling"
          style="flex: 1"
          @keyup.enter="savePreset"
        />
        <button class="btn" type="button" :disabled="crawling || presetName.trim() === ''" @click="savePreset">
          保存
        </button>
        <span v-if="presetMessage" class="hint">{{ presetMessage }}</span>
      </div>
      <div v-if="presets.length > 0" class="preset-list">
        <span v-for="p in presets" :key="p.id" class="pill">
          {{ p.name }}
          <button type="button" class="link" @click="applyPreset(p)">复用</button>
          <button type="button" class="link danger" @click="removePreset(p.id)">删除</button>
        </span>
      </div>
    </div>
    <p v-if="crawlProgress" class="hint">
      抓取中 {{ crawlProgress.done }}/{{ crawlProgress.total }}（每次请求间隔 ≥30s，失败自动重试）…
    </p>
    <p v-if="crawlError" class="empty" style="margin-top: 10px">{{ crawlError }}</p>
    <p v-if="importMessage" class="empty" style="margin-top: 10px">{{ importMessage }}</p>

    <template v-if="preview">
      <div class="crawl-summary">
        <span>将新增 <b style="color: var(--fg)">{{ preview.stats.inserted }}</b> 条</span>
        <span>·</span>
        <span>更新 <b style="color: var(--fg)">{{ preview.stats.updated }}</b> 条</span>
        <span>·</span>
        <span>缺字段 <b style="color: var(--fg)">{{ preview.stats.missing }}</b> 处</span>
        <span style="flex: 1"></span>
        <span v-if="crawlSource === 'boss'" class="hint">
          条件：{{ bossConditionsSummary({ hire_type: bossConditions.hire_type, keyword: bossConditions.keyword || undefined, city: bossConditions.city || undefined, salary: bossConditions.salary === '0' ? undefined : bossConditions.salary }) }} · 冷却 30s
        </span>
        <span v-else>模式：{{ crawlMode === 'full' ? '全量拉取当季' : `筛选 ${crawlKeyword || '—'}` }} · 节流 2s</span>
      </div>

      <label class="select-all">
        <input
          type="checkbox"
          :checked="selectedUrls.size === preview.items.length && preview.items.length > 0"
          @change="toggleAll(($event.target as HTMLInputElement).checked)"
        />
        全选（{{ selectedUrls.size }}/{{ preview.items.length }}）
      </label>

      <div v-for="item in preview.items" :key="item.candidate.source_url" class="crawl-item">
        <input
          type="checkbox"
          :checked="selectedUrls.has(item.candidate.source_url)"
          @change="toggleSelect(item.candidate.source_url)"
        />
        <div class="ci-main">
          <div class="ci-title">
            {{ item.candidate.company }} · {{ item.candidate.title || '（无岗位名）' }}
          </div>
          <div class="ci-meta">
            {{ item.candidate.city ?? '—' }} ·
            {{ item.candidate.batch ?? '—' }} ·
            {{ item.candidate.end_date ? `截止 ${item.candidate.end_date.slice(5)}` : '截止待核实' }}
            <Pill :tone="item.action === 'new' ? '' : 'tint'">
              {{ item.action === 'new' ? '新增' : '更新' }}
            </Pill>
          </div>
          <div class="ci-tags">
            <span v-for="mf in item.missingFields" :key="mf" class="pill ghost">
              {{ MISSING_LABELS[mf] ?? mf }}
            </span>
            <span class="pill ghost">{{ item.candidate.recruit_season ?? '—' }}</span>
          </div>
        </div>
      </div>
    </template>

    <template v-if="crawlRuns.length > 0">
      <div class="rgroup-title"><span>采集留痕</span><span>{{ crawlRuns.length }} 次</span></div>
      <div v-for="r in crawlRuns" :key="r.id" class="run-row">
        <span class="pill" :class="`run-${r.status}`">{{ CRAWL_RUN_STATUS_LABELS[r.status] }}</span>
        <span class="pr-city">{{ SOURCE_LABELS[r.source] }}</span>
        <span v-if="r.source === 'boss'" class="pr-city">{{ bossConditionsSummary(r.conditions) || '默认条件' }}</span>
        <span v-else class="pr-city">{{ r.mode === 'full' ? '全量' : `筛选：${r.filter ?? ''}` }}</span>
        <span class="pr-city">候选 {{ r.candidate_count }} 条</span>
        <span v-if="r.truncated" class="pill ghost">达上限截断</span>
        <span class="pr-city" style="margin-left: auto">{{ fmtRunTime(r.created_at) }}</span>
        <button class="link" type="button" @click="viewRun(r.id)">查看预览</button>
      </div>
    </template>

    <template #foot>
      <span class="note">
        {{ preview ? `本次抓取 ${preview.items.length} 条` : '最近一次采集结果将在此预览确认后入库' }}
      </span>
      <button class="btn" type="button" @click="crawlOpen = false">取消</button>
      <button class="btn primary" type="button" :disabled="importing || !preview || selectedUrls.size === 0" @click="confirmImport">
        {{ importing ? '导入中…' : `确认入库（${selectedUrls.size} 条）` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
/* 职位行卡片（原型 pos-row） */
.pos-list {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.pos-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s;
  background: var(--bg);
}

.pos-row:hover {
  border-color: var(--muted);
}

.pos-row.active {
  background: color-mix(in srgb, var(--accent) 6%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 45%, #dbdbdb);
}

.pr-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pr-company {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-title {
  font-size: 12px;
  color: var(--muted);
  margin: 1px 0 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-meta,
.pr-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.pr-city {
  font-size: 11px;
  color: var(--muted);
}

.pr-date {
  font-size: 10.5px;
  color: var(--muted);
  margin-left: auto;
  letter-spacing: 0.02em;
}

/* 采集候选卡片（原型 crawl-item / crawl-summary） */
.crawl-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 14px;
  font-size: 12px;
}

.crawl-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 0;
  border-top: 1px solid var(--border);
}

.crawl-item:first-of-type {
  border-top: none;
}

.crawl-item input[type='checkbox'] {
  width: 15px;
  height: 15px;
  margin-top: 3px;
  accent-color: var(--fg);
  flex: none;
}

.ci-main {
  flex: 1;
  min-width: 0;
}

.ci-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ci-meta {
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.6;
}

.ci-meta .pill {
  margin-left: 6px;
  vertical-align: 1px;
}

.ci-tags {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.detail {
  overflow-y: auto;
  padding: 20px 24px;
  background: var(--bg);
}

.hint {
  color: var(--muted);
  font-size: 12px;
  margin-top: 8px;
}

.required {
  color: #dc2626;
  font-style: normal;
}

.crawl-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: flex-end;
}

.select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  margin: 10px 0 2px;
}

.select-all input {
  width: 15px;
  height: 15px;
  accent-color: var(--fg);
}

.rgroup-title {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 14px 0 6px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.run-row:last-child {
  border-bottom: none;
}

.run-success {
  background: color-mix(in srgb, #16a34a 12%, #ffffff);
  border-color: color-mix(in srgb, #16a34a 35%, #dbdbdb);
  color: color-mix(in srgb, #16a34a 80%, #000000);
}

.run-partial {
  background: color-mix(in srgb, #d97706 12%, #ffffff);
  border-color: color-mix(in srgb, #d97706 35%, #dbdbdb);
  color: color-mix(in srgb, #d97706 80%, #000000);
}

.run-failed {
  background: color-mix(in srgb, #dc2626 10%, #ffffff);
  border-color: color-mix(in srgb, #dc2626 32%, #dbdbdb);
  color: color-mix(in srgb, #dc2626 80%, #000000);
}

.run-running {
  background: color-mix(in srgb, var(--accent) 9%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 28%, #dbdbdb);
  color: color-mix(in srgb, var(--accent) 78%, #000000);
}
</style>
