<script setup lang="ts">
import { ref } from 'vue'
import { RouterView } from 'vue-router'
import Sidebar from './components/Sidebar.vue'
import Topbar from './components/Topbar.vue'
import Resizer from './components/Resizer.vue'
import { isSidebarOff, setSidebar } from './layout'

/** 外壳（#42 T1）：侧边栏 + 拖拽 + 顶栏 + 内容区。 */
const collapsed = ref(isSidebarOff())

function toggleSidebar(): void {
  collapsed.value = !collapsed.value
  setSidebar(collapsed.value)
}
</script>

<template>
  <div class="app-shell">
    <Sidebar />
    <Resizer mode="sb" />
    <div class="main">
      <Topbar :collapsed="collapsed" @toggle-sidebar="toggleSidebar" />
      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>
