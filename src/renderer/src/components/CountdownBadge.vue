<script setup lang="ts">
import { computed } from 'vue'

/** 网申倒计时徽标（#42 T2）：null=待核实（灰）；≤14 天红（保留既有提醒功能）；其余黑底白点。 */
const props = defineProps<{ daysLeft: number | null }>()

const text = computed(() => {
  if (props.daysLeft === null) return '待核实'
  if (props.daysLeft <= 0) return '已截止'
  return `剩 ${props.daysLeft} 天`
})

const urgent = computed(() => props.daysLeft !== null && props.daysLeft <= 14)
</script>

<template>
  <span class="pill solid" :class="{ urgent }">
    <span v-if="daysLeft !== null" class="dot"></span>
    {{ text }}
  </span>
</template>

<style scoped>
.pill.solid.urgent {
  background: #dc2626;
  border-color: #dc2626;
}
</style>
