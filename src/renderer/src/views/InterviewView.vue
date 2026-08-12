<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { IpcEvent } from '@shared/protocol'
import type { PositionListItem } from '@shared/types'
import Modal from '../components/Modal.vue'
import MatchGauge from '../components/MatchGauge.vue'
import Icon from '../components/Icon.vue'
import Pill from '../components/Pill.vue'

/**
 * 模拟面试（#42 T5）：准备（职位+风格卡片）→ 会话（PTT + 文字 + 打断）→
 * 历史与复盘（总分环/维度/亮点/薄弱点一键入清单/对话回看）。
 * 功能 = 原 InterviewView（F-24/#38 + F-26/#40 PTT + F-27/#41 复盘）。
 */

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

const positions = ref<PositionListItem[]>([])
const selectedJobId = ref('')
const style = ref<'real' | 'coach' | 'strict'>('real')
const STYLE_LABELS: Record<string, string> = { real: '真实', coach: '教学', strict: '压力' }
const STYLE_DESCS: Record<string, string> = {
  real: '真实面试官：追问细节、验证真实性',
  coach: '教练式：多鼓励、给提示、引导思考',
  strict: '压力面试：挑错、施压、要求精确'
}

const sessionId = ref('')
const started = ref(false)
const starting = ref(false)
const ending = ref(false)
const messages = ref<ChatMessage[]>([])
const streamingText = ref('')
const sending = ref(false)
const inputText = ref('')
const errorMessage = ref('')
const endMessage = ref('')

/** 语音输入（F-26/#40）：PTT 按住说话。 */
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

async function pttStart(): Promise<void> {
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

/** suggestLearn：单个薄弱点一键入学习清单（source=interview，重复跳过）。 */
async function suggestOne(item: string, reference: string): Promise<void> {
  const d = detail.value
  if (d === null) return
  suggesting.value = true
  suggestMessage.value = ''
  try {
    const topic = await window.api.topics.createInterviewSuggestion(
      item,
      reference !== '' ? `参考回答：${reference}` : '',
      d.job_id
    )
    suggestMessage.value = topic === null ? `「${item}」已在清单中，跳过` : `已加入学习清单：「${item}」`
  } catch (err) {
    suggestMessage.value = `加入失败：${String(err)}`
  } finally {
    suggesting.value = false
  }
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

async function endInterview(): Promise<void> {
  ending.value = true
  errorMessage.value = ''
  try {
    const record = await window.api.interview.end(sessionId.value)
    endMessage.value = `面试已结束（${record.status}），共 ${record.transcript.length} 轮对话——复盘已生成，可在下方历史中查看。`
    sessionId.value = ''
    started.value = false
    await loadHistory()
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
  const unsubscribe = window.api.on(IpcEvent.AgentDelta, (payload) => {
    if (payload.sessionId !== sessionId.value || !started.value) return
    streamingText.value += payload.delta
  })
  onUnmounted(unsubscribe)
})
</script>

<template>
  <section class="view iv">
    <!-- ===== 准备 + 历史 ===== -->
    <div v-if="!started" class="iv-scroll">
      <p v-if="errorMessage" class="iv-msg err">{{ errorMessage }}</p>
      <p v-if="endMessage" class="iv-msg ok">{{ endMessage }}</p>

      <div class="card iv-card">
        <h1>模拟面试</h1>
        <p class="iv-desc">
          基于职位卡 JD 分析、你的优化简历与已掌握清单，生成结构化面试官（开场 → 技术面 → 反问 → 收尾）。
        </p>

        <div class="field" style="margin-bottom: 16px">
          <label>职位卡</label>
          <select v-model="selectedJobId">
            <option value="" disabled>选择职位…</option>
            <option v-for="p in positions" :key="p.id" :value="p.id">
              {{ p.company }} · {{ p.title }}
            </option>
          </select>
        </div>

        <div class="field">
          <label>面试风格</label>
          <div class="style-grid">
            <button
              v-for="s in (['real', 'coach', 'strict'] as const)"
              :key="s"
              class="style-card"
              :class="{ on: style === s }"
              type="button"
              @click="style = s"
            >
              <b>{{ STYLE_LABELS[s] }}</b>
              <span>{{ STYLE_DESCS[s] }}</span>
            </button>
          </div>
        </div>

        <div style="margin-top: 20px">
          <button class="btn primary big" type="button" :disabled="starting" @click="startInterview">
            <Icon name="mic" />{{ starting ? '准备中…' : '开始面试' }}
          </button>
        </div>

        <p class="iv-hint">
          语音：按住说话作答（本地识别，松开自动发送）· 未配置语音模型时自动降级为文字输入
        </p>
        <p v-if="asrHint !== '' && !asrReady" class="iv-msg warn">{{ asrHint }}</p>
      </div>

      <div class="card">
        <div class="sec-head">
          <h2>面试历史与复盘</h2>
          <span class="pill ghost">共 {{ history.length }} 场</span>
        </div>
        <p v-if="history.length === 0" class="hint">暂无已完成面试——结束后自动生成复盘。</p>
        <div v-else class="his-list">
          <div v-for="h in history" :key="h.id" class="his-row">
            <Pill :tone="h.review ? 'tint' : 'ghost'">
              {{ h.review ? '已复盘' : '复盘生成中' }}
            </Pill>
            <span class="his-meta">{{ STYLE_LABELS[h.style] ?? h.style }}风格</span>
            <span v-if="h.review" class="his-score">{{ h.review.total }}分</span>
            <span class="his-meta">{{ fmtTime(h.created_at) }}</span>
            <button class="link" type="button" style="margin-left: auto" @click="detail = h">查看详情</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 会话 ===== -->
    <div v-else class="iv-session">
      <div class="iv-top">
        <b>{{ positions.find((p) => p.id === selectedJobId)?.company ?? '' }} · {{ positions.find((p) => p.id === selectedJobId)?.title ?? '' }}</b>
        <span class="pill ghost">风格：{{ STYLE_LABELS[style] }}</span>
        <span style="flex: 1"></span>
        <button class="btn" type="button" :disabled="ending" @click="endInterview">
          {{ ending ? '收尾中…' : '结束面试' }}
        </button>
      </div>

      <div class="chat-flow">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <span class="msg-role">{{ m.role === 'user' ? '我' : '面试官' }}</span>
          <span class="msg-text">{{ m.text }}</span>
        </div>
        <div v-if="streamingText !== ''" class="msg ai">
          <span class="msg-role">面试官</span>
          <span class="msg-text">{{ streamingText }}</span>
          <span class="caret"></span>
        </div>
        <p v-if="errorMessage" class="iv-msg err">{{ errorMessage }}</p>
      </div>

      <div class="iv-inputbar">
        <button
          v-if="asrReady"
          class="ptt"
          :class="{ rec: recording }"
          type="button"
          :aria-label="recording ? '松开结束说话' : '按住说话'"
          @pointerdown="pttStart"
          @pointerup="pttStop"
          @pointerleave="pttStop"
        >
          <Icon name="mic" />
          <span class="ptt-label">{{ transcribing ? '识别中…' : recording ? '松开结束' : '按住说话' }}</span>
        </button>
        <input
          v-model="inputText"
          :placeholder="asrReady ? '也可以直接打字回答…' : '输入回答（回车发送）…'"
          :aria-label="asrReady ? '也可以直接打字回答' : '输入回答'"
          :disabled="sending"
          @keyup.enter="send"
        />
        <button class="btn primary" type="button" :disabled="sending" @click="send">
          {{ sending ? '思考中…' : '发送' }}
        </button>
        <button class="btn ghost" type="button" :disabled="!sending && streamingText === ''" @click="interrupt">
          <Icon name="pause" />打断
        </button>
      </div>
    </div>
  </section>

  <!-- ===== 弹窗：复盘详情 ===== -->
  <Modal :open="detail !== null" title="面试复盘" @close="detail = null">
    <template #head-actions>
      <span class="pill ghost" style="margin-right: 4px">
        {{ detail ? fmtTime(detail.created_at) : '' }}
        <template v-if="detail"> · {{ STYLE_LABELS[detail.style] ?? detail.style }}风格</template>
      </span>
    </template>

    <p v-if="suggestMessage" class="iv-msg" :class="suggestMessage.startsWith('已加入') ? 'ok' : 'err'">
      {{ suggestMessage }}
    </p>

    <template v-if="detail?.review">
      <div class="card surface" style="margin-top: 0">
        <div class="rv-top">
          <MatchGauge :total="detail.review.total" :dims="detail.review.dimensions.map((d) => ({ label: d.name, score: d.score }))" label="总分" />
        </div>
      </div>

      <div class="card">
        <div class="sec-head"><h2>亮点</h2></div>
        <div v-if="detail.review.strengths.length > 0" class="sect" v-for="(s, i) in detail.review.strengths" :key="i">
          <Icon name="check" class="good" /><span>{{ s }}</span>
        </div>
        <p v-else class="hint">无。</p>
      </div>

      <div class="card">
        <div class="sec-head"><h2>薄弱点</h2><span class="pill ghost">可一键回填学习清单</span></div>
        <div v-if="detail.review.weaknesses.length > 0" class="sect" v-for="(w, i) in detail.review.weaknesses" :key="i">
          <Icon name="info" class="weak" />
          <div class="weak-body">
            <div class="weak-title">{{ w.item }}</div>
            <div class="weak-detail">{{ w.reference }}</div>
          </div>
          <button class="btn weak-add" type="button" :disabled="suggesting" @click="suggestOne(w.item, w.reference)">
            加入学习清单
          </button>
        </div>
        <p v-else class="hint">无。</p>
      </div>

      <div v-if="detail.review.nextSteps.length > 0" class="card">
        <div class="sec-head"><h2>下一步建议</h2></div>
        <div class="sect" v-for="(n, i) in detail.review.nextSteps" :key="i">
          <Icon name="check" class="good" /><span>{{ n }}</span>
        </div>
      </div>

      <details class="transcript">
        <summary>对话回看（{{ detail.transcript.length }} 轮）</summary>
        <div class="transcript-body">
          <div v-for="(m, i) in detail.transcript" :key="i" class="t-msg" :class="m.role">
            <span class="t-role">{{ m.role === 'user' ? '我' : '面试官' }}</span>
            <span class="t-text">{{ m.text }}</span>
          </div>
        </div>
      </details>
    </template>
    <p v-else class="hint">复盘生成失败或尚未生成。</p>
  </Modal>
</template>

<style scoped>
.iv {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.iv-scroll {
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.iv-scroll > * {
  width: 100%;
  max-width: 640px;
}

.iv-msg {
  font-size: 12px;
  line-height: 1.6;
  margin: 0 0 8px;
}

.iv-msg.err {
  color: #dc2626;
}

.iv-msg.ok {
  color: #059669;
}

.iv-msg.warn {
  color: #92400e;
  background: color-mix(in srgb, #d97706 10%, #ffffff);
  border: 1px solid color-mix(in srgb, #d97706 30%, #dbdbdb);
  border-radius: var(--radius);
  padding: 6px 10px;
}

.iv-card h1 {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.iv-desc {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.7;
  margin: 8px 0 16px;
}

.style-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}

.style-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  cursor: pointer;
  font-family: var(--font);
  transition: border-color 0.12s, background 0.12s;
}

.style-card:hover {
  border-color: var(--muted);
}

.style-card.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, #ffffff);
}

.style-card b {
  font-size: 13px;
  letter-spacing: -0.01em;
}

.style-card span {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}

.iv-hint {
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 12px;
  line-height: 1.6;
}

.hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

/* 历史 */
.his-list {
  display: grid;
  gap: 4px;
}

.his-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}

.his-row:first-of-type {
  border-top: none;
}

.his-meta {
  color: var(--muted);
  font-size: 12px;
}

.his-score {
  font-weight: 700;
  color: var(--fg);
}

/* 会话（原型 iv-session） */
.iv-session {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  min-height: 0;
}

.iv-top {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.iv-top b {
  font-size: 13px;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-flow {
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.75;
  max-width: 88%;
}

.msg.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.msg-role {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  height: fit-content;
}

.msg.user .msg-role {
  background: color-mix(in srgb, var(--accent) 10%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 28%, #dbdbdb);
  color: color-mix(in srgb, var(--accent) 78%, #000000);
}

.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
}

.msg.user .msg-text {
  background: color-mix(in srgb, var(--accent) 8%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 24%, #dbdbdb);
}

.caret {
  animation: blink 1s step-end infinite;
  color: var(--accent);
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* PTT（原型 .ptt） */
.iv-inputbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.iv-inputbar input {
  flex: 1;
}

.ptt {
  position: relative;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--fg);
  color: #ffffff;
  border: none;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: none;
  transition: background 0.15s, transform 0.1s;
  font-family: var(--font);
}

.ptt .ic {
  width: 18px;
  height: 18px;
}

.ptt-label {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  line-height: 1;
}

.ptt:hover {
  transform: scale(1.03);
}

.ptt:active {
  transform: scale(0.97);
}

.ptt.rec {
  background: var(--accent);
}

.ptt.rec::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  animation: ripple 1.2s ease-out infinite;
  pointer-events: none;
}

@keyframes ripple {
  0% {
    transform: scale(0.85);
    opacity: 0.7;
  }
  100% {
    transform: scale(1.25);
    opacity: 0;
  }
}

/* 复盘面板（原型 review-panel） */
.rv-top {
  display: flex;
  gap: 22px;
  align-items: center;
}

.sect {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 11px 0;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  line-height: 1.6;
}

.sect:first-of-type {
  border-top: none;
}

.sect .ic {
  width: 14px;
  height: 14px;
  margin-top: 3px;
  flex: none;
}

.sect .good {
  color: var(--accent);
}

.sect .weak {
  color: var(--muted);
}

.weak-body {
  flex: 1;
  min-width: 0;
}

.weak-title {
  font-weight: 600;
}

.weak-detail {
  color: var(--muted);
  font-size: 11.5px;
  margin-top: 2px;
}

.weak-add {
  flex: none;
  align-self: center;
  height: 26px;
  padding: 0 10px;
  font-size: 11.5px;
}

.transcript {
  margin-top: 4px;
  font-size: 12.5px;
}

.transcript summary {
  cursor: pointer;
  color: var(--accent);
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
  color: var(--muted);
}

.t-text {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  max-width: 80%;
}

.t-msg.user .t-text {
  background: color-mix(in srgb, var(--accent) 8%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 24%, #dbdbdb);
}
</style>
