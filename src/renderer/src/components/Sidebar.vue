<script setup lang="ts">
import { RouterLink } from 'vue-router'
import Icon from './Icon.vue'

/** 侧边栏（#42 T1）：品牌区 + 图标导航 + 版本脚注；学习带静态红点。 */
const navItems = [
  { path: '/jobs', label: '职位', icon: 'briefcase' },
  { path: '/resumes', label: '简历', icon: 'fileText' },
  { path: '/learn', label: '学习', icon: 'book', dot: true },
  { path: '/interview', label: '面试', icon: 'mic' }
]
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">
        <Icon name="briefcase" />
      </div>
      <div>
        <div class="brand-name">求职助手</div>
        <div class="brand-sub">JOBHUNT · 本地版</div>
      </div>
    </div>

    <nav class="nav">
      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        active-class="active"
      >
        <Icon :name="item.icon" />
        {{ item.label }}
        <span v-if="item.dot" class="nav-dot" aria-hidden="true"></span>
      </RouterLink>
    </nav>

    <div class="side-foot">
      本地单机 · 数据存于 SQLite<br />
      无账号 · 无云同步
    </div>

    <RouterLink to="/settings" class="nav-item nav-settings" active-class="active">
      <Icon name="gear" />
      设置
    </RouterLink>
  </aside>
</template>
