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
  type BossPageDraft,
  type CompanyType,
  type CrawlConditions,
  type CrawlMode,
  type CrawlPreset,
  type CrawlPreview,
  type CrawlRun,
  type CsvImportPreviewResult,
  type CsvImportResult,
  type CsvImportSelection,
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

/* ---------- #67：一键清 BOSS 会话数据（风控自救） ---------- */
const clearingBoss = ref(false)
const bossClearMessage = ref('')

async function clearBossSession(): Promise<void> {
  if (!window.confirm('清除 BOSS 会话数据会：\n\n1. 清空 BOSS 登录态（需要重新登录）\n2. 移除风控标记的浏览器指纹 cookie\n3. 关闭已打开的 BOSS 窗口\n\n确定清除吗？')) return
  clearingBoss.value = true
  bossClearMessage.value = ''
  try {
    await window.api.crawls.bossLogin.clear()
    bossClearMessage.value = '已清除 BOSS 会话数据，登录态已失效；冷却后重新打开窗口即可'
    bossLoginStatus.value = false
  } catch (err) {
    bossClearMessage.value = `清除失败：${String(err)}`
  } finally {
    clearingBoss.value = false
  }
}

function toggleSelect(url: string): void {
  const next = new Set(selectedUrls.value)
  if (next.has(url)) next.delete(url)
  else next.add(url)
  selectedUrls.value = next
}

/** #67：岗位网址跳转（window.open → 主进程 setWindowOpenHandler → 系统浏览器）。 */
function openJobUrl(url: string): void {
  window.open(url, '_blank')
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

/* ---------- #67：截图 OCR 提取岗位信息（录入表单内） ---------- */
const ocrExtracting = ref(false)
const ocrError = ref('')

async function extractFromScreenshot(source: 'clipboard' | 'file'): Promise<void> {
  ocrError.value = ''
  ocrExtracting.value = true
  try {
    const result = await window.api.crawls.ocrExtract(source)
    if (result.draft !== null) {
      applyBossDraft(result.draft)
    } else {
      ocrError.value = result.error ?? '截图提取失败'
    }
  } catch (err) {
    ocrError.value = String(err)
  } finally {
    ocrExtracting.value = false
  }
}

/* ---------- 弹窗开关 ---------- */
const addOpen = ref(false)
const crawlOpen = ref(false)
const csvOpen = ref(false)

/* ---------- #68/T3：CSV 批量导入 ---------- */
const csvFileInput = ref<HTMLInputElement | null>(null)
const csvFileName = ref('')
const csvPreview = ref<CsvImportPreviewResult | null>(null)
/** 行选中态（index → 勾选）；exists 行默认不勾选（防误覆盖手动数据）。 */
const csvSelected = ref<Set<number>>(new Set())
/** 行更新态（index → 勾选的行走更新路径；仅 exists 行展示开关，默认随勾选开启）。 */
const csvUpdate = ref<Set<number>>(new Set())
const csvImporting = ref(false)
const csvMessage = ref('')
const csvError = ref('')

/** 字段中文标签（缺字段标记展示用）。 */
const CSV_FIELD_LABELS: Record<string, string> = {
  company: '公司',
  title: '岗位',
  recruit_season: '秋招季'
}

const CSV_ENCODING_HINTS: Record<'utf8' | 'gbk', string> = {
  utf8: 'UTF-8（含 BOM）',
  gbk: 'GBK/GB2312（Excel 中文版导出常见）'
}

/** 可勾选行数（校验失败行不可导入）。 */
const csvSelectableCount = computed(
  () => csvPreview.value?.items.filter((i) => i.error === null).length ?? 0
)

function pickCsvFile(): void {
  csvFileInput.value?.click()
}

async function onCsvFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file === undefined) return
  const path = window.api.getPathForFile(file)
  if (path === '') {
    csvError.value = '无法读取文件路径，请重试'
    return
  }
  csvError.value = ''
  csvMessage.value = ''
  csvPreview.value = null
  csvFileName.value = file.name
  try {
    const result = await window.api.csvImport.preview(path)
    csvPreview.value = result
    // 勾选默认：非 exists 行全选（与采集预览一致）；exists 行默认不勾选（防误覆盖）
    csvSelected.value = new Set(
      result.items.map((_, i) => i).filter((i) => !result.items[i].exists)
    )
    csvUpdate.value = new Set()
  } catch (err) {
    csvError.value = String(err)
  } finally {
    input.value = '' // 允许重复选择同一文件
  }
}

function toggleCsvSelect(index: number): void {
  const next = new Set(csvSelected.value)
  const updates = new Set(csvUpdate.value)
  if (next.has(index)) {
    next.delete(index)
    updates.delete(index)
  } else {
    next.add(index)
    // exists 行勾选 = 意图导入 → 默认走更新路径（防误覆盖可取消勾选）
    if (csvPreview.value?.items[index].exists === true) updates.add(index)
  }
  csvSelected.value = next
  csvUpdate.value = updates
}

function toggleCsvUpdate(index: number): void {
  const next = new Set(csvUpdate.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  csvUpdate.value = next
}

function csvToggleAll(checked: boolean): void {
  if (csvPreview.value === null) return
  const items = csvPreview.value.items
  csvSelected.value = new Set(
    checked ? items.map((_, i) => i).filter((i) => !items[i].exists) : []
  )
  if (!checked) csvUpdate.value = new Set()
}

function csvResultText(r: CsvImportResult): string {
  return `导入完成：成功 ${r.inserted} 条，更新 ${r.updated} 条${
    r.failed.length > 0 ? `，失败 ${r.failed.length} 条` : ''
  }`
}

async function confirmCsvImport(): Promise<void> {
  if (csvPreview.value === null) return
  csvImporting.value = true
  csvMessage.value = ''
  csvError.value = ''
  try {
    const preview = csvPreview.value
    const items: CsvImportSelection[] = [...csvSelected.value]
      .sort((a, b) => a - b)
      .map((i) => ({
        input: preview.items[i].input,
        // 仅 exists 行 update 标志有意义（勾选即默认更新；可取消）；新行走插入
        update: preview.items[i].exists ? csvUpdate.value.has(i) : false
      }))
    const result = await window.api.csvImport.confirm(items)
    csvMessage.value = csvResultText(result)
    if (result.failed.length > 0) {
      csvError.value = `失败行（仅修正后重试）：\n${result.failed
        .slice(0, 5)
        .join('\n')}${result.failed.length > 5 ? `\n…等 ${result.failed.length} 条` : ''}`
    }
    // 列表即时刷新 + 顶栏统计联动（#68/T3 验收：导入后立即可见）
    await refresh()
  } catch (err) {
    csvError.value = String(err)
  } finally {
    csvImporting.value = false
  }
}

async function downloadCsvTemplate(): Promise<void> {
  csvError.value = ''
  try {
    const path = await window.api.csvImport.template()
    if (path !== null) csvMessage.value = `模板已保存：${path}`
  } catch (err) {
    csvError.value = `模板下载失败：${String(err)}`
  }
}

function openCsvImport(): void {
  csvError.value = ''
  csvMessage.value = ''
  csvPreview.value = null
  csvFileName.value = ''
  csvOpen.value = true
}

/**
 * issue #62：BOSS 窗口 F8 提取草稿 → 预填录入表单（用户核对后保存；不自动入库）。
 * 先重置为空表单再覆盖草稿字段（避免残留上次录入的批次/日期等）。
 */
function applyBossDraft(draft: BossPageDraft): void {
  Object.assign(form, emptyForm(), {
    company: draft.company,
    title: draft.title,
    jd: draft.jd,
    city: draft.city ?? '',
    channel: draft.channel,
    channel_url: draft.channel_url,
    hire_type: draft.hire_type,
    salary_min: draft.salary_min?.toString() ?? '',
    salary_max: draft.salary_max?.toString() ?? '',
    salary_text: draft.salary_text ?? ''
  })
  formError.value = ''
  formSuccess.value = `已从 BOSS 页面提取「${draft.company} · ${draft.title}」，请核对后保存`
  addOpen.value = true
}

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
  // issue #62：BOSS 窗口 F8 提取结果 → 预填录入表单（失败则弹窗提示错误）
  const unsubscribeExtract = window.api.on(IpcEvent.BossPageExtracted, (payload) => {
    if (payload.draft !== null) {
      applyBossDraft(payload.draft)
    } else {
      formError.value = payload.error ?? 'BOSS 页面提取失败'
      addOpen.value = true
    }
  })
  onUnmounted(() => {
    unsubscribe()
    unsubscribeExtract()
  })
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
          <button class="btn" type="button" @click="openCsvImport">
            <Icon name="upload" />CSV 导入
          </button>
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
            <!-- #67：岗位网址（channel_url）——点击系统浏览器打开 -->
            <a
              v-if="p.channel_url"
              class="pr-url"
              :href="p.channel_url"
              :title="p.channel_url"
              @click.stop.prevent="openJobUrl(p.channel_url)"
            >🔗</a>
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
        <span class="label">岗位网址</span>
        <input v-model="form.channel_url" placeholder="https://…（点击可在列表/详情直接跳转）" />
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
      <!-- #67：从截图提取（Windows OCR，零请求；支持 BOSS 详情页精准识别） -->
      <div class="field span2" style="display: flex; gap: 8px; align-items: center">
        <button
          class="btn"
          type="button"
          :disabled="ocrExtracting"
          @click="extractFromScreenshot('clipboard')"
        >
          {{ ocrExtracting ? '识别中…' : '从截图提取（粘贴）' }}
        </button>
        <button class="btn ghost" type="button" :disabled="ocrExtracting" @click="extractFromScreenshot('file')">
          从图片文件提取
        </button>
        <span class="hint">Win+Shift+S 截图后粘贴；BOSS 详情页截图自动识别公司/岗位/薪资/JD</span>
      </div>
      <label class="field span2">
        <span class="label">备注</span>
        <textarea v-model="form.notes" rows="2" placeholder="选填" />
      </label>
    </form>
    <p v-if="formError" class="empty" style="margin-top: 12px">{{ formError }}</p>
    <p v-if="formSuccess" class="empty" style="margin-top: 12px">{{ formSuccess }}</p>
    <p v-if="ocrError" class="empty" style="margin-top: 8px">{{ ocrError }}</p>

    <template #foot>
      <span class="note">带 * 为必填 · 保存后进入「未投递」状态</span>
      <button class="btn" type="button" @click="addOpen = false">取消</button>
      <button class="btn primary" type="button" :disabled="submitting" @click="submit">
        {{ submitting ? '保存中…' : '保存职位卡' }}
      </button>
    </template>
  </Modal>

  <!-- ===== 弹窗：CSV 批量导入（#68/T3） ===== -->
  <Modal :open="csvOpen" title="CSV 批量导入职位卡" width="760px" @close="csvOpen = false">
    <div class="crawl-bar">
      <button class="btn primary" type="button" @click="pickCsvFile">
        <Icon name="upload" />选择 CSV 文件
      </button>
      <button class="btn" type="button" @click="downloadCsvTemplate">
        <Icon name="download" />下载模板（含示例行）
      </button>
      <span class="hint" style="margin-top: 0">UTF-8（含 BOM）/ GBK 自动识别 · 表头支持中文别名（公司/岗位/…）</span>
      <input
        ref="csvFileInput"
        type="file"
        accept=".csv,text/csv"
        style="display: none"
        @change="onCsvFilePicked"
      />
    </div>

    <p v-if="csvFileName" class="hint">已选文件：{{ csvFileName }}</p>
    <p v-if="csvError" class="empty" style="margin-top: 10px">{{ csvError }}</p>
    <p v-if="csvMessage" class="empty" style="margin-top: 10px">{{ csvMessage }}</p>

    <template v-if="csvPreview">
      <div class="crawl-summary">
        <span>解析 {{ csvPreview.items.length }} 行</span>
        <span>·</span>
        <span>
          已存在 <b style="color: var(--fg)">{{ csvPreview.items.filter((i) => i.exists).length }}</b> 行（默认不勾选）
        </span>
        <span>·</span>
        <span>
          缺字段 <b style="color: var(--fg)">{{ csvPreview.items.filter((i) => i.missingFields.length > 0).length }}</b> 行
        </span>
        <span style="flex: 1"></span>
        <span class="hint">编码：{{ CSV_ENCODING_HINTS[csvPreview.encoding] }}</span>
      </div>
      <!-- #68/T3：乱码提示（GBK 兑底识别下，无 BOM 的 UTF-8 中文文件可能解码异常） -->
      <p v-if="csvPreview.encoding === 'gbk'" class="hint">
        ⚠ 若下方预览出现乱码，请用 Excel「另存为 CSV UTF-8（带 BOM）」后重新选择
      </p>
      <p v-if="csvPreview.errors.length > 0" class="hint" style="color: #b45309">
        解析跳过 {{ csvPreview.errors.length }} 行坏数据：{{ csvPreview.errors.slice(0, 3).join('；') }}
      </p>

      <label class="select-all">
        <input
          type="checkbox"
          :checked="csvSelected.size === csvSelectableCount && csvSelectableCount > 0"
          @change="csvToggleAll(($event.target as HTMLInputElement).checked)"
        />
        全选可导入行（{{ csvSelected.size }}/{{ csvSelectableCount }}）
      </label>

      <div v-for="(item, index) in csvPreview.items" :key="index" class="crawl-item">
        <input
          type="checkbox"
          :checked="csvSelected.has(index)"
          :disabled="item.error !== null"
          @change="toggleCsvSelect(index)"
        />
        <div class="ci-main">
          <div class="ci-title">
            {{ item.input.company || '（无公司名）' }} · {{ item.input.title || '（无岗位名）' }}
          </div>
          <div class="ci-meta">
            <span v-if="item.input.hire_type">{{ item.input.hire_type }}</span>
            <span v-if="item.input.hire_type === '校招'"> · {{ item.input.recruit_season || '缺秋招季' }}</span>
            <span v-if="item.input.city"> · {{ item.input.city }}</span>
            <span v-if="item.input.salary_text"> · {{ item.input.salary_text }}</span>
            <span v-if="item.input.batch"> · {{ item.input.batch }}</span>
            <span v-if="item.input.end_date"> · 截止 {{ item.input.end_date.slice(5) }}</span>
            <Pill v-if="item.exists" tone="tint">已存在</Pill>
          </div>
          <div class="ci-tags">
            <span v-for="mf in item.missingFields" :key="mf" class="pill ghost">
              缺{{ CSV_FIELD_LABELS[mf] ?? mf }}
            </span>
            <span v-if="item.error" class="pill ghost" style="color: #b45309">{{ item.error }}</span>
            <label v-if="item.exists && item.error === null" class="csv-update-toggle">
              <input
                type="checkbox"
                :checked="csvUpdate.has(index)"
                :disabled="!csvSelected.has(index)"
                @change="toggleCsvUpdate(index)"
              />
              更新已有
            </label>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <p class="empty" style="margin-top: 16px">
        选择一个 CSV 文件后在此预览：逐行字段 + 缺字段/已存在标记，勾选确认后批量导入。
      </p>
    </template>

    <template #foot>
      <span class="note">
        {{ csvPreview ? `预览 ${csvPreview.items.length} 行，勾选 ${csvSelected.size} 行` : '模板列：company/公司、title/岗位、hire_type/招聘类型…（下载模板查看全部）' }}
      </span>
      <button class="btn" type="button" @click="csvOpen = false">关闭</button>
      <button
        class="btn primary"
        type="button"
        :disabled="csvImporting || csvSelected.size === 0"
        @click="confirmCsvImport"
      >
        {{ csvImporting ? '导入中…' : `确认导入（${csvSelected.size} 条）` }}
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
        反爬建议人工浏览：在内置 BOSS 窗口打开岗位详情页，按 F8 提取职位卡（只读页面，无风控风险）。
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
        <!-- #67：风控自救——一键清 BOSS 会话数据（cookie/localStorage/指纹） -->
        <button
          class="btn ghost danger"
          type="button"
          :disabled="clearingBoss"
          @click="clearBossSession"
        >
          {{ clearingBoss ? '清除中…' : '清除会话数据' }}
        </button>
      </div>
      <span v-if="bossClearMessage" class="hint">{{ bossClearMessage }}</span>
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

.pr-url {
  font-size: 12px;
  text-decoration: none;
  opacity: 0.7;
}

.pr-url:hover {
  opacity: 1;
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

.csv-update-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
}

.csv-update-toggle input {
  width: 13px;
  height: 13px;
  accent-color: var(--fg);
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
