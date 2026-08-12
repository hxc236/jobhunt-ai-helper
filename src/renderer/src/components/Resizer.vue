<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { bindResizer, COL_DEFAULT, COL_MAX, COL_MIN, SB_DEFAULT, SB_MAX, SB_MIN, type ResizerOptions } from '../layout'

/** 拖拽调宽手柄（#42 T1）：mode='sb' 侧边栏 / 'col' 内容列；双击还原默认宽。 */
const props = withDefaults(defineProps<{ mode: 'sb' | 'col' }>(), { mode: 'col' })

const el = ref<HTMLElement | null>(null)
let unbind: (() => void) | null = null

onMounted(() => {
  if (!el.value) return
  const opts: ResizerOptions =
    props.mode === 'sb'
      ? { name: '--sbw', min: SB_MIN, max: SB_MAX, reset: SB_DEFAULT, collapseBelow: true }
      : { name: '--colw', min: COL_MIN, max: COL_MAX, reset: COL_DEFAULT }
  unbind = bindResizer(el.value, opts)
})

onUnmounted(() => unbind?.())
</script>

<template>
  <div
    ref="el"
    :class="mode === 'sb' ? 'sb-resizer' : 'col-resizer'"
    :title="mode === 'sb' ? '拖动调整宽度 · 双击还原' : '拖动调整宽度 · 双击还原'"
    role="separator"
    aria-orientation="vertical"
  ></div>
</template>
