import { createRouter, createWebHashHistory } from 'vue-router'
import PositionsView from './views/PositionsView.vue'
import PlaceholderView from './views/PlaceholderView.vue'
import SettingsView from './views/SettingsView.vue'

/**
 * 应用路由（hash 模式，Electron file:// 友好；docs/architecture.md：/jobs /resumes
 * /learn /interview /settings）。四个业务模块的视图随各 ticket 逐个替换占位页：
 * 简历 F-13（#25）· 学习 F-27（#35）· 面试 F-31（#38）· 采集 F-11（#29）。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/jobs' },
    { path: '/jobs', name: 'jobs', component: PositionsView },
    { path: '/resumes', name: 'resumes', component: PlaceholderView, props: { title: '简历' } },
    { path: '/learn', name: 'learn', component: PlaceholderView, props: { title: '学习' } },
    { path: '/interview', name: 'interview', component: PlaceholderView, props: { title: '面试' } },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
