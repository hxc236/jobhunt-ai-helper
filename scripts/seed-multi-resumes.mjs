// 测试接缝：向隔离 userData 的 jobhunt.db 预置多条基准简历（#100 修复后 computer-use 全量验证用）。
// 用法（Electron-as-Node，better-sqlite3 按 Electron ABI 编译）：
//   ELECTRON_RUN_AS_NODE=1 electron scripts/seed-multi-resumes.mjs <userDataDir>
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('用法：seed-multi-resumes.mjs <userDataDir>')
  process.exit(1)
}
const dbPath = join(userDataDir, 'jobhunt.db')
const db = new Database(dbPath)

const now = new Date().toISOString()

/** 三条风格各异的基准简历：A 缺难点/结果、B 结构冗长待拆解、C 较完整（真实 LLM 诊断素材）。 */
const resumes = [
  {
    meta: { title: '基准简历 A（后端开发）' },
    basics: { name: '张伟', phone: '13800001234', email: 'zhangwei@example.com', jobIntention: { position: 'Java 后端开发', city: ['北京'], salary: '' } },
    education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术', startDate: '2021-09', endDate: '2025-06', gpa: '3.6/4.0', rank: '', courses: ['数据结构', '操作系统'] }],
    skills: [{ category: '工程能力', text: 'Java、Spring Boot、MySQL、Redis' }],
    projects: [
      { name: '二手交易平台', description: 'C2C 二手交易系统，实现商品发布、搜索、下单与支付对接，用户量约 5000。', techStack: ['Java', 'Spring Boot', 'MySQL'] },
      { name: '校园二手书小程序', description: '基于微信小程序的二手书交易，支持扫码识别 ISBN 自动填充书籍信息。', techStack: ['微信小程序', 'Node.js'] }
    ],
    honors: ['校二等奖学金']
  },
  {
    meta: { title: '基准简历 B（前端方向）' },
    basics: { name: '李娜', phone: '13900005678', email: 'lina@example.com', jobIntention: { position: '前端开发工程师', city: ['上海'], salary: '' } },
    education: [{ school: '上海大学', degree: '本科', major: '软件工程', startDate: '2020-09', endDate: '2024-06', gpa: '', rank: '前 20%', courses: [] }],
    skills: [{ category: '工程能力', text: 'Vue3、TypeScript、Vite' }],
    projects: [
      { name: '可视化大屏项目', description: '参与公司数据可视化大屏开发，负责图表组件封装和性能优化，页面加载时间从 3 秒优化到 1 秒以内，还写了接口联调文档，负责了多个模块的开发工作，包括数据请求模块、图表渲染模块、筛选交互模块，以及后续的维护工作，内容比较长但是有效信息不多。', techStack: ['Vue3', 'ECharts', 'TypeScript'] }
    ],
    experience: [{ company: '某科技公司', title: '前端实习生', startDate: '2023-07', endDate: '2023-10', highlights: ['参与内部后台系统开发'], techStack: ['Vue2'] }],
    honors: ['全国大学生服务外包创新创业大赛三等奖']
  },
  {
    meta: { title: '基准简历 C（算法方向）' },
    basics: { name: '王强', phone: '13700009012', email: 'wangqiang@example.com', jobIntention: { position: '算法工程师', city: ['深圳'], salary: '' } },
    education: [{ school: '华中科技大学', degree: '硕士', major: '计算机科学与技术', startDate: '2023-09', endDate: '2026-06', gpa: '', rank: '', courses: ['机器学习', '深度学习'] }],
    skills: [{ category: '工程能力', text: 'Python、PyTorch' }, { category: '框架与平台', text: 'LangChain、Docker' }],
    projects: [
      {
        name: '智能客服问答系统',
        description: '基于检索增强生成（RAG）的客服问答系统，面向电商客服场景。难点：回答准确率低、幻觉多；解决行动：引入重排序与引用溯源，准确率从 68% 提升到 89%；个人负责整体方案设计与检索链路实现。',
        techStack: ['Python', 'LangChain', 'Milvus'],
        highlights: ['设计 RAG 检索链路并实现重排序，准确率从 68% 提升到 89%', '构建 2 万条领域问答评估集，建立回归基线']
      }
    ],
    honors: ['国家奖学金', '蓝桥杯程序设计大赛省一等奖']
  }
]

// 清空重建（测试环境；应用需先退出）
db.prepare('DELETE FROM resumes').run()
db.prepare('DELETE FROM content_optimize_tasks').run()

const insert = db.prepare(
  'INSERT INTO resumes (id, json, base_resume_id, target_job_id, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)'
)
let count = 0
for (const r of resumes) {
  const id = `res-${randomUUID()}`
  // 与 ResumeService.create 一致：meta 含 id/createdAt/updatedAt/baseResumeId/targetJobId
  const full = {
    ...r,
    meta: {
      id,
      title: r.meta.title,
      createdAt: now,
      updatedAt: now,
      baseResumeId: null,
      targetJobId: null
    }
  }
  insert.run(id, JSON.stringify(full), now, now)
  count++
}
console.log(`seeded ${count} base resumes into ${dbPath}`)
db.close()
