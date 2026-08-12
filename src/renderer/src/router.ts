import { createRouter, createWebHashHistory } from 'vue-router'
import PositionsView from './views/PositionsView.vue'
import PositionDetailView from './views/PositionDetailView.vue'
import ResumesView from './views/ResumesView.vue'
import PlaceholderView from './views/PlaceholderView.vue'
import SettingsView from './views/SettingsView.vue'

/**
 * 应用路由（hash 模式，Electron file:// 友好；docs/architecture.md：/jobs /resumes
 * /learn /interview /settings）。四个业务模块的视图随各 ticket 逐个替换占位页：
 * 简历 F-13（#25）· 学习 F-27（#35）· 面试 F-31（#38）· 采集 F-11（#29）。
 * 职位详情子路由 /jobs/:id（F-03/#20）：详情 + 编辑 + 删除。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/jobs' },
    { path: '/jobs', name: 'jobs', component: PositionsView },
    { path: '/jobs/:id', name: 'job-detail', component: PositionDetailView },
    { path: '/resumes', name: 'resumes', component: ResumesView },
    { path: '/learn', name: 'learn', component: PlaceholderView, props: { title: '学习' } },
    { path: '/interview', name: 'interview', component: PlaceholderView, props: { title: '面试' } },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
