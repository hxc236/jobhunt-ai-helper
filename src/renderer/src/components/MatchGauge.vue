<script setup lang="ts">
import { computed } from 'vue'

/** 匹配度仪表（#42 T2）：环形总分 + 维度条。
 *  颜色语义移植原型：≥80 accent / 60–80 浅 accent / <60 灰。 */
export interface GaugeDim {
  label: string
  score: number
}

const props = withDefaults(defineProps<{ total: number; dims: GaugeDim[]; label?: string }>(), {
  label: '匹配度'
})

const ringClass = computed(() => {
  if (props.total < 60) return 'low'
  if (props.total < 80) return 'mid'
  return ''
})
</script>

<template>
  <div class="mc-body">
    <div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" width="112" height="112">
        <circle class="ring-bg" cx="60" cy="60" r="52" />
        <circle class="ring-fg" :class="ringClass" cx="60" cy="60" r="52" pathLength="100" :stroke-dasharray="`${total} 100`" />
        <text class="ring-val" x="60" y="57" text-anchor="middle">{{ total }}</text>
        <text class="ring-lab" x="60" y="78" text-anchor="middle">{{ label }}</text>
      </svg>
    </div>
    <div class="dims">
      <div v-for="d in dims" :key="d.label" class="dim">
        <span class="dim-label">{{ d.label }}</span>
        <div class="bar"><i :style="{ width: d.score + '%' }"></i></div>
        <span class="dim-score">{{ d.score }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mc-body {
  display: flex;
  gap: 22px;
  align-items: center;
}

.ring-wrap {
  flex: none;
}

.ring-bg {
  fill: none;
  stroke: var(--border);
  stroke-width: 10;
}

.ring-fg {
  fill: none;
  stroke: var(--accent);
  stroke-width: 10;
  stroke-linecap: round;
  stroke-dasharray: 0 100;
  transform: rotate(-90deg);
  transform-origin: center;
  transition: stroke-dasharray 0.5s ease;
}

.ring-fg.mid {
  stroke: color-mix(in srgb, var(--accent) 45%, #ffffff);
}

.ring-fg.low {
  stroke: var(--muted);
}

.ring-val {
  font-size: 29px;
  font-weight: 600;
  text-anchor: middle;
  fill: var(--fg);
}

.ring-lab {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-anchor: middle;
  fill: var(--muted);
}

.dims {
  flex: 1;
  display: grid;
  gap: 7px;
  min-width: 0;
}

.dim {
  display: grid;
  grid-template-columns: 64px 1fr 30px;
  align-items: center;
  gap: 8px;
}

.dim-label {
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.02em;
}

.dim-score {
  font-size: 11.5px;
  font-weight: 600;
  text-align: right;
  letter-spacing: 0.02em;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}

.bar > i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.4s ease;
}
</style>
