<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  APPLICATION_TRANSITIONS,
  BATCHES,
  COMPANY_TYPES,
  POSITION_STATUSES,
  type Application,
  type ApplicationStatus,
  type Batch,
  type CompanyType,
  type Position,
  type PositionStatus
} from '@shared/types'

const route = useRoute()
const router = useRouter()
const positionId = String(route.params.id)

/** 编辑表单态：batch 额外允许空串（「未指定」），保存时转 null（服务端清空语义）。 */
type EditFormState = {
  company: string
  company_type: CompanyType
  title: string
  jd: string
  city: string
  channel: string
  channel_url: string
  recruit_season: string
  batch: Batch | ''
  start_date: string
  end_date: string
  status: PositionStatus
  notes: string
}

const position = ref<Position | null>(null)
const application = ref<Application | null>(null)
const loading = ref(true)
const errorMessage = ref('')
/** 投递状态操作错误（非法流转等；message 透传）。 */
const appError = ref('')
const appSaving = ref(false)
/** 投递渠道/日期编辑表单（预填当前值，保存走同状态 setApplication）。 */
const appForm = reactive({ channel: '', appliedDate: '' })
/** 编辑模式：详情展示 ⇄ 编辑表单。 */
const editing = ref(false)
/** 删除确认：两步内联确认（避免误删；确认文案明示级联删除投递记录）。 */
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
  recruit_season: '',
  batch: '',
  start_date: '',
  end_date: '',
  status: 'active',
  notes: ''
})

const SOURCE_LABELS: Record<Position['source'], string> = {
  manual: '手动录入',
  nowcoder: '牛客采集',
  liepin: '猎聘采集'
}

/** 投递状态 → 进入时刻列（applications 表；渲染层展示时间线用）。 */
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

/** 当前状态可达的下一步（状态机表共用 shared；withdrawn 为终态时为空数组）。 */
const nextActions = computed<ApplicationStatus[]>(() =>
  application.value === null ? [] : [...APPLICATION_TRANSITIONS[application.value.status]]
)

/** 是否有已记录的状态时刻（时间线显示开关）。 */
const hasTimeline = computed(
  () =>
    application.value !== null &&
    APPLICATION_STATUSES.some((s) => application.value?.[STATUS_TS_KEY[s]] !== null)
)

/** 网申截止倒计时（与列表 days_left 同口径：日历天，null=待核实；仅详情展示用）。 */
function daysLeft(endDate: string | null): number | null {
  if (endDate === null) return null
  const [year, month, day] = endDate.split('-').map(Number)
  const end = Date.UTC(year, month - 1, day) / 86_400_000
  const today = new Date()
  const now = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000)
  return end - now
}

const daysLeftValue = computed(() => daysLeft(position.value?.end_date ?? null))

function badgeText(days: number | null): string {
  if (days === null) return '待核实'
  if (days <= 0) return '已截止'
  return `剩 ${days} 天`
}

function badgeClass(days: number | null): string {
  if (days === null) return 'badge badge-unknown'
  return days <= 14 ? 'badge badge-urgent' : 'badge badge-normal'
}

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    position.value = await window.api.positions.get(positionId)
    application.value = await window.api.positions.getApplication(positionId)
    fillAppForm()
  } catch (err) {
    errorMessage.value = `加载职位详情失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

/** 渠道/日期表单预填；空值用空串（保存时转 null 清空）。 */
function fillAppForm(): void {
  appForm.channel = application.value?.channel ?? ''
  appForm.appliedDate = application.value?.applied_date ?? ''
}

/** 状态流转（含首次创建：隐含起点 planned，可直达 applied/withdrawn）。 */
async function transition(target: ApplicationStatus): Promise<void> {
  appError.value = ''
  appSaving.value = true
  try {
    application.value = await window.api.positions.setApplication(positionId, { status: target })
    fillAppForm()
  } catch (err) {
    appError.value = String(err)
  } finally {
    appSaving.value = false
  }
}

/** 编辑渠道/投递日期：同状态调用（不触发流转；空串 → null 清空）。 */
async function saveApplicationEdit(): Promise<void> {
  if (application.value === null) return
  appError.value = ''
  appSaving.value = true
  try {
    application.value = await window.api.positions.setApplication(positionId, {
      status: application.value.status,
      channel: appForm.channel === '' ? null : appForm.channel,
      appliedDate: appForm.appliedDate === '' ? null : appForm.appliedDate
    })
  } catch (err) {
    appError.value = String(err)
  } finally {
    appSaving.value = false
  }
}

/** 编辑表单预填当前值；空值用空串（保存时空串 → null 清空，与服务 patch 语义一致）。 */
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
    recruit_season: p.recruit_season,
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
    position.value = await window.api.positions.update(positionId, {
      company: form.company.trim(),
      company_type: form.company_type,
      title: form.title.trim(),
      jd: form.jd,
      // 空串 → null：服务端清空可选字段（与录入归一语义一致）
      city: form.city === '' ? null : form.city,
      channel: form.channel === '' ? null : form.channel,
      channel_url: form.channel_url === '' ? null : form.channel_url,
      recruit_season: form.recruit_season.trim(),
      batch: form.batch === '' ? null : form.batch,
      start_date: form.start_date === '' ? null : form.start_date,
      end_date: form.end_date === '' ? null : form.end_date,
      status: form.status,
      notes: form.notes
    })
    editing.value = false
  } catch (err) {
    formError.value = String(err)
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  saving.value = true
  try {
    await window.api.positions.delete(positionId)
    router.push('/jobs')
  } catch (err) {
    errorMessage.value = `删除失败：${String(err)}`
    deleteConfirming.value = false
  } finally {
    saving.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section class="detail-view">
    <button class="btn btn-ghost" type="button" @click="router.push('/jobs')">← 返回职位列表</button>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="errorMessage" class="message error">{{ errorMessage }}</p>

    <template v-else-if="position">
      <!-- 详情卡片：JD 全文 / 渠道链接 / 操作区 -->
      <section class="card">
        <header class="header">
          <div class="title-row">
            <h1 class="title">{{ position.company }} · {{ position.title }}</h1>
            <span :class="badgeClass(daysLeftValue)">{{ badgeText(daysLeftValue) }}</span>
          </div>
          <div class="pills">
            <span class="pill">{{ position.company_type }}</span>
            <span v-if="position.batch" class="pill pill-batch">{{ position.batch }}</span>
            <span class="pill" :class="position.status === 'active' ? 'pill-active' : 'pill-closed'">
              {{ position.status === 'active' ? '进行中' : '已关闭' }}
            </span>
            <span class="pill pill-source">{{ SOURCE_LABELS[position.source] }}</span>
          </div>
        </header>

        <dl class="meta-grid">
          <div class="meta-item">
            <dt>城市</dt>
            <dd>{{ position.city ?? '—' }}</dd>
          </div>
          <div class="meta-item">
            <dt>秋招季</dt>
            <dd>{{ position.recruit_season }}</dd>
          </div>
          <div class="meta-item">
            <dt>投递渠道</dt>
            <dd>
              <template v-if="position.channel_url">
                <a :href="position.channel_url" target="_blank" rel="noreferrer">
                  {{ position.channel ?? '渠道链接' }} ↗
                </a>
              </template>
              <template v-else>{{ position.channel ?? '—' }}</template>
            </dd>
          </div>
          <div class="meta-item">
            <dt>网申窗口</dt>
            <dd>{{ position.start_date ?? '—' }} ~ {{ position.end_date ?? '待核实' }}</dd>
          </div>
          <div class="meta-item">
            <dt>更新时间</dt>
            <dd>{{ position.updated_at.slice(0, 10) }}</dd>
          </div>
        </dl>

        <section class="block">
          <h2 class="block-title">JD 全文</h2>
          <p v-if="position.jd === ''" class="hint">未填写 JD——可点击「编辑」补充，供简历优化与面试使用。</p>
          <p v-else class="jd-text">{{ position.jd }}</p>
        </section>

        <section v-if="position.notes !== ''" class="block">
          <h2 class="block-title">备注</h2>
          <p class="notes-text">{{ position.notes }}</p>
        </section>

        <div class="actions">
          <button class="btn btn-primary" type="button" @click="startEdit">编辑</button>
          <button
            class="btn btn-danger"
            type="button"
            :disabled="deleteConfirming"
            @click="deleteConfirming = true"
          >
            删除
          </button>
        </div>

        <!-- 删除确认（内联两步） -->
        <div v-if="deleteConfirming" class="confirm-box">
          <p class="confirm-text">
            确认删除「{{ position.company }} · {{ position.title }}」？该职位的投递记录将一并删除，且不可恢复。
          </p>
          <div class="confirm-actions">
            <button class="btn btn-danger" type="button" :disabled="saving" @click="confirmDelete">
              {{ saving ? '删除中…' : '确认删除' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="deleteConfirming = false">取消</button>
          </div>
        </div>
      </section>

      <!-- 投递状态卡片（F-05/#21：状态机操作 + 记录展示） -->
      <section class="card">
        <h2 class="card-title">投递状态</h2>

        <template v-if="application">
          <div class="app-status-row">
            <span class="app-badge" :class="`app-${application.status}`">
              {{ APPLICATION_STATUS_LABELS[application.status] }}
            </span>
            <span class="meta">渠道：{{ application.channel ?? '—' }}</span>
            <span class="meta">投递日期：{{ application.applied_date ?? '—' }}</span>
          </div>

          <!-- 投递记录时间线（各状态进入时刻；复盘数据来源） -->
          <ul v-if="hasTimeline" class="timeline">
            <li v-for="s in APPLICATION_STATUSES" :key="s" v-show="application[STATUS_TS_KEY[s]] !== null">
              <span class="timeline-label">{{ APPLICATION_STATUS_LABELS[s] }}</span>
              <span class="meta">{{ formatTs(application[STATUS_TS_KEY[s]]) }}</span>
            </li>
          </ul>

          <div v-if="nextActions.length > 0" class="app-actions">
            <button
              v-for="target in nextActions"
              :key="target"
              class="btn"
              :class="target === 'withdrawn' ? 'btn-danger' : 'btn-primary'"
              type="button"
              :disabled="appSaving"
              @click="transition(target)"
            >
              {{ APPLICATION_STATUS_LABELS[target] }}
            </button>
          </div>
          <p v-else class="hint">已到终态（{{ APPLICATION_STATUS_LABELS[application.status] }}）。</p>

          <form class="app-edit" @submit.prevent="saveApplicationEdit">
            <input v-model="appForm.channel" class="input" placeholder="投递渠道（留空清除）" />
            <input v-model="appForm.appliedDate" class="input" type="date" />
            <button class="btn" type="submit" :disabled="appSaving">保存渠道/日期</button>
          </form>
        </template>

        <template v-else>
          <p class="hint">
            尚未开始投递——标记后即可跟踪状态流转（已投递 → 面试中 → offer/已拒绝，可随时放弃）。
          </p>
          <div class="app-actions">
            <button class="btn btn-primary" type="button" :disabled="appSaving" @click="transition('applied')">
              标记已投递
            </button>
            <button class="btn btn-danger" type="button" :disabled="appSaving" @click="transition('withdrawn')">
              标记已放弃
            </button>
          </div>
        </template>

        <p v-if="appError" class="message error">{{ appError }}</p>
      </section>

      <!-- 编辑表单卡片 -->
      <section v-if="editing" class="card">
        <h2 class="card-title">编辑职位卡</h2>

        <form class="form" @submit.prevent="saveEdit">
          <div class="form-grid">
            <label class="field">
              <span class="label">公司 <em class="required">*</em></span>
              <input v-model="form.company" class="input" />
            </label>
            <label class="field">
              <span class="label">岗位 <em class="required">*</em></span>
              <input v-model="form.title" class="input" />
            </label>
            <label class="field">
              <span class="label">企业性质</span>
              <select v-model="form.company_type" class="input">
                <option v-for="t in COMPANY_TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
            <label class="field">
              <span class="label">秋招季</span>
              <input v-model="form.recruit_season" class="input" />
            </label>
            <label class="field">
              <span class="label">城市</span>
              <input v-model="form.city" class="input" placeholder="留空清除" />
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
            <label class="field">
              <span class="label">状态</span>
              <select v-model="form.status" class="input">
                <option v-for="s in POSITION_STATUSES" :key="s" :value="s">
                  {{ s === 'active' ? '进行中' : '已关闭' }}
                </option>
              </select>
            </label>
            <label class="field field-wide">
              <span class="label">JD</span>
              <textarea v-model="form.jd" class="input textarea" rows="6" placeholder="职位描述全文…" />
            </label>
            <label class="field field-wide">
              <span class="label">备注</span>
              <textarea v-model="form.notes" class="input textarea" rows="2" placeholder="选填" />
            </label>
          </div>

          <p v-if="formError" class="message error">{{ formError }}</p>

          <div class="form-actions">
            <button class="btn btn-primary" type="submit" :disabled="saving">
              {{ saving ? '保存中…' : '保存修改' }}
            </button>
            <button class="btn" type="button" :disabled="saving" @click="editing = false">取消</button>
          </div>
        </form>
      </section>
    </template>
  </section>
</template>

<style scoped>
.detail-view {
  max-width: 880px;
}

.card {
  padding: 16px 20px;
  margin: 16px 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.header {
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f1f3;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title {
  margin: 0 0 8px;
  font-size: 20px;
}

.pills {
  display: flex;
  gap: 8px;
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

.pill-source {
  background: #f5f3ff;
  color: #6d28d9;
}

.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.badge-urgent {
  background: #fee2e2;
  color: #dc2626;
}

.badge-normal {
  background: #eff6ff;
  color: #1d4ed8;
}

.badge-unknown {
  background: #f3f4f6;
  color: #6b7280;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 24px;
  margin: 14px 0;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-item dt {
  font-size: 12px;
  color: #6b7280;
}

.meta-item dd {
  margin: 0;
  font-size: 13px;
}

.meta-item a {
  color: #2b5ca8;
}

.block {
  margin: 14px 0;
}

.block-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.jd-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.notes-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.actions {
  display: flex;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid #f0f1f3;
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

.app-status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.app-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
}

.app-planned {
  background: #f3f4f6;
  color: #6b7280;
}

.app-applied {
  background: #eff6ff;
  color: #1d4ed8;
}

.app-interviewing {
  background: #fef3c7;
  color: #b45309;
}

.app-offer {
  background: #ecfdf5;
  color: #059669;
}

.app-rejected {
  background: #fee2e2;
  color: #dc2626;
}

.app-withdrawn {
  background: #f3f4f6;
  color: #6b7280;
}

.timeline {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}

.timeline li {
  display: flex;
  gap: 10px;
  padding: 2px 0;
  font-size: 13px;
}

.timeline-label {
  color: #374151;
}

.app-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.app-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.app-edit .input {
  flex: 1;
  min-width: 160px;
}

.card-title {
  margin: 0 0 12px;
  font-size: 15px;
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

.btn-ghost {
  border-color: transparent;
  background: transparent;
  color: #2b5ca8;
  padding-left: 0;
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
</style>
