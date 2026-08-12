import { createRouter, createWebHashHistory } from 'vue-router'
import PositionsView from './views/PositionsView.vue'
import ResumesView from './views/ResumesView.vue'
import LearnView from './views/LearnView.vue'
import InterviewView from './views/InterviewView.vue'

import SettingsView from './views/SettingsView.vue'

/**
 * 应用路由（hash 模式，Electron file:// 友好；docs/architecture.md：/jobs /resumes
 * /learn /interview /settings）。四个业务模块的视图随各 ticket 逐个替换占位页：
 * 简历 F-13（#25）· 学习 F-27（#35）· 面试 F-31（#38）· 采集 F-11（#29）。
 * 职位详情已并入 /jobs 双栏（#42 T2），/jobs/:id 保留为重定向。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/jobs' },
    { path: '/jobs', name: 'jobs', component: PositionsView },
    { path: '/jobs/:id', redirect: '/jobs' },
    { path: '/resumes', name: 'resumes', component: ResumesView },
    { path: '/learn', name: 'learn', component: LearnView },
    { path: '/interview', name: 'interview', component: InterviewView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
