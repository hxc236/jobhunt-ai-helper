<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { PositionListItem } from '@shared/types'
import Icon from './Icon.vue'

/** 顶栏（#42 T1）：侧边栏收起按钮 + 秋招季/三统计 + 模型状态芯片。
 *  统计语义（#42 Q9）：职位 N=active 计数；待投递 N=最新投递记录 planned 的职位数（按职位去重）；
 *  最近截止=未来最近 end_date 剩余天数（无未来截止隐藏该项）；季名=最新 recruit_season；
 *  全库无职位时统计区隐藏只留芯片。 */
defineEmits<{ (e: 'toggle-sidebar'): void }>()

const props = defineProps<{ collapsed: boolean }>()

const router = useRouter()
const route = useRoute()

const positions = ref<PositionListItem[]>([])
const modelText = ref('模型未配置')
const modelConfigured = ref(false)

const season = computed(() => {
  const seasons = positions.value.map((p) => p.recruit_season).filter((s): s is string => !!s)
  return seasons.length ? seasons.sort().at(-1) : ''
})

const hasData = computed(() => positions.value.length > 0)

const activeCount = computed(() => positions.value.filter((p) => p.status === 'active').length)

const plannedCount = computed(
  () => positions.value.filter((p) => p.application_status === 'planned').length
)

const nearestDays = computed(() => {
  const days = positions.value
    .map((p) => p.days_left)
    .filter((d): d is number => d !== null && d >= 0)
  return days.length ? Math.min(...days) : null
})

async function loadStats(): Promise<void> {
  try {
    positions.value = await window.api.positions.list({})
  } catch {
    positions.value = []
  }
}

async function loadModel(): Promise<void> {
  try {
    const s = await window.api.settings.getStatus()
    modelConfigured.value = s.configured
    modelText.value = s.configured
      ? `模型已配置 · ${s.model || s.provider || ''}`
      : '模型未配置'
  } catch {
    modelConfigured.value = false
    modelText.value = '模型未配置'
  }
}

onMounted(() => {
  void loadStats()
  void loadModel()
  window.addEventListener('jobhunt:positions-changed', loadStats)
})

onUnmounted(() => {
  window.removeEventListener('jobhunt:positions-changed', loadStats)
})

// 路由变化时刷新统计（职位数据在 /jobs 内变更）
watch(
  () => route.path,
  () => void loadStats()
)
</script>

<template>
  <header class="topbar">
    <div class="top-left">
      <button
        class="icon-btn"
        :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
        :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="$emit('toggle-sidebar')"
      >
        <Icon :name="collapsed ? 'chevronRight' : 'chevronLeft'" />
      </button>
      <span v-if="season" class="season">{{ season }}</span>
      <template v-if="hasData">
        <span class="stat">职位 <b>{{ activeCount }}</b></span>
        <span class="stat">待投递 <b>{{ plannedCount }}</b></span>
        <span v-if="nearestDays !== null" class="stat">
          最近截止 <b>剩 {{ nearestDays }} 天</b>
        </span>
      </template>
    </div>
    <button class="model-chip" @click="router.push('/settings')">
      <span class="model-dot" :class="{ off: !modelConfigured }"></span>
      {{ modelText }}
    </button>
  </header>
</template>
