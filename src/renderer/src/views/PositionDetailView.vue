<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  APPLICATION_TRANSITIONS,
  BATCHES,
  COMPANY_TYPES,
  HIRE_TYPES,
  POSITION_STATUSES,
  type Application,
  type ApplicationStatus,
  type Batch,
  type CompanyType,
  type HireType,
  type Position,
  type PositionStatus
} from '@shared/types'
import type { Resume, StoredResume } from '@shared/types/resume'
import { score, type FitScore } from '@shared/score'
import { buildDerivedResume, diffResumeSections, type SectionDiff } from '../resume-compare'
import type { OptimizeResult, OptimizationMode } from '@shared/types'
import { IpcEvent } from '@shared/protocol'
import MatchGauge from '../components/MatchGauge.vue'
import Pill from '../components/Pill.vue'
import Icon from '../components/Icon.vue'

/** 职位详情列（#42 T2）：原型 pos-detail 布局；功能 = 原 PositionDetailView（F-03/F-05/F-06/F-07/F-20）。 */
const props = defineProps<{ positionId: string }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const router = useRouter()

/** #67：岗位网址跳转（window.open → 主进程 setWindowOpenHandler → 系统浏览器）。 */
function openJobUrl(url: string): void {
  window.open(url, '_blank')
}

const position = ref<Position | null>(null)
const application = ref<Application | null>(null)
const loading = ref(true)
const errorMessage = ref('')
const appError = ref('')
const appSaving = ref(false)
const appForm = reactive({ channel: '', appliedDate: '' })

/* ---------- 匹配度（F-06/#27） ---------- */
const resumes = ref<StoredResume[]>([])
const selectedResumeId = ref('')
/** T07/#97：已完成过内容优化的基准简历 id 集合（用于「建议先做内容优化」提示）。 */
const contentOptimizedResumeIds = ref<Set<string>>(new Set())
const fitScore = ref<FitScore | null>(null)
const scoring = ref(false)
const scoreError = ref('')
const basisOpen = ref(false)

async function runScore(): Promise<void> {
  const pos = position.value
  const resume = resumes.value.find((r) => r.meta.id === selectedResumeId.value)
  if (pos === null || resume === undefined) return
  scoreError.value = ''
  scoring.value = true
  try {
    fitScore.value = score({ jd: pos.jd, resume })
  } catch (err) {
    scoreError.value = `评估失败：${String(err)}`
  } finally {
    scoring.value = false
  }
}

/** 依据面板：跨维度汇总命中/缺失。 */
const basis = computed(() => {
  const s = fitScore.value
  if (s === null) return { hits: [], misses: [] }
  const hits = s.dimensions.flatMap((d) => d.evidence.map((e) => `${d.label}：${e}`))
  const misses = s.dimensions.flatMap((d) => d.misses.map((m) => `${d.label}：${m}`))
  return { hits, misses }
})

/* ---------- 优化（F-07/#32 + F-20/#34） ---------- */
const optimizeMode = ref<OptimizationMode>('strict')
const optimizing = ref(false)
const optimizeError = ref('')
const optimizeResult = ref<OptimizeResult | null>(null)
const optimizeProgress = ref<Array<{ round: number; phase: string; done: boolean }>>([])

const OPTIMIZE_PHASES: Record<number, string> = { 1: 'JD 解析', 2: '缺口评估', 3: '生成优化稿' }

const confirmTitle = ref('')
const optimizedJson = ref('')
const comparing = ref(false)
const confirming = ref(false)
const derivedMessage = ref('')
const compareDiffs = ref<SectionDiff[]>([])

function openCompare(): void {
  const result = optimizeResult.value
  const baseResume = resumes.value.find((r) => r.meta.id === selectedResumeId.value)
  if (result === null || baseResume === undefined) return
  comparing.value = true
  derivedMessage.value = ''
  confirmTitle.value = `${baseResume.meta.title ?? '基准简历'}-优化稿`
  optimizedJson.value = JSON.stringify(result.optimizedResume, null, 2)
  compareDiffs.value = diffResumeSections(baseResume, result.optimizedResume, result.changes)
}

async function confirmDerived(): Promise<void> {
  const result = optimizeResult.value
  const baseResume = resumes.value.find((r) => r.meta.id === selectedResumeId.value)
  if (result === null || baseResume === undefined) return
  confirming.value = true
  derivedMessage.value = ''
  try {
    const parsed = JSON.parse(optimizedJson.value) as Resume
    const derived = buildDerivedResume(
      baseResume.meta.id as string,
      result.jobId,
      parsed,
      confirmTitle.value,
      baseResume.meta.title
    )
    const stored = await window.api.resumes.create(derived)
    derivedMessage.value = `已入库派生稿「${stored.meta.title}」（关联职位卡 ${stored.meta.targetJobId}）`
    comparing.value = false
  } catch (err) {
    derivedMessage.value = `入库失败：${String(err)}`
  } finally {
    confirming.value = false
  }
}

function diffClass(changed: boolean): string {
  return changed ? 'diff-changed' : 'diff-same'
}

async function runOptimize(): Promise<void> {
  const resume = resumes.value.find((r) => r.meta.id === selectedResumeId.value)
  if (resume === undefined) {
    optimizeError.value = '请先选择基准简历'
    return
  }
  optimizeError.value = ''
  optimizeResult.value = null
  optimizeProgress.value = [1, 2, 3].map((round) => ({ round, phase: OPTIMIZE_PHASES[round]!, done: false }))
  optimizing.value = true
  try {
    optimizeResult.value = await window.api.optimize.run(props.positionId, resume.meta.id as string, optimizeMode.value)
  } catch (err) {
    optimizeError.value = String(err)
  } finally {
    optimizing.value = false
    optimizeProgress.value = optimizeProgress.value.map((p) => ({ ...p, done: true }))
  }
}

onMounted(() => {
  const unsubscribe = window.api.on(IpcEvent.OptimizeProgress, (payload) => {
    if (payload.jobId !== props.positionId) return
    optimizeProgress.value = optimizeProgress.value.map((p) =>
      p.round === payload.round ? { ...p, phase: payload.phase, done: true } : p
    )
  })
  onUnmounted(unsubscribe)
})

/* ---------- 编辑 / 删除 ---------- */
type EditFormState = {
  company: string
  company_type: CompanyType
  title: string
  jd: string
  city: string
  channel: string
  channel_url: string
  hire_type: HireType
  recruit_season: string
  salary_min: string
  salary_max: string
  salary_text: string
  batch: Batch | ''
  start_date: string
  end_date: string
  status: PositionStatus
  notes: string
}

const editing = ref(false)
const deleteConfirming = ref(false)
const saving = ref(false)
const formError = ref('')
const form = reactive<EditFormState>({
  company: '',
  company_type: '其他',
  title: '',
  jd: '',
  city: '',
  channel: '',
  channel_url: '',
  hire_type: '校招',
  recruit_season: '',
  salary_min: '',
  salary_max: '',
  salary_text: '',
  batch: '',
  start_date: '',
  end_date: '',
  status: 'active',
  notes: ''
})

const SOURCE_LABELS: Record<Position['source'], string> = {
  manual: '手动录入',
  nowcoder: '牛客采集',
  liepin: '猎聘采集',
  boss: 'BOSS直聘采集'
}

const STATUS_TS_KEY: Record<ApplicationStatus, keyof Application> = {
  planned: 'planned_at',
  applied: 'applied_at',
  interviewing: 'interviewing_at',
  offer: 'offer_at',
  rejected: 'rejected_at',
  withdrawn: 'withdrawn_at'
}

function formatTs(ts: string | null): string {
  return ts === null ? '—' : ts.slice(0, 16).replace('T', ' ')
}

const nextActions = computed<ApplicationStatus[]>(() =>
  application.value === null ? [] : [...APPLICATION_TRANSITIONS[application.value.status]]
)

const hasTimeline = computed(
  () =>
    application.value !== null &&
    APPLICATION_STATUSES.some((s) => application.value?.[STATUS_TS_KEY[s]] !== null)
)

/** 投递记录行：已进入过的状态（含时刻），按状态顺序展示。 */
const timelineRows = computed(() => {
  const app = application.value
  if (app === null) return []
  return APPLICATION_STATUSES.filter((s) => app[STATUS_TS_KEY[s]] !== null).map((s) => ({
    status: s,
    ts: app[STATUS_TS_KEY[s]]
  }))
})

function daysLeft(endDate: string | null): number | null {
  if (endDate === null) return null
  const [year, month, day] = endDate.split('-').map(Number)
  const end = Date.UTC(year, month - 1, day) / 86_400_000
  const today = new Date()
  const now = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000)
  return end - now
}

const daysLeftValue = computed(() => daysLeft(position.value?.end_date ?? null))

/**
 * T07/#97：当前选中基准是否「未做内容优化」（用于按 JD 优化入口的提示）。
 * 派生稿（baseResumeId != null，按 JD 优化稿）不适用；仅基准简历且无已归档内容优化任务时提示。
 */
const selectedBaseLacksContentOpt = computed(() => {
  const resume = resumes.value.find((r) => r.meta.id === selectedResumeId.value)
  if (resume === undefined) return false
  if (resume.meta.baseResumeId != null) return false
  return !contentOptimizedResumeIds.value.has(resume.meta.id as string)
})

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    position.value = await window.api.positions.get(props.positionId)
    application.value = await window.api.positions.getApplication(props.positionId)
    resumes.value = await window.api.resumes.list()
    // T07/#97：加载已完成内容优化的基准集合（供「建议先做内容优化」提示）。
    const tasks = await window.api.contentOptimize.list()
    contentOptimizedResumeIds.value = new Set(
      tasks.filter((t) => t.archivedAt != null).map((t) => t.resumeId)
    )
    fillAppForm()
  } catch (err) {
    errorMessage.value = `加载职位详情失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

function fillAppForm(): void {
  appForm.channel = application.value?.channel ?? ''
  appForm.appliedDate = application.value?.applied_date ?? ''
}

async function transition(target: ApplicationStatus): Promise<void> {
  appError.value = ''
  appSaving.value = true
  try {
    application.value = await window.api.positions.setApplication(props.positionId, { status: target })
    fillAppForm()
    emit('changed')
  } catch (err) {
    appError.value = String(err)
  } finally {
    appSaving.value = false
  }
}

async function saveApplicationEdit(): Promise<void> {
  if (application.value === null) return
  appError.value = ''
  appSaving.value = true
  try {
    application.value = await window.api.positions.setApplication(props.positionId, {
      status: application.value.status,
      channel: appForm.channel === '' ? null : appForm.channel,
      appliedDate: appForm.appliedDate === '' ? null : appForm.appliedDate
    })
    emit('changed')
  } catch (err) {
    appError.value = String(err)
  } finally {
    appSaving.value = false
  }
}

function startEdit(): void {
  const p = position.value
  if (p === null) return
  Object.assign(form, {
    company: p.company,
    company_type: p.company_type,
    title: p.title,
    jd: p.jd,
    city: p.city ?? '',
    channel: p.channel ?? '',
    channel_url: p.channel_url ?? '',
    hire_type: p.hire_type,
    recruit_season: p.recruit_season,
    salary_min: p.salary_min === null ? '' : String(p.salary_min),
    salary_max: p.salary_max === null ? '' : String(p.salary_max),
    salary_text: p.salary_text ?? '',
    batch: p.batch ?? '',
    start_date: p.start_date ?? '',
    end_date: p.end_date ?? '',
    status: p.status,
    notes: p.notes
  })
  formError.value = ''
  editing.value = true
  deleteConfirming.value = false
}

async function saveEdit(): Promise<void> {
  formError.value = ''
  if (form.company.trim() === '' || form.title.trim() === '') {
    formError.value = '公司与岗位为必填项'
    return
  }
  saving.value = true
  try {
    position.value = await window.api.positions.update(props.positionId, {
      company: form.company.trim(),
      company_type: form.company_type,
      title: form.title.trim(),
      jd: form.jd,
      city: form.city === '' ? null : form.city,
      channel: form.channel === '' ? null : form.channel,
      channel_url: form.channel_url === '' ? null : form.channel_url,
      hire_type: form.hire_type,
      recruit_season: form.recruit_season.trim(),
      salary_min: form.salary_min === '' ? null : Number(form.salary_min),
      salary_max: form.salary_max === '' ? null : Number(form.salary_max),
      salary_text: form.salary_text.trim() === '' ? null : form.salary_text.trim(),
      batch: form.batch === '' ? null : form.batch,
      start_date: form.start_date === '' ? null : form.start_date,
      end_date: form.end_date === '' ? null : form.end_date,
      status: form.status,
      notes: form.notes
    })
    editing.value = false
    emit('changed')
  } catch (err) {
    formError.value = String(err)
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  saving.value = true
  try {
    await window.api.positions.delete(props.positionId)
    emit('changed')
  } catch (err) {
    errorMessage.value = `删除失败：${String(err)}`
    deleteConfirming.value = false
  } finally {
    saving.value = false
  }
}

/* ---------- 操作组（原型 actions） ---------- */
const appCard = ref<HTMLElement | null>(null)
const optCard = ref<HTMLElement | null>(null)

function scrollToCard(el: HTMLElement | null): void {
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function actOptimize(): void {
  scrollToCard(optCard.value)
}

function actTopics(): void {
  void router.push('/learn')
}

function actInterview(): void {
  void router.push('/interview')
}

function actApplied(): void {
  if (application.value === null) {
    void transition('applied')
  } else {
    scrollToCard(appCard.value)
  }
}

watch(
  () => props.positionId,
  () => {
    editing.value = false
    deleteConfirming.value = false
    comparing.value = false
    fitScore.value = null
    basisOpen.value = false
    optimizeResult.value = null
    optimizeProgress.value = []
    void load()
  }
)

onMounted(() => void load())
</script>

<template>
  <div class="detail">
    <p v-if="loading" class="empty">加载中…</p>
    <p v-else-if="errorMessage" class="empty">{{ errorMessage }}</p>

    <template v-else-if="position">
      <!-- 标题区 -->
      <div class="d-title-row">
        <h1>{{ position.title }}</h1>
        <Pill v-if="application" :tone="application.status === 'interviewing' || application.status === 'offer' ? 'tint' : ''">
          {{ APPLICATION_STATUS_LABELS[application.status] }}
        </Pill>
      </div>
      <div class="d-sub">{{ position.company }} · {{ SOURCE_LABELS[position.source] }}</div>
      <!-- #67：岗位网址（channel_url）——点击系统浏览器打开 -->
      <div v-if="position.channel_url" class="d-url">
        <a :href="position.channel_url" :title="position.channel_url" @click.prevent="openJobUrl(position.channel_url)">
          🔗 {{ position.channel_url }}
        </a>
      </div>
      <div class="d-meta">
        <Pill>{{ position.company_type }}</Pill>
        <Pill v-if="position.hire_type" :tone="position.hire_type === '校招' ? '' : 'tint'">{{ position.hire_type }}</Pill>
        <Pill v-if="position.salary_text" tone="tint">{{ position.salary_text }}</Pill>
        <Pill v-if="position.batch">{{ position.batch }}</Pill>
        <Pill v-if="position.city">{{ position.city }}</Pill>
        <span class="d-window">
          <template v-if="position.hire_type !== '校招'">
            长期有效（无网申窗口）
          </template>
          <template v-else>
            网申 {{ position.start_date ?? '—' }} → {{ position.end_date ?? '待核实' }}
            <template v-if="daysLeftValue !== null && daysLeftValue > 0">· <b>剩 {{ daysLeftValue }} 天</b></template>
          </template>
        </span>
      </div>

      <!-- 匹配度概览 -->
      <div class="card surface">
        <div class="mc-head">
          <span class="mc-title">匹配度概览</span>
          <Pill tone="ghost">规则打分 · 无 LLM 依赖</Pill>
        </div>

        <div v-if="fitScore" class="mc-wrap">
          <MatchGauge :total="fitScore.total" :dims="fitScore.dimensions" />
          <div style="margin-top: 10px">
            <button class="link" type="button" @click="basisOpen = !basisOpen">
              查看命中 / 缺失依据
            </button>
          </div>
          <div v-if="basisOpen" class="basis">
            <div>
              <div class="bg-title">命中（{{ basis.hits.length }}）</div>
              <ul>
                <li v-for="(h, i) in basis.hits" :key="i">
                  <Icon name="check" class="ok" /><span class="ok">{{ h }}</span>
                </li>
              </ul>
            </div>
            <div>
              <div class="bg-title">待补（{{ basis.misses.length }}）</div>
              <ul>
                <li v-for="(m, i) in basis.misses" :key="i">
                  <Icon name="plus" class="miss" /><span class="miss">{{ m }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <template v-else>
          <p class="hint" style="margin-bottom: 8px">
            选择一份简历按 JD 做 5 维度规则打分（关键词25/技能25/项目20/经历15/学历15）。
          </p>
          <div class="score-bar">
            <select v-model="selectedResumeId" class="sel">
              <option value="" disabled>选择简历…</option>
              <option v-for="r in resumes" :key="r.meta.id" :value="r.meta.id">
                {{ r.meta.title ?? '未命名简历' }}
              </option>
            </select>
            <button class="btn primary" type="button" :disabled="scoring || selectedResumeId === ''" @click="runScore">
              {{ scoring ? '评估中…' : '开始评估' }}
            </button>
          </div>
          <p v-if="scoreError" class="hint" style="color: #dc2626; margin-top: 8px">{{ scoreError }}</p>
        </template>
      </div>

      <!-- 操作组 -->
      <div class="actions">
        <button class="btn primary" type="button" @click="actOptimize">
          <Icon name="bolt" />生成优化简历
        </button>
        <button class="btn" type="button" @click="actTopics">
          <Icon name="list" />生成学习清单
        </button>
        <button class="btn" type="button" @click="actInterview">
          <Icon name="mic" />模拟面试
        </button>
        <button class="btn" type="button" :disabled="appSaving" @click="actApplied">
          <Icon name="check" />标记已投
        </button>
      </div>

      <!-- JD -->
      <div class="card">
        <div class="sec-head">
          <h2>职位描述（JD）</h2>
          <Pill tone="ghost">来源：{{ SOURCE_LABELS[position.source] }} · 更新 {{ position.updated_at.slice(0, 10) }}</Pill>
        </div>
        <p v-if="position.jd === ''" class="hint">未填写 JD——可点击「编辑」补充，供简历优化与面试使用。</p>
        <pre v-else class="jd">{{ position.jd }}</pre>
        <p v-if="position.notes !== ''" class="hint" style="margin-top: 10px">备注：{{ position.notes }}</p>
      </div>

      <!-- 投递记录 + 状态机操作 -->
      <div ref="appCard" class="card">
        <div class="sec-head">
          <h2>投递记录</h2>
          <Pill tone="ghost">{{ application ? `共 ${timelineRows.length} 条` : '未开始投递' }}</Pill>
        </div>

        <template v-if="application">
          <div v-if="hasTimeline" class="rec-list">
            <div v-for="row in timelineRows" :key="row.status" class="rec-row">
              <span class="rec-time">{{ formatTs(row.ts) }}</span>
              <span class="rec-channel">{{ application.channel ?? '—' }}</span>
              <Pill :tone="row.status === 'interviewing' || row.status === 'offer' ? 'tint' : ''">{{ APPLICATION_STATUS_LABELS[row.status] }}</Pill>
              <span class="rec-note">{{ row.status === 'applied' && application.applied_date ? `投递日期 ${application.applied_date}` : '' }}</span>
            </div>
          </div>
          <p v-else class="hint">尚未记录状态时刻。</p>

          <div v-if="nextActions.length > 0" class="app-actions">
            <button
              v-for="target in nextActions"
              :key="target"
              class="btn"
              :class="target === 'withdrawn' ? 'ghost' : ''"
              type="button"
              :disabled="appSaving"
              @click="transition(target)"
            >
              {{ APPLICATION_STATUS_LABELS[target] }}
            </button>
          </div>
          <p v-else class="hint">已到终态（{{ APPLICATION_STATUS_LABELS[application.status] }}）。</p>

          <form class="app-edit" @submit.prevent="saveApplicationEdit">
            <input v-model="appForm.channel" placeholder="投递渠道（留空清除）" />
            <input v-model="appForm.appliedDate" type="date" />
            <button class="btn" type="submit" :disabled="appSaving">保存渠道/日期</button>
          </form>
        </template>

        <template v-else>
          <p class="hint">尚未开始投递——标记后即可跟踪状态流转（已投递 → 面试中 → offer/已拒绝，可随时放弃）。</p>
          <div class="app-actions">
            <button class="btn primary" type="button" :disabled="appSaving" @click="transition('applied')">
              标记已投递
            </button>
            <button class="btn" type="button" :disabled="appSaving" @click="transition('withdrawn')">
              标记已放弃
            </button>
          </div>
        </template>

        <p v-if="appError" class="hint" style="color: #dc2626; margin-top: 8px">{{ appError }}</p>
      </div>

      <!-- 按 JD 优化简历 -->
      <div ref="optCard" class="card">
        <div class="sec-head"><h2>按 JD 优化简历</h2></div>
        <div class="score-bar">
          <select v-model="selectedResumeId" class="sel">
            <option value="" disabled>选择基准简历…</option>
            <option v-for="r in resumes" :key="r.meta.id" :value="r.meta.id">
              {{ r.meta.title ?? '未命名简历' }}
            </option>
          </select>
          <select v-model="optimizeMode" class="sel">
            <option value="strict">strict（不虚构，默认）</option>
            <option value="balanced">balanced（适度润色）</option>
          </select>
          <button class="btn primary" type="button" :disabled="optimizing || selectedResumeId === ''" @click="runOptimize">
            {{ optimizing ? '优化中…' : '开始优化' }}
          </button>
        </div>

        <!-- T07/#97：未做内容优化的基准 → 建议先做内容优化（不改动业务②行为） -->
        <p v-if="selectedBaseLacksContentOpt" class="hint opt-content-hint">
          该基准简历尚未做过内容优化——建议先在「简历」模块执行「内容优化」修复通用质量问题。
        </p>

        <ul v-if="optimizeProgress.length > 0" class="opt-progress">
          <li v-for="p in optimizeProgress" :key="p.round" :class="{ done: p.done }">
            <span class="opt-round">{{ p.done ? '✓' : '…' }}</span>
            {{ p.phase }}
          </li>
        </ul>
        <p v-if="optimizeError" class="hint" style="color: #dc2626; margin-top: 8px">{{ optimizeError }}</p>

        <div v-if="optimizeResult" class="opt-result">
          <p class="hint" style="color: #059669">
            优化完成（{{ optimizeResult.mode }}）：缺口 {{ optimizeResult.gaps.length }} 项，改动 {{ optimizeResult.changes.length }} 处
          </p>
          <ul v-if="optimizeResult.gaps.length > 0" class="opt-gaps">
            <li v-for="(g, i) in optimizeResult.gaps" :key="i">{{ g }}</li>
          </ul>
          <div v-for="(c, i) in optimizeResult.changes" :key="i" class="change">
            <div class="change-head">
              <Pill>{{ c.section }}</Pill>
              <span class="change-reason">{{ c.reason }}</span>
            </div>
            <div class="change-body">
              <div class="change-col">
                <span class="change-label">原文</span>
                <pre class="change-text">{{ c.before }}</pre>
              </div>
              <div class="change-col">
                <span class="change-label">改后</span>
                <pre class="change-text">{{ c.after }}</pre>
              </div>
            </div>
          </div>
          <details class="opt-json">
            <summary>优化稿 JSON（{{ optimizeResult.optimizedResume.basics?.name }}）</summary>
            <pre class="json-pre">{{ JSON.stringify(optimizeResult.optimizedResume, null, 2) }}</pre>
          </details>

          <div class="compare-actions">
            <button class="btn primary" type="button" @click="openCompare">对比并确认入库</button>
          </div>
        </div>

        <div v-if="comparing" class="compare-panel">
          <p v-if="derivedMessage" class="hint" :style="{ color: derivedMessage.startsWith('已入库') ? '#059669' : '#dc2626' }">
            {{ derivedMessage }}
          </p>
          <ul class="diff-list">
            <li v-for="d in compareDiffs" :key="d.section" :class="diffClass(d.changed)">
              <span class="diff-badge">{{ d.changed ? '改动' : '未变' }}</span>
              <span class="diff-section">{{ d.section }}</span>
              <span v-if="d.reason" class="diff-reason" :title="d.reason">{{ d.reason }}</span>
            </li>
          </ul>
          <div class="compare-cols">
            <div class="compare-col">
              <span class="compare-label">基准简历</span>
              <pre class="json-pre">{{ JSON.stringify(resumes.find((r) => r.meta.id === selectedResumeId), null, 2) }}</pre>
            </div>
            <div class="compare-col">
              <span class="compare-label">优化稿（可编辑）</span>
              <textarea v-model="optimizedJson" class="json-textarea" rows="18" spellcheck="false" />
            </div>
          </div>
          <div class="compare-confirm">
            <input v-model="confirmTitle" placeholder="派生稿名称" />
            <button class="btn primary" type="button" :disabled="confirming" @click="confirmDerived">
              {{ confirming ? '入库中…' : '确认入库（派生稿）' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 编辑 / 删除 -->
      <div class="d-foot">
        <button class="btn" type="button" @click="startEdit">
          <Icon name="edit" />编辑
        </button>
        <button class="btn" type="button" :disabled="deleteConfirming" @click="deleteConfirming = true">
          <Icon name="trash" />删除
        </button>
        <span v-if="deleteConfirming" class="confirm-box">
          <span class="confirm-text">确认删除「{{ position.company }} · {{ position.title }}」？投递记录将一并删除且不可恢复。</span>
          <button class="btn primary" type="button" :disabled="saving" @click="confirmDelete">
            {{ saving ? '删除中…' : '确认删除' }}
          </button>
          <button class="btn" type="button" :disabled="saving" @click="deleteConfirming = false">取消</button>
        </span>
      </div>

      <div v-if="editing" class="card">
        <div class="sec-head"><h2>编辑职位卡</h2></div>
        <form class="form-grid" @submit.prevent="saveEdit">
          <label class="field">
            <span class="label">公司 <em class="required">*</em></span>
            <input v-model="form.company" />
          </label>
          <label class="field">
            <span class="label">岗位 <em class="required">*</em></span>
            <input v-model="form.title" />
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
          <label class="field">
            <span class="label">秋招季</span>
            <input v-model="form.recruit_season" :disabled="form.hire_type !== '校招'" placeholder="校招必填" />
          </label>
          <label class="field">
            <span class="label">薪资下限（K/月）</span>
            <input v-model="form.salary_min" type="number" min="1" placeholder="留空清除" />
          </label>
          <label class="field">
            <span class="label">薪资上限（K/月）</span>
            <input v-model="form.salary_max" type="number" min="1" placeholder="留空清除" />
          </label>
          <label class="field span2">
            <span class="label">薪资原文本</span>
            <input v-model="form.salary_text" placeholder="如：20-40K·14薪" />
          </label>
          <label class="field">
            <span class="label">城市</span>
            <input v-model="form.city" placeholder="留空清除" />
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
          <label class="field">
            <span class="label">状态</span>
            <select v-model="form.status">
              <option v-for="s in POSITION_STATUSES" :key="s" :value="s">
                {{ s === 'active' ? '进行中' : '已关闭' }}
              </option>
            </select>
          </label>
          <label class="field span2">
            <span class="label">JD</span>
            <textarea v-model="form.jd" rows="6" placeholder="职位描述全文…" />
          </label>
          <label class="field span2">
            <span class="label">备注</span>
            <textarea v-model="form.notes" rows="2" placeholder="选填" />
          </label>
        </form>
        <p v-if="formError" class="hint" style="color: #dc2626; margin-top: 10px">{{ formError }}</p>
        <div class="app-actions">
          <button class="btn primary" type="submit" :disabled="saving" @click="saveEdit">
            {{ saving ? '保存中…' : '保存修改' }}
          </button>
          <button class="btn" type="button" :disabled="saving" @click="editing = false">取消</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  padding: 20px 24px;
  overflow-y: auto;
  background: var(--bg);
  min-width: 0;
}

.d-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

h1 {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
}

.d-sub {
  font-size: 13px;
  color: var(--muted);
  margin-top: 2px;
}

.d-url {
  margin-top: 6px;
  font-size: 12px;
}

.d-url a {
  color: var(--accent, #2563eb);
  text-decoration: none;
  word-break: break-all;
}

.d-url a:hover {
  text-decoration: underline;
}

.d-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.d-window {
  font-size: 12px;
  color: var(--muted);
  margin-left: 4px;
}

.d-window b {
  color: var(--fg);
  font-weight: 600;
}

.mc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mc-title {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.mc-wrap {
  min-width: 0;
}

.basis {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.bg-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-bottom: 6px;
}

.basis ul {
  list-style: none;
}

.basis li {
  display: flex;
  gap: 7px;
  font-size: 12px;
  line-height: 1.55;
  padding: 2px 0;
  align-items: flex-start;
}

.basis .ok {
  color: var(--fg);
  font-weight: 500;
}

.basis .miss {
  color: var(--muted);
}

.basis .ic {
  width: 13px;
  height: 13px;
  margin-top: 2px;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.jd {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.75;
  white-space: pre-wrap;
  color: var(--fg);
}

.rec-list {
  margin-bottom: 10px;
}

.rec-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.rec-row:first-of-type {
  border-top: none;
}

.rec-time {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex: none;
}

.rec-channel {
  font-weight: 500;
  flex: none;
}

.rec-note {
  color: var(--muted);
  margin-left: auto;
  text-align: right;
}

.app-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.app-edit {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.app-edit input {
  width: auto;
  flex: 1;
  min-width: 140px;
}

.score-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.sel {
  flex: 1;
  min-width: 150px;
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

.d-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.confirm-box {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.confirm-text {
  font-size: 12px;
  color: var(--muted);
}

.opt-progress {
  list-style: none;
  display: flex;
  gap: 10px;
  margin: 10px 0;
  font-size: 12px;
  color: var(--muted);
}

.opt-round {
  display: inline-block;
  width: 16px;
  text-align: center;
}

.opt-progress .done {
  color: var(--fg);
}

.opt-gaps {
  list-style: none;
  margin: 8px 0;
  padding-left: 16px;
  font-size: 12px;
  color: var(--muted);
}

.opt-gaps li {
  list-style: disc;
}

.change {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-top: 10px;
}

.change-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.change-reason {
  font-size: 12px;
  color: var(--muted);
}

.change-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 8px;
}

.change-col {
  min-width: 0;
}

.change-label {
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.06em;
}

.change-text {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin-top: 4px;
}

.opt-json {
  margin-top: 10px;
  font-size: 12px;
}

.opt-json summary {
  cursor: pointer;
  color: var(--muted);
}

.json-pre {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 10px;
  margin-top: 6px;
  max-height: 300px;
  overflow: auto;
}

.compare-actions {
  margin-top: 10px;
}

.compare-panel {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.diff-list {
  list-style: none;
  margin: 8px 0;
}

.diff-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
}

.diff-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  flex: none;
}

.diff-changed .diff-badge {
  background: color-mix(in srgb, var(--accent) 9%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 28%, #dbdbdb);
  color: color-mix(in srgb, var(--accent) 78%, #000000);
}

.diff-section {
  font-weight: 500;
}

.diff-reason {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compare-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 8px;
}

.compare-label {
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.06em;
}

.json-textarea {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 4px;
  min-height: 260px;
  resize: vertical;
}

.compare-confirm {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.compare-confirm input {
  flex: 1;
  min-width: 0;
}
</style>
