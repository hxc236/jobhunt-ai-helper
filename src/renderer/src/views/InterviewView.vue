<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { IpcEvent } from '@shared/protocol'
import type { PositionListItem } from '@shared/types'

/**
 * 模拟面试（F-24/#38）：风格选择（真实/教学/压力）+ 对话流（打字机）+ 打断/补充 +
 * 文字输入兜底（ASR 未就绪时文字完成整场面试）。
 */

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

const positions = ref<PositionListItem[]>([])
const selectedJobId = ref('')
const style = ref<'real' | 'coach' | 'strict'>('real')
const STYLE_LABELS: Record<string, string> = { real: '真实', coach: '教学', strict: '压力' }

const sessionId = ref('')
const started = ref(false)
const starting = ref(false)
const ending = ref(false)
const messages = ref<ChatMessage[]>([])
const streamingText = ref('')
const sending = ref(false)
const inputText = ref('')
const followUpText = ref('')
const errorMessage = ref('')
const endMessage = ref('')

/** 语音输入（F-26/#40）：PTT 按住说话 → MediaRecorder 录音 → asr:transcribe → 回填输入框。 */
const asrReady = ref(false)
const asrHint = ref('')
const recording = ref(false)
const transcribing = ref(false)
const mediaRecorder = ref<MediaRecorder | null>(null)

async function checkAsr(): Promise<void> {
  try {
    const status = await window.api.asr.getStatus()
    asrReady.value = status.ready
    asrHint.value = status.reason ?? ''
  } catch {
    asrReady.value = false
    asrHint.value = '语音识别不可用——请使用文字输入'
  }
}

async function pttStart(event: PointerEvent): Promise<void> {
  if (!asrReady.value || recording.value) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: 'audio/webm' })
      const buf = await blob.arrayBuffer()
      if (buf.byteLength === 0) return
      transcribing.value = true
      try {
        const text = await window.api.asr.transcribe(new Uint8Array(buf))
        inputText.value = inputText.value === '' ? text : `${inputText.value} ${text}`
      } catch (err) {
        errorMessage.value = String(err)
      } finally {
        transcribing.value = false
      }
    }
    mediaRecorder.value = recorder
    recorder.start()
    recording.value = true
    // 忽略事件（保留类型签名）
    void event
  } catch (err) {
    asrReady.value = false
    asrHint.value = `麦克风不可用：${String(err)}——请使用文字输入`
  }
}

function pttStop(): void {
  if (!recording.value) return
  recording.value = false
  try {
    mediaRecorder.value?.stop()
  } catch {
    // 已停止
  }
  mediaRecorder.value = null
}

/** 历史回看与复盘（F-27/#41）。 */
interface HistoryItem {
  id: string
  job_id: string | null
  style: string
  status: string
  transcript: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>
  review: {
    total: number
    dimensions: Array<{ name: string; score: number; comment: string }>
    strengths: string[]
    weaknesses: Array<{ item: string; reference: string }>
    nextSteps: string[]
  } | null
  created_at: string
}

const history = ref<HistoryItem[]>([])
const detail = ref<HistoryItem | null>(null)
const suggestMessage = ref('')
const suggesting = ref(false)

const RING_CIRCUMFERENCE = 2 * Math.PI * 42

function ringOffset(scoreValue: number): number {
  return RING_CIRCUMFERENCE * (1 - scoreValue / 100)
}

function totalClass(scoreValue: number): string {
  if (scoreValue >= 80) return 'ring-green'
  if (scoreValue >= 60) return 'ring-blue'
  return 'ring-red'
}

function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

async function loadHistory(): Promise<void> {
  try {
    history.value = (await window.api.interview.history()) as HistoryItem[]
  } catch (err) {
    errorMessage.value = `加载历史失败：${String(err)}`
  }
}

/** suggestLearn：薄弱点一键入学习清单（source=interview，重复跳过）。 */
async function suggestLearn(): Promise<void> {
  const d = detail.value
  if (d === null || d.review === null) return
  suggesting.value = true
  suggestMessage.value = ''
  try {
    let added = 0
    let skipped = 0
    for (const w of d.review.weaknesses) {
      const topic = await window.api.topics.createInterviewSuggestion(
        w.item,
        w.reference !== '' ? `参考回答：${w.reference}` : '',
        d.job_id
      )
      if (topic === null) skipped++
      else added++
    }
    suggestMessage.value = `已加入学习清单 ${added} 条${skipped > 0 ? `（重复跳过 ${skipped} 条）` : ''}`
  } catch (err) {
    suggestMessage.value = `加入失败：${String(err)}`
  } finally {
    suggesting.value = false
  }
}

const STYLE_DESCS: Record<string, string> = {
  real: '真实面试官：追问细节、验证真实性',
  coach: '教练式：多鼓励、给提示、引导思考',
  strict: '压力面试：挑错、施压、要求精确'
}

const inProgress = computed(() => started.value && sessionId.value !== '' && !ending.value)

async function loadPositions(): Promise<void> {
  positions.value = await window.api.positions.list().catch(() => [] as PositionListItem[])
}

async function startInterview(): Promise<void> {
  if (selectedJobId.value === '') {
    errorMessage.value = '请先选择职位'
    return
  }
  starting.value = true
  errorMessage.value = ''
  endMessage.value = ''
  messages.value = []
  try {
    const result = await window.api.interview.start(selectedJobId.value, style.value)
    sessionId.value = result.sessionId
    started.value = true
    messages.value.push({ role: 'assistant', text: result.opening })
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    starting.value = false
  }
}

async function send(): Promise<void> {
  const text = inputText.value.trim()
  if (text === '' || sending.value || !inProgress.value) return
  inputText.value = ''
  messages.value.push({ role: 'user', text })
  sending.value = true
  streamingText.value = ''
  try {
    const reply = await window.api.interview.answer(sessionId.value, text)
    messages.value.push({ role: 'assistant', text: reply })
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    streamingText.value = ''
    sending.value = false
  }
}

async function interrupt(): Promise<void> {
  try {
    await window.api.interview.interrupt(sessionId.value)
    streamingText.value = ''
  } catch (err) {
    errorMessage.value = String(err)
  }
}

async function followUp(): Promise<void> {
  const text = followUpText.value.trim()
  if (text === '' || !inProgress.value) return
  followUpText.value = ''
  messages.value.push({ role: 'user', text: `（补充）${text}` })
  try {
    await window.api.interview.followUp(sessionId.value, text)
  } catch (err) {
    errorMessage.value = String(err)
  }
}

async function endInterview(): Promise<void> {
  ending.value = true
  errorMessage.value = ''
  try {
    const record = await window.api.interview.end(sessionId.value)
    endMessage.value = `面试已结束（${record.status}），共 ${record.transcript.length} 轮对话——复盘将在面试模块生成。`
    sessionId.value = ''
    started.value = false
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    ending.value = false
  }
}

onMounted(() => {
  void loadPositions()
  void checkAsr()
  void loadHistory()
  // 面试流式增量（agent:delta 按会话过滤）——打字机渲染
  const unsubscribe = window.api.on(IpcEvent.AgentDelta, (payload) => {
    if (payload.sessionId !== sessionId.value || !started.value) return
    streamingText.value += payload.delta
  })
  onUnmounted(unsubscribe)
})
</script>

<template>
  <section class="interview-view">
    <h1 class="page-title">模拟面试</h1>

    <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>
    <p v-if="endMessage" class="message success">{{ endMessage }}</p>

    <!-- 开始设置 -->
    <section v-if="!started" class="card">
      <h2 class="card-title">开始一场面试</h2>
      <div class="setup-bar">
        <select v-model="selectedJobId" class="input">
          <option value="" disabled>选择职位…</option>
          <option v-for="p in positions" :key="p.id" :value="p.id">
            {{ p.company }} · {{ p.title }}
          </option>
        </select>
        <label v-for="s in (['real', 'coach', 'strict'] as const)" :key="s" class="style-option">
          <input v-model="style" type="radio" :value="s" />
          <span class="style-name">{{ STYLE_LABELS[s] }}</span>
          <span class="style-desc">{{ STYLE_DESCS[s] }}</span>
        </label>
        <button class="btn btn-primary" type="button" :disabled="starting" @click="startInterview">
          {{ starting ? '准备中…' : '开始面试' }}
        </button>
      </div>
      <p class="hint">文字输入即可完成整场面试。</p>
      <p v-if="asrHint !== '' && !asrReady" class="message error asr-hint">{{ asrHint }}</p>
    </section>

    <!-- 历史回看与复盘（F-27/#41） -->
    <section v-if="!started" class="card">
      <h2 class="card-title">面试历史与复盘 <span class="count">{{ history.length }}</span></h2>
      <p v-if="history.length === 0" class="hint">暂无已完成面试——结束后自动生成复盘。</p>
      <ul v-else class="history-list">
        <li v-for="h in history" :key="h.id" class="history-row">
          <span class="pill" :class="h.review ? 'pill-has-review' : 'pill-no-review'">
            {{ h.review ? '已复盘' : '复盘生成中' }}
          </span>
          <span class="meta">{{ STYLE_LABELS[h.style] ?? h.style }}风格</span>
          <span v-if="h.review" class="history-score">{{ h.review.total }}分</span>
          <span class="meta">{{ fmtTime(h.created_at) }}</span>
          <button class="btn" type="button" @click="detail = h">查看详情</button>
        </li>
      </ul>
    </section>

    <!-- 复盘详情模态 -->
    <div v-if="detail" class="edit-overlay" @click.self="detail = null">
      <div class="detail-panel">
        <div class="detail-head">
          <span class="detail-title">面试详情（{{ fmtTime(detail.created_at) }}）</span>
          <button class="btn" type="button" @click="detail = null">关闭</button>
        </div>
        <p v-if="suggestMessage" class="message" :class="suggestMessage.startsWith('已加入') ? 'success' : 'error'">
          {{ suggestMessage }}
        </p>

        <template v-if="detail.review">
          <div class="review-top">
            <div class="ring-wrap" :class="totalClass(detail.review.total)">
              <svg viewBox="0 0 100 100" class="ring">
                <circle cx="50" cy="50" r="42" class="ring-track" />
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  class="ring-value"
                  :stroke-dasharray="RING_CIRCUMFERENCE"
                  :stroke-dashoffset="ringOffset(detail.review.total)"
                  transform="rotate(-90 50 50)"
                />
              </svg>
              <div class="ring-center">
                <span class="ring-total">{{ detail.review.total }}</span>
                <span class="ring-label">总分</span>
              </div>
            </div>
            <div class="dims">
              <div v-for="d in detail.review.dimensions" :key="d.name" class="dim">
                <span class="dim-name">{{ d.name }}</span>
                <span class="dim-bar"><i :style="{ width: d.score + '%' }" :class="totalClass(d.score)" /></span>
                <span class="dim-score">{{ d.score }}</span>
              </div>
            </div>
          </div>

          <p v-if="detail.review.strengths.length > 0" class="block-label">亮点</p>
          <ul class="plain-list">
            <li v-for="(s, i) in detail.review.strengths" :key="i">{{ s }}</li>
          </ul>

          <p class="block-label">薄弱点</p>
          <ul class="plain-list">
            <li v-for="(w, i) in detail.review.weaknesses" :key="i">
              <span>{{ w.item }}</span>
              <details class="ref">
                <summary>参考回答</summary>
                <p class="ref-text">{{ w.reference }}</p>
              </details>
            </li>
          </ul>

          <p v-if="detail.review.nextSteps.length > 0" class="block-label">下一步建议</p>
          <ul class="plain-list">
            <li v-for="(n, i) in detail.review.nextSteps" :key="i">{{ n }}</li>
          </ul>

          <div class="detail-actions">
            <button class="btn btn-primary" type="button" :disabled="suggesting" @click="suggestLearn">
              {{ suggesting ? '加入中…' : '薄弱点一键加入学习清单' }}
            </button>
          </div>
        </template>
        <p v-else class="hint">复盘生成失败或尚未生成。</p>

        <details class="transcript">
          <summary>对话回看（{{ detail.transcript.length }} 轮）</summary>
          <div class="transcript-body">
            <div v-for="(m, i) in detail.transcript" :key="i" class="t-msg" :class="m.role">
              <span class="t-role">{{ m.role === 'user' ? '我' : '面试官' }}</span>
              <span class="t-text">{{ m.text }}</span>
            </div>
          </div>
        </details>
      </div>
    </div>

    <!-- 会话 -->
    <section v-else class="card">
      <h2 class="card-title">
        面试中
        <span class="pill">{{ STYLE_LABELS[style] }}风格</span>
        <span class="pill pill-job">{{ positions.find((p) => p.id === selectedJobId)?.company ?? '' }}</span>
      </h2>

      <div class="chat-body">
        <div v-for="(m, i) in messages" :key="i" class="chat-msg" :class="m.role">
          <span class="chat-role">{{ m.role === 'user' ? '我' : '面试官' }}</span>
          <span class="chat-text">{{ m.text }}</span>
        </div>
        <div v-if="streamingText !== ''" class="chat-msg assistant">
          <span class="chat-role">面试官</span>
          <span class="chat-text">{{ streamingText }}</span>
          <span class="chat-cursor">▌</span>
        </div>
      </div>

      <div class="chat-controls">
        <div class="input-bar">
          <input
            v-model="inputText"
            class="input"
            placeholder="输入回答（文字兜底，回车发送）…"
            :disabled="sending"
            @keyup.enter="send"
          />
          <button class="btn btn-primary" type="button" :disabled="sending" @click="send">
            {{ sending ? '思考中…' : '发送' }}
          </button>
          <button
            v-if="asrReady"
            class="btn ptt-btn"
            :class="{ recording }"
            type="button"
            @pointerdown="pttStart"
            @pointerup="pttStop"
            @pointerleave="pttStop"
          >
            {{ transcribing ? '识别中…' : recording ? '松开结束说话' : '按住说话' }}
          </button>
          <button class="btn" type="button" :disabled="!sending && streamingText === ''" @click="interrupt">
            打断
          </button>
        </div>
        <div class="input-bar">
          <input
            v-model="followUpText"
            class="input"
            placeholder="补充说明（当前回答结束后插入）…"
            @keyup.enter="followUp"
          />
          <button class="btn" type="button" @click="followUp">补充</button>
          <button class="btn btn-danger" type="button" :disabled="ending" @click="endInterview">
            {{ ending ? '收尾中…' : '结束面试' }}
          </button>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.interview-view {
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

.setup-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.setup-bar .input {
  flex: 1;
  min-width: 220px;
}

.style-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.style-name {
  font-weight: 600;
}

.style-desc {
  color: #6b7280;
  font-size: 12px;
}

.pill {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.pill-job {
  background: #f5f3ff;
  color: #6d28d9;
}

.chat-body {
  height: 380px;
  overflow-y: auto;
  padding: 12px 14px;
  background: #fafbfc;
  border: 1px solid #eef0f3;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.chat-msg {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
}

.chat-msg.user {
  flex-direction: row-reverse;
}

.chat-role {
  flex-shrink: 0;
  font-size: 11px;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 4px;
  padding: 2px 6px;
  height: fit-content;
}

.chat-msg.user .chat-role {
  background: #eff6ff;
  color: #1d4ed8;
}

.chat-text {
  white-space: pre-wrap;
  word-break: break-word;
  background: #fff;
  border: 1px solid #f0f1f3;
  border-radius: 6px;
  padding: 6px 10px;
  max-width: 78%;
}

.chat-msg.user .chat-text {
  background: #eff6ff;
  border-color: #dbeafe;
}

.chat-cursor {
  animation: blink 1s step-end infinite;
  color: #2b5ca8;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.chat-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-bar {
  display: flex;
  gap: 8px;
}

.input-bar .input {
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

.ptt-btn.recording {
  background: #dc2626;
  border-color: #dc2626;
  color: #fff;
}

/* 历史与复盘（F-27/#41） */
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid #f0f1f3;
  font-size: 13px;
}

.history-row:last-child {
  border-bottom: none;
}

.history-score {
  font-weight: 700;
  color: #2b5ca8;
}

.pill-has-review {
  background: #ecfdf5;
  color: #059669;
}

.pill-no-review {
  background: #f3f4f6;
  color: #6b7280;
}

.detail-panel {
  background: #fff;
  border-radius: 8px;
  width: min(720px, 100%);
  height: min(680px, 92%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e7eb;
}

.detail-title {
  font-weight: 600;
  font-size: 14px;
}

.review-top {
  display: flex;
  gap: 20px;
  align-items: center;
  padding: 14px 14px 0;
}

.ring-wrap {
  position: relative;
  width: 110px;
  height: 110px;
  flex-shrink: 0;
}

.ring {
  width: 100%;
  height: 100%;
}

.ring-track {
  fill: none;
  stroke: #f0f1f3;
  stroke-width: 10;
}

.ring-value {
  fill: none;
  stroke-width: 10;
  stroke-linecap: round;
}

.ring-green .ring-value {
  stroke: #059669;
}

.ring-blue .ring-value {
  stroke: #2b5ca8;
}

.ring-red .ring-value {
  stroke: #dc2626;
}

.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.ring-total {
  font-size: 24px;
  font-weight: 700;
}

.ring-label {
  font-size: 11px;
  color: #6b7280;
}

.dims {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dim {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.dim-name {
  width: 56px;
}

.dim-bar {
  flex: 1;
  height: 7px;
  background: #f0f1f3;
  border-radius: 999px;
  overflow: hidden;
}

.dim-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
}

.dim-score {
  width: 24px;
  text-align: right;
  font-weight: 600;
}

.block-label {
  margin: 12px 14px 4px;
  font-size: 12px;
  color: #6b7280;
}

.plain-list {
  margin: 0 14px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
}

.ref {
  margin-left: 8px;
  font-size: 12px;
}

.ref summary {
  color: #2b5ca8;
  cursor: pointer;
}

.ref-text {
  margin: 4px 0 0;
  color: #374151;
  background: #fafbfc;
  border-radius: 4px;
  padding: 6px 8px;
}

.detail-actions {
  padding: 12px 14px 0;
}

.transcript {
  margin: 14px;
  font-size: 13px;
}

.transcript summary {
  cursor: pointer;
  color: #2b5ca8;
}

.transcript-body {
  margin-top: 8px;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.t-msg {
  display: flex;
  gap: 6px;
  font-size: 12px;
}

.t-msg.user {
  flex-direction: row-reverse;
}

.t-role {
  flex-shrink: 0;
  font-size: 10px;
  color: #6b7280;
}

.t-text {
  background: #fafbfc;
  border-radius: 4px;
  padding: 4px 8px;
  max-width: 80%;
}

.t-msg.user .t-text {
  background: #eff6ff;
}

.asr-hint {
  font-size: 12px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.input {
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
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

.hint {
  margin: 10px 0 0;
  color: #6b7280;
  font-size: 12px;
}
</style>
