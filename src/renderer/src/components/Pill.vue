<script setup lang="ts">
/** Pill 标签（#42 T2）：tone = ''（普通）| tint | solid | ghost。 */
withDefaults(defineProps<{ tone?: '' | 'tint' | 'solid' | 'ghost' }>(), { tone: '' })
</script>

<template>
  <span class="pill" :class="tone"><slot /></span>
</template>
