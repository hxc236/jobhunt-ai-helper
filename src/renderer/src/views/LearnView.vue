<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { IpcEvent } from '@shared/protocol'
import {
  TOPIC_STATUSES,
  type PositionListItem,
  type Topic,
  type TopicSource,
  type TopicStatus
} from '@shared/types'

/**
 * 学习清单（F-21/#35）：分组展示（按三态，组内优先级升序）+ 增删改 + 三态切换 +
 * 无缺口降级提示（未提供缺口/项目技术栈时，服务端降级为仅 JD 分析来源）。
 */

const topics = ref<Topic[]>([])
const positions = ref<PositionListItem[]>([])
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const selectedJobId = ref('')
const generating = ref(false)

const STATUS_LABELS: Record<TopicStatus, string> = { todo: '待学习', learning: '学习中', learned: '已掌握' }
const SOURCE_LABELS: Record<TopicSource, string> = {
  hard: '硬性要求',
  mentioned: 'JD 提及',
  gap: '简历缺口',
  project: '项目相关',
  manual: '手动添加',
  interview: '复盘回填'
}
const PRIORITY_LABELS: Record<number, string> = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4', 5: 'P5' }

/** teach 聊天（F-22/#36）：流式打字机 + 续接提示。 */
interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

const chatOpen = ref(false)
const chatTopic = ref('')
const chatSessionId = ref('')
const chatResumed = ref(false)
const chatMessages = ref<ChatMessage[]>([])
const chatInput = ref('')
const chatSending = ref(false)
const chatError = ref('')
/** 流式缓冲：当前 assistant 回复增量（agent:delta 逐块追加）。 */
const streamingText = ref('')

async function openChat(topic: Topic): Promise<void> {
  chatError.value = ''
  chatTopic.value = topic.title
  chatMessages.value = []
  streamingText.value = ''
  chatOpen.value = true
  try {
    const started = await window.api.learn.start(topic.id)
    chatSessionId.value = started.sessionId
    chatResumed.value = started.resumed // 续接提示（continueRecent 跨次续接）
  } catch (err) {
    chatError.value = String(err)
  }
}

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim()
  if (text === '' || chatSending.value) return
  chatInput.value = ''
  chatMessages.value.push({ role: 'user', text })
  chatSending.value = true
  streamingText.value = ''
  try {
    const reply = await window.api.learn.send(chatSessionId.value, text)
    chatMessages.value.push({ role: 'assistant', text: reply })
  } catch (err) {
    chatError.value = String(err)
  } finally {
    streamingText.value = ''
    chatSending.value = false
  }
}

onMounted(() => {
  void load()
  // agent:delta 流式增量：仅消费当前 learn 会话的增量（打字机）
  const unsubscribe = window.api.on(IpcEvent.AgentDelta, (payload) => {
    if (payload.sessionId !== chatSessionId.value || !chatOpen.value) return
    streamingText.value += payload.delta
  })
  onUnmounted(unsubscribe)
})

const groups = computed(() =>
  TOPIC_STATUSES.map((status) => ({
    status,
    items: topics.value.filter((t) => t.status === status)
  }))
)

/** 降级提示：生成结果全部来自 JD 分析（无缺口/项目来源）且职位存在分析缓存。 */
const degradeHint = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    const [t, p] = await Promise.all([
      window.api.topics.list(),
      window.api.positions.list().catch(() => [] as PositionListItem[])
    ])
    topics.value = t
    positions.value = p
  } catch (err) {
    errorMessage.value = `加载学习清单失败：${String(err)}`
  } finally {
    loading.value = false
  }
}

async function generate(): Promise<void> {
  if (selectedJobId.value === '') {
    errorMessage.value = '请先选择职位'
    return
  }
  generating.value = true
  errorMessage.value = ''
  successMessage.value = ''
  degradeHint.value = ''
  try {
    const result = await window.api.topics.generate(selectedJobId.value)
    successMessage.value = `已生成 ${result.created.length} 条（跳过重复 ${result.skipped} 条）`
    // 降级提示：无缺口/项目来源（#35 验收：无缺口时降级提示显示）
    if (
      result.created.length > 0 &&
      result.created.every((t) => t.source === 'hard' || t.source === 'mentioned')
    ) {
      degradeHint.value =
        '未提供缺口与项目技术栈，已降级按 JD 分析生成——建议先在职位详情执行「按 JD 优化简历」，再回到此处生成'
    }
    await load()
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    generating.value = false
  }
}

async function setStatus(topic: Topic, status: TopicStatus): Promise<void> {
  try {
    await window.api.topics.setStatus(topic.id, status)
    await load()
  } catch (err) {
    errorMessage.value = String(err)
  }
}

const editing = ref<Topic | null>(null)
const editForm = reactive({ title: '', note: '', priority: 5 })
const deleteTarget = ref<Topic | null>(null)
const saving = ref(false)

function startEdit(topic: Topic): void {
  editing.value = topic
  editForm.title = topic.title
  editForm.note = topic.note
  editForm.priority = topic.priority
}

async function saveEdit(): Promise<void> {
  const target = editing.value
  if (target === null) return
  saving.value = true
  try {
    await window.api.topics.update(target.id, {
      title: editForm.title,
      note: editForm.note,
      priority: editForm.priority
    })
    editing.value = null
    await load()
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    saving.value = false
  }
}

const creating = ref(false)
const createForm = reactive({ title: '', note: '' })

async function createTopic(): Promise<void> {
  if (createForm.title.trim() === '') {
    errorMessage.value = '请输入条目名称'
    return
  }
  creating.value = true
  try {
    await window.api.topics.create({
      title: createForm.title,
      note: createForm.note,
      jobId: selectedJobId.value === '' ? null : selectedJobId.value
    })
    createForm.title = ''
    createForm.note = ''
    await load()
  } catch (err) {
    errorMessage.value = String(err)
  } finally {
    creating.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (target === null) return
  try {
    await window.api.topics.delete(target.id)
    deleteTarget.value = null
    await load()
  } catch (err) {
    errorMessage.value = String(err)
  }
}


</script>

<template>
  <section class="learn-view">
    <h1 class="page-title">学习</h1>

    <section class="card">
      <h2 class="card-title">生成学习清单</h2>
      <div class="gen-bar">
        <select v-model="selectedJobId" class="input">
          <option value="" disabled>选择职位…</option>
          <option v-for="p in positions" :key="p.id" :value="p.id">
            {{ p.company }} · {{ p.title }}
          </option>
        </select>
        <button class="btn btn-primary" type="button" :disabled="generating || selectedJobId === ''" @click="generate">
          {{ generating ? '生成中…' : '按 JD 生成清单' }}
        </button>
      </div>
      <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>
      <p v-if="successMessage" class="message success">{{ successMessage }}</p>
      <p v-if="degradeHint" class="hint degrade-hint">{{ degradeHint }}</p>
      <p v-if="positions.length === 0" class="hint">
        暂无职位——请先在「职位」模块录入或采集职位卡，并在职位详情中执行「按 JD 优化简历」以生成 JD 分析。
      </p>
    </section>

    <section class="card">
      <h2 class="card-title">手动添加条目</h2>
      <div class="gen-bar">
        <input v-model="createForm.title" class="input" placeholder="要学习的内容，如：Redis 持久化原理" @keyup.enter="createTopic" />
        <input v-model="createForm.note" class="input" placeholder="备注（选填）" />
        <button class="btn" type="button" :disabled="creating" @click="createTopic">添加</button>
      </div>
    </section>

    <div v-for="g in groups" :key="g.status" class="card">
      <h2 class="card-title">
        {{ STATUS_LABELS[g.status] }}
        <span class="count">{{ g.items.length }}</span>
      </h2>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="g.items.length === 0" class="hint">暂无条目。</p>
      <ul v-else class="topic-list">
        <li v-for="t in g.items" :key="t.id" class="topic-row">
          <span class="pill" :class="`prio-${t.priority}`">{{ PRIORITY_LABELS[t.priority] }}</span>
          <span class="topic-title">{{ t.title }}</span>
          <span class="pill pill-source">{{ SOURCE_LABELS[t.source] }}</span>
          <span v-if="t.note !== ''" class="meta">{{ t.note }}</span>
          <span class="row-actions">
            <template v-if="t.status === 'todo'">
              <button class="btn" type="button" @click="setStatus(t, 'learning')">标记学习中</button>
            </template>
            <template v-else-if="t.status === 'learning'">
              <button class="btn btn-primary" type="button" @click="setStatus(t, 'learned')">标记已掌握</button>
              <button class="btn" type="button" @click="setStatus(t, 'todo')">回到待学习</button>
            </template>
            <template v-else>
              <button class="btn" type="button" @click="setStatus(t, 'todo')">重置</button>
            </template>
            <button class="btn btn-primary" type="button" @click="openChat(t)">聊天学习</button>
            <button class="btn" type="button" @click="startEdit(t)">编辑</button>
            <button class="btn btn-danger-ghost" type="button" @click="deleteTarget = t">删除</button>
          </span>
        </li>
      </ul>
    </div>

    <!-- 编辑弹层 -->
    <div v-if="editing" class="edit-overlay" @click.self="editing = null">
      <div class="edit-panel">
        <h3 class="edit-title">编辑条目</h3>
        <label class="field">
          <span class="label">名称</span>
          <input v-model="editForm.title" class="input" />
        </label>
        <label class="field">
          <span class="label">备注</span>
          <input v-model="editForm.note" class="input" />
        </label>
        <label class="field">
          <span class="label">优先级（1-5，1 最高）</span>
          <select v-model="editForm.priority" class="input">
            <option v-for="i in 5" :key="i" :value="i">{{ i }} - {{ PRIORITY_LABELS[i] }}</option>
          </select>
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="button" :disabled="saving" @click="saveEdit">保存</button>
          <button class="btn" type="button" :disabled="saving" @click="editing = null">取消</button>
        </div>
      </div>
    </div>

        <!-- teach 聊天（F-22/#36） -->
    <div v-if="chatOpen" class="edit-overlay" @click.self="chatOpen = false">
      <div class="chat-panel">
        <div class="chat-head">
          <span class="chat-title">学习：{{ chatTopic }}</span>
          <button class="btn" type="button" @click="chatOpen = false">关闭</button>
        </div>
        <p v-if="chatResumed" class="chat-resume-hint">已续接上次对话（跨次续接）</p>
        <p v-if="chatError" class="message error">{{ chatError }}</p>
        <div class="chat-body">
          <div v-for="(m, i) in chatMessages" :key="i" class="chat-msg" :class="m.role">
            <span class="chat-role">{{ m.role === 'user' ? '我' : '助教' }}</span>
            <span class="chat-text">{{ m.text }}</span>
          </div>
          <div v-if="streamingText !== ''" class="chat-msg assistant">
            <span class="chat-role">助教</span>
            <span class="chat-text">{{ streamingText }}</span>
            <span class="chat-cursor">▌</span>
          </div>
        </div>
        <div class="chat-input-bar">
          <input
            v-model="chatInput"
            class="input"
            placeholder="输入问题，回车发送…"
            :disabled="chatSending || chatSessionId === ''"
            @keyup.enter="sendChat"
          />
          <button class="btn btn-primary" type="button" :disabled="chatSending || chatSessionId === ''" @click="sendChat">
            {{ chatSending ? '思考中…' : '发送' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="deleteTarget" class="confirm-box">
      <p class="confirm-text">确认删除「{{ deleteTarget.title }}」？</p>
      <div class="confirm-actions">
        <button class="btn btn-danger" type="button" @click="confirmDelete">确认删除</button>
        <button class="btn" type="button" @click="deleteTarget = null">取消</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.learn-view {
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

.gen-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.gen-bar .input {
  flex: 1;
  min-width: 200px;
}

.topic-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.topic-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid #f0f1f3;
  font-size: 13px;
}

.topic-row:last-child {
  border-bottom: none;
}

.topic-title {
  font-weight: 600;
}

.pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.prio-1 {
  background: #fee2e2;
  color: #dc2626;
}

.prio-2 {
  background: #fef3c7;
  color: #b45309;
}

.prio-3 {
  background: #eff6ff;
  color: #1d4ed8;
}

.prio-4,
.prio-5 {
  background: #f3f4f6;
  color: #6b7280;
}

.pill-source {
  background: #f5f3ff;
  color: #6d28d9;
}

.row-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.degrade-hint {
  margin-top: 10px;
  padding: 8px 12px;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 6px;
  color: #92400e;
}

.chat-panel {
  background: #fff;
  border-radius: 8px;
  width: min(640px, 100%);
  height: min(520px, 90%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e7eb;
}

.chat-title {
  font-weight: 600;
  font-size: 14px;
}

.chat-resume-hint {
  margin: 0;
  padding: 6px 14px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  background: #fafbfc;
  border-radius: 6px;
  padding: 6px 10px;
  max-width: 80%;
}

.chat-msg.user .chat-text {
  background: #eff6ff;
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

.chat-input-bar {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid #e5e7eb;
}

.chat-input-bar .input {
  flex: 1;
}

.edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.edit-panel {
  background: #fff;
  border-radius: 8px;
  padding: 18px 20px;
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.edit-title {
  margin: 0;
  font-size: 15px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  font-size: 13px;
  color: #374151;
}

.input {
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}

.form-actions,
.confirm-actions {
  display: flex;
  gap: 10px;
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

.btn-danger-ghost {
  border-color: transparent;
  color: #dc2626;
  background: transparent;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.message {
  margin: 10px 0;
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
  margin: 0;
  color: #6b7280;
  line-height: 1.7;
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
}
</style>
