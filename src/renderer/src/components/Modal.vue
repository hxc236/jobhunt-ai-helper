<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import Icon from './Icon.vue'

/** 弹窗（#42 T2）：遮罩点击空白处关闭 + Escape 关闭 + 打开时聚焦首个可输入控件。 */
const props = defineProps<{ open: boolean; title: string; width?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    setTimeout(() => {
      const f = document.querySelector<HTMLElement>(
        '.mask.open input:not([type=hidden]):not([type=checkbox]), .mask.open select, .mask.open textarea'
      )
      f?.focus()
    }, 60)
  }
)
</script>

<template>
  <div v-if="open" class="mask open" @click.self="emit('close')">
    <div class="modal" :style="width ? { width } : undefined">
      <div class="modal-head">
        <h2>{{ title }}</h2>
        <div class="head-right">
          <slot name="head-actions" />
          <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')">
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div class="modal-body">
        <slot />
      </div>
      <div v-if="$slots.foot" class="modal-foot">
        <slot name="foot" />
      </div>
    </div>
  </div>
</template>
