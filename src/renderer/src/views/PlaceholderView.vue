<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="placeholder">
    <h1 class="page-title">{{ title }}</h1>
    <p class="hint">模块视图待实现（见 MVP spec 对应 ticket）。</p>
  </section>
</template>

<style scoped>
.placeholder {
  max-width: 560px;
}

.page-title {
  margin: 0 0 16px;
  font-size: 20px;
}

.hint {
  color: #6b7280;
}
</style>
