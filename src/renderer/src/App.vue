<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'

/** 侧边栏导航（docs/architecture.md：四个业务模块 + 设置；DESIGN.md 变体待选定）。 */
const navItems = [
  { path: '/jobs', label: '职位' },
  { path: '/resumes', label: '简历' },
  { path: '/learn', label: '学习' },
  { path: '/interview', label: '面试' },
  { path: '/settings', label: '设置' }
]
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="logo">求职助手</div>
      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          active-class="nav-item-active"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>

    <main class="content">
      <RouterView />
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
  text-decoration: none;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.nav-item-active {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-weight: 600;
}

.content {
  flex: 1;
  padding: 24px 32px;
  overflow-y: auto;
}
</style>
