<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { BATCHES, COMPANY_TYPES, type Batch, type Position, type PositionInput } from '@shared/types'

/** 表单态：batch 额外允许空串（「未指定」选项），提交时转 undefined。 */
type PositionFormState = Omit<PositionInput, 'batch'> & { batch: Batch | '' }

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

const form = reactive<PositionFormState>(emptyForm())
const positions = ref<Position[]>([])
const submitting = ref(false)
const loading = ref(false)
/** 表单级错误提示（校验失败/重复录入等；主进程 PositionError message 透传）。 */
const errorMessage = ref('')
const successMessage = ref('')

async function loadPositions(): Promise<void> {
  loading.value = true
  try {
    positions.value = await window.api.positions.list()
  } catch (err) {
    errorMessage.value = `加载职位列表失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

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
    await loadPositions()
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    submitting.value = false
  }
}

onMounted(loadPositions)
</script>

<template>
  <section class="jobs-view">
    <h1 class="page-title">职位</h1>

    <section class="card">
      <h2 class="card-title">手动录入职位卡</h2>

      <form class="form" @submit.prevent="submit">
        <div class="form-grid">
          <label class="field">
            <span class="label">公司 <em class="required">*</em></span>
            <input v-model="form.company" class="input" placeholder="如：腾讯" />
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
      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="positions.length === 0" class="hint">
        暂无职位卡。录入第一条后即在此可见（筛选与倒计时徽标见 F-02）。
      </p>
      <ul v-else class="position-list">
        <li v-for="p in positions" :key="p.id" class="position-row">
          <span class="company">{{ p.company }}</span>
          <span class="title">{{ p.title }}</span>
          <span class="pill">{{ p.company_type }}</span>
          <span v-if="p.batch" class="pill pill-batch">{{ p.batch }}</span>
          <span v-if="p.city" class="meta">{{ p.city }}</span>
          <span class="meta">
            网申：{{ p.start_date ?? '—' }} ~ {{ p.end_date ?? '待核实' }}
          </span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.jobs-view {
  max-width: 720px;
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
}

.position-row:last-child {
  border-bottom: none;
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
}

.pill-batch {
  background: #f3f4f6;
  color: #374151;
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
