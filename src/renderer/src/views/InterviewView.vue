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
      <p class="hint">文字输入即可完成整场面试（语音输入接入后可作为补充，当前为文字兜底）。</p>
    </section>

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
