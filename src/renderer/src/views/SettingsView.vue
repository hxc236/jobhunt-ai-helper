<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { IpcEvent } from '@shared/protocol'

const pingResult = ref<string>('—')
const pinging = ref(false)

async function doPing(): Promise<void> {
  pinging.value = true
  try {
    pingResult.value = await window.api.ping()
  } catch (err) {
    pingResult.value = `失败: ${String(err)}`
  } finally {
    pinging.value = false
  }
}

// ---- settings 通道 + 主→渲染事件推送（EF-03 演示） ----
const settingsKey = ref('ui.theme')
const settingsValue = ref('"light"')
const settingsResult = ref<string>('—')
const settingsBusy = ref(false)
const eventCount = ref(0)
const lastEvent = ref<string>('—')

async function runSettings(action: 'get' | 'set' | 'get-all'): Promise<void> {
  settingsBusy.value = true
  try {
    if (action === 'get') {
      settingsResult.value = JSON.stringify(await window.api.settings.get(settingsKey.value))
    } else if (action === 'set') {
      await window.api.settings.set(settingsKey.value, JSON.parse(settingsValue.value))
      settingsResult.value = '已写入 settings 表'
    } else {
      settingsResult.value = JSON.stringify(await window.api.settings.getAll())
    }
  } catch (err) {
    settingsResult.value = `失败: ${String(err)}`
  } finally {
    settingsBusy.value = false
  }
}

let unsubscribe: (() => void) | undefined
onMounted(() => {
  // 订阅主进程事件推送（settings 变更广播）；返回的取消函数用于清理
  unsubscribe = window.api.on(IpcEvent.SettingsChanged, (payload) => {
    eventCount.value += 1
    lastEvent.value = `${payload.key} → ${JSON.stringify(payload.value)}`
  })
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <section class="settings-view">
    <h1 class="page-title">设置</h1>
    <p class="hint">模型认证配置（provider / API key / 测试连接）随 EF-04 设置页 ticket 补充。</p>

    <section class="card">
      <h2 class="card-title">IPC ping 测试（EF-01）</h2>
      <p class="card-text">
        渲染进程 → 主进程 <code>ping</code>，主进程返回：
        <code class="result" data-testid="ping-result">{{ pingResult }}</code>
      </p>
      <button class="btn" :disabled="pinging" @click="doPing">
        {{ pinging ? 'ping 中…' : '再 ping 一次' }}
      </button>
    </section>

    <section class="card">
      <h2 class="card-title">settings 通道 + 事件推送（EF-03）</h2>
      <p class="card-text">
        经 <code>window.api.settings</code> 类型化调用主进程 settings 表 get/set；
        每次 set 后主进程广播 <code>settings:changed</code> 事件，此处实时接收。
      </p>
      <div class="form-row">
        <input v-model="settingsKey" class="input" placeholder="key" />
        <input v-model="settingsValue" class="input" placeholder="value（JSON）" />
        <button class="btn" :disabled="settingsBusy" @click="runSettings('get')">get</button>
        <button class="btn" :disabled="settingsBusy" @click="runSettings('set')">set</button>
        <button class="btn" :disabled="settingsBusy" @click="runSettings('get-all')">get all</button>
      </div>
      <p class="card-text">
        结果：<code class="result">{{ settingsResult }}</code>
      </p>
      <p class="card-text">
        事件推送：已收到 <code class="result">{{ eventCount }}</code> 次
        <code>settings:changed</code>；最近一次：<code class="result">{{ lastEvent }}</code>
      </p>
    </section>
  </section>
</template>

<style scoped>
.settings-view {
  max-width: 560px;
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
  margin: 0 0 8px;
  font-size: 15px;
}

.card-text {
  margin: 0 0 12px;
  line-height: 1.7;
}

code {
  padding: 2px 6px;
  background: #f3f4f6;
  border-radius: 4px;
  font-size: 13px;
}

.result {
  font-weight: 600;
  color: #059669;
}

.form-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
}

.btn {
  padding: 6px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  background: #f9fafb;
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.hint {
  margin: 0 0 16px;
  color: #6b7280;
  line-height: 1.7;
}
</style>
