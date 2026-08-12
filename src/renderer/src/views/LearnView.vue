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
import Modal from '../components/Modal.vue'
import Resizer from '../components/Resizer.vue'
import Icon from '../components/Icon.vue'
import Pill from '../components/Pill.vue'

/**
 * 学习模块（#42 T4）：双栏 = 清单（三态分组，组内优先级升序）+ teach 聊天列。
 * 功能 = 原 LearnView（F-21/#35 清单 + F-22/#36 teach 聊天 + suggestLearn 回填展示）。
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
    chatResumed.value = started.resumed
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
  const unsubscribe = window.api.on(IpcEvent.AgentDelta, (payload) => {
    if (payload.sessionId !== chatSessionId.value || !chatOpen.value) return
    streamingText.value += payload.delta
  })
  onUnmounted(unsubscribe)
})

/** 三态分组（保持既有分组语义；组内优先级升序）。 */
const groups = computed(() =>
  TOPIC_STATUSES.map((status) => ({
    status,
    items: topics.value
      .filter((t) => t.status === status)
      .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at))
  }))
)

const todoCount = computed(() => topics.value.filter((t) => t.status === 'todo').length)

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

const createOpen = ref(false)
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
    createOpen.value = false
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

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}
</script>

<template>
  <section class="view cols">
    <!-- ===== 清单列 ===== -->
    <div class="col">
      <div class="col-head">
        <div>
          <div class="col-title">学习清单</div>
          <div class="col-count">{{ topics.length }} 项 · 待学 {{ todoCount }}</div>
        </div>
        <button class="btn" type="button" @click="createOpen = true">
          <Icon name="plus" />添加
        </button>
      </div>

      <!-- 生成清单 -->
      <div class="gen-box">
        <div class="gen-bar">
          <select v-model="selectedJobId">
            <option value="" disabled>选择职位…</option>
            <option v-for="p in positions" :key="p.id" :value="p.id">
              {{ p.company }} · {{ p.title }}
            </option>
          </select>
          <button class="btn primary" type="button" :disabled="generating || selectedJobId === ''" @click="generate">
            {{ generating ? '生成中…' : '按 JD 生成' }}
          </button>
        </div>
        <p v-if="successMessage" class="gen-msg ok">{{ successMessage }}</p>
        <p v-if="errorMessage" class="gen-msg err">{{ errorMessage }}</p>
        <p v-if="degradeHint" class="gen-msg warn">{{ degradeHint }}</p>
        <p v-if="positions.length === 0" class="gen-msg">
          暂无职位——先在「职位」模块录入/采集，并在职位详情执行「按 JD 优化简历」生成 JD 分析。
        </p>
      </div>

      <p v-if="loading" class="empty">加载中…</p>

      <div v-for="g in groups" :key="g.status" class="tgroup">
        <div class="tg-head">
          <span>{{ STATUS_LABELS[g.status] }}</span>
          <span class="tg-count">{{ g.items.length }} 项</span>
        </div>
        <div v-if="g.items.length === 0" class="empty" style="margin-top: 4px">暂无条目</div>
        <div
          v-for="t in g.items"
          :key="t.id"
          class="topic-row"
          :class="{ sel: chatOpen && chatTopic === t.title }"
        >
          <div class="tr-main">
            <span class="tr-name">{{ t.title }}</span>
            <Pill tone="tint">{{ SOURCE_LABELS[t.source] }}</Pill>
            <span class="prio-pill" :class="`prio-${t.priority}`">{{ PRIORITY_LABELS[t.priority] }}</span>
          </div>
          <div class="tr-sub">
            <span class="tr-src">{{ t.source === 'manual' ? '手动添加' : '自动生成' }} · {{ fmtDate(t.created_at) }}</span>
            <div class="seg">
              <button
                v-for="s in TOPIC_STATUSES"
                :key="s"
                class="seg-btn"
                :class="{ on: t.status === s }"
                type="button"
                @click="setStatus(t, s)"
              >
                {{ STATUS_LABELS[s] }}
              </button>
            </div>
            <div class="tr-actions">
              <button class="icon-btn" type="button" title="聊天学习" @click="openChat(t)"><Icon name="send" /></button>
              <button class="icon-btn" type="button" title="编辑" @click="startEdit(t)"><Icon name="edit" /></button>
              <button class="icon-btn" type="button" title="删除" @click="deleteTarget = t"><Icon name="trash" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Resizer mode="col" />

    <!-- ===== 教学会话列 ===== -->
    <div class="chat-col">
      <template v-if="chatOpen">
        <div class="chat-head">
          <h2>教学会话</h2>
          <span class="pill ghost chat-topic">{{ chatTopic }}</span>
          <span style="flex: 1"></span>
          <button class="btn ghost" type="button" @click="chatOpen = false">关闭</button>
        </div>
        <div v-if="chatResumed" class="resume-bar">
          <Icon name="clock" />
          已续接上次对话（跨次续接）
        </div>
        <p v-if="chatError" class="gen-msg err" style="padding: 8px 14px">{{ chatError }}</p>
        <div class="chat-flow">
          <div v-for="(m, i) in chatMessages" :key="i" class="msg" :class="m.role">
            <span class="msg-role">{{ m.role === 'user' ? '我' : '助教' }}</span>
            <span class="msg-text">{{ m.text }}</span>
          </div>
          <div v-if="streamingText !== ''" class="msg ai">
            <span class="msg-role">助教</span>
            <span class="msg-text">{{ streamingText }}</span>
            <span class="caret"></span>
          </div>
        </div>
        <div class="chat-input">
          <input
            v-model="chatInput"
            placeholder="输入你的问题，或直接说你的理解…"
            aria-label="输入你的问题或理解"
            :disabled="chatSending || chatSessionId === ''"
            @keyup.enter="sendChat"
          />
          <button class="btn primary" type="button" aria-label="发送" :disabled="chatSending || chatSessionId === ''" @click="sendChat">
            <Icon name="send" />
          </button>
        </div>
      </template>
      <div v-else class="chat-empty">
        <p class="hint">从左侧选择一条学习条目开始教学会话（流式输出，跨次续接）。</p>
      </div>
    </div>
  </section>

  <!-- ===== 弹窗：添加学习条目 ===== -->
  <Modal :open="createOpen" title="添加学习条目" @close="createOpen = false">
    <div class="form-grid">
      <label class="field span2">
        <span class="label">学习内容 <em class="required">*</em></span>
        <input v-model="createForm.title" placeholder="例如：RocketMQ 事务消息原理" @keyup.enter="createTopic" />
      </label>
      <label class="field span2">
        <span class="label">备注</span>
        <input v-model="createForm.note" placeholder="选填" />
      </label>
      <label class="field span2">
        <span class="label">关联职位</span>
        <select v-model="selectedJobId">
          <option value="">不关联</option>
          <option v-for="p in positions" :key="p.id" :value="p.id">
            {{ p.company }} · {{ p.title }}
          </option>
        </select>
      </label>
    </div>
    <template #foot>
      <button class="btn" type="button" @click="createOpen = false">取消</button>
      <button class="btn primary" type="button" :disabled="creating" @click="createTopic">
        {{ creating ? '添加中…' : '添加' }}
      </button>
    </template>
  </Modal>

  <!-- ===== 弹窗：编辑条目 ===== -->
  <Modal :open="editing !== null" title="编辑学习条目" @close="editing = null">
    <div class="form-grid">
      <label class="field span2">
        <span class="label">名称</span>
        <input v-model="editForm.title" />
      </label>
      <label class="field span2">
        <span class="label">备注</span>
        <input v-model="editForm.note" />
      </label>
      <label class="field span2">
        <span class="label">优先级（1-5，1 最高）</span>
        <select v-model="editForm.priority">
          <option v-for="i in 5" :key="i" :value="i">{{ i }} - {{ PRIORITY_LABELS[i] }}</option>
        </select>
      </label>
    </div>
    <template #foot>
      <button class="btn" type="button" :disabled="saving" @click="editing = null">取消</button>
      <button class="btn primary" type="button" :disabled="saving" @click="saveEdit">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </Modal>

  <!-- ===== 弹窗：删除确认 ===== -->
  <Modal :open="deleteTarget !== null" title="删除学习条目" @close="deleteTarget = null">
    <p class="hint">确认删除「{{ deleteTarget?.title }}」？</p>
    <template #foot>
      <button class="btn" type="button" @click="deleteTarget = null">取消</button>
      <button class="btn primary" type="button" @click="confirmDelete">确认删除</button>
    </template>
  </Modal>
</template>

<style scoped>
.required {
  color: #dc2626;
  font-style: normal;
}

.hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

/* 生成区 */
.gen-box {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 10px;
}

.gen-bar {
  display: flex;
  gap: 8px;
}

.gen-bar select {
  flex: 1;
  min-width: 0;
}

.gen-msg {
  font-size: 11.5px;
  margin-top: 8px;
  line-height: 1.6;
}

.gen-msg.ok {
  color: #059669;
}

.gen-msg.err {
  color: #dc2626;
}

.gen-msg.warn {
  color: #92400e;
  background: color-mix(in srgb, #d97706 10%, #ffffff);
  border: 1px solid color-mix(in srgb, #d97706 30%, #dbdbdb);
  border-radius: var(--radius);
  padding: 6px 8px;
}

/* 分组（原型 tgroup） */
.tgroup {
  margin-top: 12px;
}

.tg-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-bottom: 6px;
}

.tg-count {
  font-weight: 400;
  letter-spacing: 0;
}

/* 条目行（原型 topic-row） */
.topic-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 12px;
  margin-bottom: 6px;
  background: var(--bg);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}

.topic-row:hover {
  border-color: var(--muted);
}

.topic-row.sel {
  background: color-mix(in srgb, var(--accent) 6%, #ffffff);
  border-color: color-mix(in srgb, var(--accent) 45%, #dbdbdb);
}

.topic-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.tr-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tr-name {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  min-width: 0;
}

.prio-pill {
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 18px;
  letter-spacing: 0.02em;
  margin-left: auto;
}

.prio-1 {
  background: color-mix(in srgb, #dc2626 12%, #ffffff);
  color: #dc2626;
  border: 1px solid color-mix(in srgb, #dc2626 32%, #dbdbdb);
}

.prio-2 {
  background: color-mix(in srgb, #d97706 12%, #ffffff);
  color: #b45309;
  border: 1px solid color-mix(in srgb, #d97706 32%, #dbdbdb);
}

.prio-3 {
  background: color-mix(in srgb, var(--accent) 10%, #ffffff);
  color: color-mix(in srgb, var(--accent) 78%, #000000);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, #dbdbdb);
}

.prio-4,
.prio-5 {
  background: var(--surface);
  color: var(--muted);
  border: 1px solid var(--border);
}

.tr-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.tr-src {
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.02em;
}

/* 三态切换（原型 seg） */
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}

.seg-btn {
  height: 20px;
  padding: 0 8px;
  border: none;
  background: var(--bg);
  font-family: var(--font);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--muted);
  cursor: pointer;
  line-height: 1;
}

.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}

.seg-btn:hover {
  color: var(--fg);
}

.seg-btn.on {
  background: var(--fg);
  color: #ffffff;
}

.seg-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.tr-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.tr-actions .icon-btn {
  width: 22px;
  height: 22px;
}

.tr-actions .icon-btn .ic {
  width: 12px;
  height: 12px;
}

/* 教学会话列（原型 chat-col） */
.chat-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
  border-left: none;
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.chat-head h2 {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.chat-topic {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.resume-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  background: color-mix(in srgb, var(--accent) 7%, #ffffff);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: color-mix(in srgb, var(--accent) 80%, #000000);
}

.resume-bar .ic {
  width: 13px;
  height: 13px;
}

.chat-flow {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.7;
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

.chat-input {
  display: flex;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.chat-input input {
  flex: 1;
}

.chat-empty {
  padding: 40px 24px;
}
</style>
