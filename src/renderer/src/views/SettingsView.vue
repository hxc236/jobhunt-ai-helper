<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import Pill from '../components/Pill.vue'

/** 设置（#42 T6）：模型认证配置（提供商/模型/API key）+ 配置状态行（已配置 ✓ / 未配置降级说明）。
 *  替代原 EF-01/EF-03 演示页（ping/settings 控制台为脚手架，非产品 UI）。 */

/** 常见提供商（auth.json 由 pi SDK 解析，provider id 可自定义）。 */
const PROVIDER_OPTIONS = [
  'deepseek',
  'kimi-coding',
  'anthropic',
  'openai',
  'google',
  'zhipu',
  '其他'
]

const status = ref<{ configured: boolean; provider?: string; model?: string }>({
  configured: false
})
const statusLoading = ref(true)
const provider = ref('deepseek')
const customProvider = ref('')
const model = ref('')
const apiKey = ref('')
const saving = ref(false)
const saveMessage = ref('')

// #77：Agent 导入增强开关（设置中可关闭；缺省开启）
const AGENT_IMPORT_ENABLED_KEY = 'agent.importEnabled'
const agentImportEnabled = ref(true)

async function loadAgentImportSetting(): Promise<void> {
  try {
    const value = await window.api.settings.get(AGENT_IMPORT_ENABLED_KEY)
    agentImportEnabled.value = value !== false // 缺省开启
  } catch {
    agentImportEnabled.value = true
  }
}

async function onAgentImportToggle(): Promise<void> {
  await window.api.settings.set(AGENT_IMPORT_ENABLED_KEY, agentImportEnabled.value)
}

async function loadStatus(): Promise<void> {
  statusLoading.value = true
  try {
    status.value = await window.api.settings.getStatus()
    if (status.value.provider) {
      provider.value = PROVIDER_OPTIONS.includes(status.value.provider) ? status.value.provider : '其他'
      if (provider.value === '其他') customProvider.value = status.value.provider
    }
    model.value = status.value.model ?? ''
  } catch {
    status.value = { configured: false }
  } finally {
    statusLoading.value = false
  }
}

onMounted(() => {
  void loadStatus()
  void loadAgentImportSetting()
})

async function save(): Promise<void> {
  saveMessage.value = ''
  const resolvedProvider = provider.value === '其他' ? customProvider.value.trim() : provider.value
  if (resolvedProvider === '') {
    saveMessage.value = '请选择或填写模型提供商'
    return
  }
  if (apiKey.value.trim() === '') {
    saveMessage.value = '请填写 API key'
    return
  }
  saving.value = true
  try {
    await window.api.settings.configureProvider(resolvedProvider, apiKey.value.trim(), model.value.trim() === '' ? undefined : model.value.trim())
    apiKey.value = ''
    saveMessage.value = '已保存配置'
    await loadStatus()
  } catch (err) {
    saveMessage.value = `保存失败：${String(err)}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="view solo settings-view">
    <div class="s-wrap">
      <div class="col-head">
        <div>
          <div class="col-title">设置</div>
          <div class="col-count">模型认证与降级说明</div>
        </div>
      </div>

      <!-- 模型配置 -->
      <div class="card">
        <div class="sec-head">
          <h2>模型认证</h2>
          <Pill v-if="statusLoading" tone="ghost">读取中…</Pill>
          <Pill v-else :tone="status.configured ? 'tint' : 'ghost'">
            {{ status.configured ? '已配置 ✓' : '未配置' }}
          </Pill>
        </div>

        <div class="form-grid">
          <label class="field">
            <span class="label">模型提供商</span>
            <select v-model="provider">
              <option v-for="p in PROVIDER_OPTIONS" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="field">
            <span class="label">模型</span>
            <input v-model="model" placeholder="留空则由提供商决定默认模型" />
          </label>
          <label v-if="provider === '其他'" class="field span2">
            <span class="label">提供商 id（自定义）</span>
            <input v-model="customProvider" placeholder="如：glm" />
          </label>
          <label class="field span2">
            <span class="label">API key</span>
            <input v-model="apiKey" type="password" placeholder="粘贴 API key（保存后清空输入框，不回显）" />
          </label>
        </div>

        <p v-if="saveMessage" class="s-msg" :class="{ ok: saveMessage === '已保存配置' }">{{ saveMessage }}</p>

        <div class="s-actions">
          <button class="btn primary" type="button" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存配置' }}
          </button>
        </div>
      </div>

      <!-- #77：Agent 导入增强（简历导入时自动结构化；可关闭 → 恒本地草稿） -->
      <div class="card surface">
        <div class="sec-head"><h2>Agent 导入增强</h2></div>
        <label class="s-toggle">
          <input type="checkbox" v-model="agentImportEnabled" @change="onAgentImportToggle" />
          <span>导入简历时自动用已配置模型结构化（首次使用前会征得同意；关闭后仅用本地解析草稿）</span>
        </label>
      </div>

      <!-- 状态与降级说明 -->
      <div class="card surface">
        <div class="sec-head"><h2>当前状态</h2></div>
        <p v-if="statusLoading" class="hint">读取中…</p>
        <template v-else-if="status.configured">
          <div class="s-status">
            <Icon name="check" class="ok" />
            <span>
              已配置 <b>{{ status.provider }}</b><template v-if="status.model"> · {{ status.model }}</template>
            </span>
          </div>
        </template>
        <template v-else>
          <div class="s-status">
            <Icon name="info" class="off" />
            <span>未配置模型——以下功能将降级，其余手动功能不受影响：</span>
          </div>
          <ul class="s-list">
            <li>简历优化 / 学习清单生成 / teach 聊天 / 模拟面试：不可用（界面顶部黄条引导至本页）</li>
            <li>匹配度规则打分、职位/简历/学习清单的增删改查：正常可用</li>
          </ul>
        </template>
      </div>

      <p class="hint" style="margin-top: 12px">
        API key 存入应用自有 auth.json（不入 settings 表）；提供商 id 由 pi SDK 解析，支持自定义。
      </p>
    </div>
  </section>
</template>

<style scoped>
.settings-view {
  overflow-y: auto;
  height: 100%;
}

.s-wrap {
  max-width: 640px;
  padding: 20px 24px;
}

.s-msg {
  font-size: 12px;
  color: #dc2626;
  margin-top: 12px;
}

.s-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--fg);
  cursor: pointer;
}

.s-toggle input {
  margin-top: 3px;
  accent-color: #2b5ca8;
}
.s-msg.ok {
  color: #059669;
}

.s-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.s-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.7;
}

.s-status b {
  font-weight: 600;
}

.s-status .ok {
  color: var(--accent);
  width: 14px;
  height: 14px;
}

.s-status .off {
  color: var(--muted);
  width: 14px;
  height: 14px;
}

.s-list {
  margin: 8px 0 0 22px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
}

.hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
</style>
