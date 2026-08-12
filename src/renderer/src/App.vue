<script setup lang="ts">
import { onMounted, ref } from 'vue'

const navItems = ['职位', '简历', '学习', '面试', '设置']

const pingResult = ref<string>('—')
const pinging = ref(false)

async function doPing(): Promise<void> {
  pinging.value = true
  try {
    pingResult.value = await window.api.ping()
    console.info('[renderer] ping ->', pingResult.value)
  } catch (err) {
    pingResult.value = `失败: ${String(err)}`
  } finally {
    pinging.value = false
  }
}

onMounted(doPing)
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="logo">求职助手</div>
      <nav class="nav">
        <div v-for="item in navItems" :key="item" class="nav-item">{{ item }}</div>
      </nav>
    </aside>

    <main class="content">
      <h1 class="page-title">工程脚手架已就绪</h1>

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

      <p class="hint">
        工程结构：src/main（主进程）· src/renderer（Vue 3）· src/shared（共用协议）。
      </p>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
}

.sidebar {
  width: 180px;
  flex-shrink: 0;
  padding: 16px 12px;
  background: #1f2937;
  color: #e5e7eb;
}

.logo {
  padding: 4px 8px 16px;
  font-size: 16px;
  font-weight: 600;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  color: #d1d5db;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.content {
  flex: 1;
  padding: 24px 32px;
  overflow-y: auto;
}

.page-title {
  margin: 0 0 16px;
  font-size: 20px;
}

.card {
  max-width: 560px;
  padding: 16px 20px;
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
  margin-top: 16px;
  color: #6b7280;
}
</style>
