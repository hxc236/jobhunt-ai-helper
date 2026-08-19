// E2E 内容优化冒烟（#90/T02，T04 追问场景）：真实启动应用（假 agent）+ 鼠标/键盘驱动 + 截图/无障碍快照断言 + 落库断言。
//
// 运行方式（Electron-as-Node，better-sqlite3 为 Electron ABI）：
//   ELECTRON_RUN_AS_NODE=1 electron scripts/e2e-content-optimize.mjs
// 或 npm script：npm run e2e:content-optimize
//
// 场景（JOBHUNT_E2E_SCENARIO）：
//   empty（默认）     —— 空诊断垂直切片：触发 → 无需修改 → 确认不建版本；
//   questions（T04）  —— 追问流程：触发 → 等待回答（批量问答表单：分组/证据/四选一/自由输入）
//                        → 生成优化稿 → 可确认 → 确认创建新基准简历；
//   promotion（T08）  —— 大赛提升流程：触发 → 大赛提升建议 → 缺失字段补齐 → 确认提升 → 重新诊断 → 确认；
//   full（T09）       —— 全流程冒烟：触发 → 诊断进度 → 追问作答 → 逐项确认（接受改写 +
//                        推断-待确认勾选门禁）→ 确认入库新基准（血缘/answers/诊断全部落库断言）。
//
// 真实 agent 冒烟入口（T09/AC4，手动运行）：JOBHUNT_E2E_REAL=1 时不注入假 agent，
// 真实启动应用（需先在应用内配置 agent）并驱动「触发 → 任务到达稳定阶段」；
// 确定性断言不适用（冒烟接缝），失败时给出明确错误。见 scripts/e2e-content-optimize-real.md。
//
// 前置：先 `npm run build`（electron-vite 产物 out/）。
//
// 流程：
//  1) 创建临时 userData 目录；
//  2) 以 JOBHUNT_FAKE_AGENT=1 + JOBHUNT_E2E_SEED=1 + JOBHUNT_USER_DATA_DIR=临时目录 真实启动应用；
//  3) 读取 userData/DevToolsActivePort → playwright-core connectOverCDP；
//  4) 驱动 UI（CDP 鼠标/键盘模拟，等价 OS 级输入）；
//  5) 断言：截图 + 无障碍快照 + 落库（任务状态 / answers / 简历版本数）；
//  6) 退出应用，清理临时目录。
//
// 定位为冒烟接缝（依赖真实显示环境），非全量回归（#90 Testing Decisions）。

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import Database from 'better-sqlite3'

const require = createRequire(import.meta.url)
const electronPath = require('electron') // electron 包导出二进制路径
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 userData/DevToolsActivePort 读 CDP 端口（轮询等待应用启动）。 */
async function readDevToolsPort(userDataDir) {
  for (let i = 0; i < 120; i++) {
    try {
      const raw = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf-8').trim()
      const port = Number(raw.split('\n')[0])
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      // 文件尚未生成
    }
    await sleep(250)
  }
  throw new Error('未在 userData 发现 DevToolsActivePort（应用启动失败？）')
}

/** 读取任务落库（DB 反查任务 id）。 */
function readTaskRow(userDataDir) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    return db.prepare('SELECT * FROM content_optimize_tasks LIMIT 1').get()
  } finally {
    db.close()
  }
}

/** 轮询落库直到推断-待确认勾选持久化（UI 勾选 → setReview IPC → 落库一致，AC3）。 */
async function waitForInferredPersisted(userDataDir, changeId) {
  for (let i = 0; i < 100; i++) {
    try {
      const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
      try {
        const row = db
          .prepare('SELECT inferred_confirmed_json FROM content_optimize_tasks LIMIT 1')
          .get()
        if (row !== undefined) {
          const confirmed = JSON.parse(row.inferred_confirmed_json ?? 'null')
          if (Array.isArray(confirmed) && confirmed.includes(changeId)) return
        }
      } finally {
        db.close()
      }
    } catch {
      // DB 暂时不可读（WAL 切换等），重试
    }
    await sleep(100)
  }
  throw new Error(`推断-待确认改动未在限定时间内持久化到任务存储：${changeId}`)
}

/** 断言落库状态（empty 场景）：任务 confirmed + 空诊断不创建新版本。 */
function assertEmptyDatabase(userDataDir, taskId) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    const task = db
      .prepare('SELECT status, no_changes, progress, created_resume_id, archived_at FROM content_optimize_tasks WHERE id = ?')
      .get(taskId)
    if (task === undefined) throw new Error(`任务 ${taskId} 未落库`)
    if (task.status !== 'confirmed') throw new Error(`任务状态应为 confirmed，实际 ${task.status}`)
    if (task.no_changes !== 1) throw new Error('空诊断路径 no_changes 应为 1')
    if (task.progress !== '已确认') throw new Error(`进度文案异常：${task.progress}`)
    if (task.archived_at === null) throw new Error('空诊断路径也应归档（archived_at 应为非 NULL）')
    if (task.created_resume_id !== null) {
      throw new Error(`空诊断不应有血缘新基准：created_resume_id 应为 null，实际 ${task.created_resume_id}`)
    }
    const resumeCount = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n
    if (resumeCount !== 1) {
      throw new Error(`空诊断不应创建新版本：resumes 应为 1，实际 ${resumeCount}`)
    }
    console.log(`  [db] task=${task.status} no_changes=${task.no_changes} archived=${task.archived_at !== null} resumes=${resumeCount} ✓`)
  } finally {
    db.close()
  }
}

/** 断言落库状态（questions 场景）：任务 confirmed + answers 持久化 + 新基准简历创建。 */
function assertQuestionsDatabase(userDataDir, taskId) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    const task = db
      .prepare('SELECT status, no_changes, answers_json, summary_json, created_resume_id, archived_at FROM content_optimize_tasks WHERE id = ?')
      .get(taskId)
    if (task === undefined) throw new Error(`任务 ${taskId} 未落库`)
    if (task.status !== 'confirmed') throw new Error(`任务状态应为 confirmed，实际 ${task.status}`)
    if (task.no_changes !== 0) throw new Error('追问场景有改写，no_changes 应为 0')
    if (task.archived_at === null) throw new Error('有改写的确认也应归档（archived_at 应为非 NULL）')
    if (task.created_resume_id === null) throw new Error('有改写的确认应记录血缘新基准 id（created_resume_id 不应为 null）')
    const answers = JSON.parse(task.answers_json)
    if (answers.q1 !== '高并发秒杀压测优化') {
      throw new Error(`answers.q1（确认候选）落库异常：${JSON.stringify(answers)}`)
    }
    if (!String(answers.q2 ?? '').includes('p95')) {
      throw new Error(`answers.q2（自由输入）落库异常：${JSON.stringify(answers)}`)
    }
    const resumeCount = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n
    if (resumeCount !== 2) {
      throw new Error(`有改写的确认应创建新基准简历：resumes 应为 2，实际 ${resumeCount}`)
    }
    const summary = JSON.parse(String(task.summary_json))
    if (summary.unresolvedProjects.length !== 0) {
      throw new Error(`确认后不应有未解决项目：${JSON.stringify(summary)}`)
    }
    console.log(`  [db] task=${task.status} no_changes=${task.no_changes} resumes=${resumeCount} answers=${JSON.stringify(answers)} created=${task.created_resume_id} ✓`)
  } finally {
    db.close()
  }
}

/** 断言落库状态（full 场景，T09）：任务 confirmed + 追问/回答/改写/血缘全部落库 + 新基准入库。 */
function assertFullDatabase(userDataDir, taskId) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    const task = db
      .prepare(
        'SELECT status, no_changes, answers_json, diagnosis_json, rewrite_json, summary_json, created_resume_id, archived_at FROM content_optimize_tasks WHERE id = ?'
      )
      .get(taskId)
    if (task === undefined) throw new Error(`任务 ${taskId} 未落库`)
    if (task.status !== 'confirmed') throw new Error(`任务状态应为 confirmed，实际 ${task.status}`)
    if (task.no_changes !== 0) throw new Error('全流程有改写，no_changes 应为 0')
    if (task.archived_at === null) throw new Error('全流程确认应归档（archived_at 应为非 NULL）')
    if (task.created_resume_id === null) {
      throw new Error('全流程确认应记录血缘新基准 id（created_resume_id 不应为 null）')
    }
    // 追问回答落库（AC3：任务存储与 UI 呈现一致）
    const answers = JSON.parse(task.answers_json)
    if (answers.q1 !== '高并发秒杀压测优化') {
      throw new Error(`answers.q1（确认候选）落库异常：${JSON.stringify(answers)}`)
    }
    if (!String(answers.q2 ?? '').includes('p95')) {
      throw new Error(`answers.q2（自由输入）落库异常：${JSON.stringify(answers)}`)
    }
    // 诊断落库（规则判定 + 追问 + 项目判定）
    const diagnosis = JSON.parse(task.diagnosis_json)
    if (diagnosis.rules.length < 2) {
      throw new Error(`诊断规则未全部落库：${JSON.stringify(diagnosis)}`)
    }
    if (diagnosis.questions.length !== 2) {
      throw new Error(`诊断追问未全部落库：${JSON.stringify(diagnosis.questions)}`)
    }
    if (diagnosis.projects[0]?.verdict !== 'needs-info') {
      throw new Error(`项目判定未落库：${JSON.stringify(diagnosis.projects)}`)
    }
    // 改写落库（含 inferred 改动——推断-待确认勾选门禁的来源）
    const rewrite = JSON.parse(task.rewrite_json)
    const sources = (rewrite.changes ?? []).map((c) => c.source)
    if (!sources.includes('inferred')) {
      throw new Error(`改写应含 inferred 改动：${JSON.stringify(rewrite.changes)}`)
    }
    if (!sources.includes('user-answer')) {
      throw new Error(`改写应含 user-answer 改动：${JSON.stringify(rewrite.changes)}`)
    }
    // 整合汇总：无未解决项目
    const summary = JSON.parse(String(task.summary_json))
    if (summary.unresolvedProjects.length !== 0) {
      throw new Error(`确认后不应有未解决项目：${JSON.stringify(summary)}`)
    }
    // 简历表：新基准入库（血缘不进简历 JSON）+ 旧基准保留（AC3）
    const rows = db.prepare('SELECT id, json FROM resumes').all()
    if (rows.length !== 2) {
      throw new Error(`全流程确认应创建新基准简历：resumes 应为 2，实际 ${rows.length}`)
    }
    const createdRow = rows.find((r) => r.id === task.created_resume_id)
    if (createdRow === undefined) {
      throw new Error(`血缘新基准 ${task.created_resume_id} 未在 resumes 表`)
    }
    const created = JSON.parse(createdRow.json)
    if (created.meta?.baseResumeId != null) {
      throw new Error(`新基准 baseResumeId 应为 null：${JSON.stringify(created.meta)}`)
    }
    if ('contentOptimizeTaskId' in (created.meta ?? {})) {
      throw new Error('血缘不应写入简历 JSON（meta.contentOptimizeTaskId 不应存在）')
    }
    const project = created.projects?.[0]
    if (!String(project?.description ?? '').includes('高并发秒杀压测优化')) {
      throw new Error(`新基准项目未融合回答事实：${project?.description}`)
    }
    if (!(project?.highlights ?? []).includes('压测 QPS 从 800 提升至 3200')) {
      throw new Error(`新基准项目未包含推断要点：${JSON.stringify(project?.highlights)}`)
    }
    const oldBase = rows.find((r) => r.id !== task.created_resume_id)
    const oldJson = JSON.parse(oldBase.json)
    if (oldJson.meta?.title !== '基准简历（E2E）') {
      throw new Error(`旧基准应保留：${oldJson.meta?.title}`)
    }
    if (oldJson.projects?.[0]?.description !== 'C2C 二手交易系统') {
      throw new Error(`旧基准项目应保持原文：${oldJson.projects?.[0]?.description}`)
    }
    console.log(`  [db] task=${task.status} no_changes=${task.no_changes} resumes=${rows.length} created=${task.created_resume_id} answers=${JSON.stringify(answers)} inferred=${sources.filter((s) => s === 'inferred').length} ✓`)
  } finally {
    db.close()
  }
}

/** 断言落库状态（promotion 场景）：任务 confirmed + honors→projects 提升落库 + 无新版本。 */
function assertPromotionDatabase(userDataDir, taskId) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    const task = db
      .prepare('SELECT status, no_changes, answers_json, created_resume_id, archived_at FROM content_optimize_tasks WHERE id = ?')
      .get(taskId)
    if (task === undefined) throw new Error(`任务 ${taskId} 未落库`)
    if (task.status !== 'confirmed') throw new Error(`任务状态应为 confirmed，实际 ${task.status}`)
    if (task.no_changes !== 1) throw new Error('提升后空诊断 no_changes 应为 1')
    if (task.archived_at === null) throw new Error('promotion 场景确认也应归档')
    if (task.created_resume_id !== null) {
      throw new Error(`提升后无改动不应建新版本：created_resume_id 应为 null，实际 ${task.created_resume_id}`)
    }
    // 提升回答落库（promotion-promo-0-* 键）
    const answers = JSON.parse(task.answers_json)
    if (answers['promotion-promo-0-startDate'] !== '2023-04') {
      throw new Error(`提升 startDate 回答未落库：${JSON.stringify(answers)}`)
    }
    if (!String(answers['promotion-promo-0-description'] ?? '').includes('数学建模')) {
      throw new Error(`提升 description 回答未落库：${JSON.stringify(answers)}`)
    }
    // 简历落库：honors 移除大赛（保留校三好学生），projects 追加提升项目
    const resumeRow = db.prepare('SELECT json FROM resumes LIMIT 1').get()
    const resume = JSON.parse(resumeRow.json)
    if (resume.honors.length !== 1 || resume.honors[0] !== '校三好学生') {
      throw new Error(`honors 未移除大赛条目：${JSON.stringify(resume.honors)}`)
    }
    const promoted = (resume.projects ?? []).find((p) => p.name === '全国大学生数学建模竞赛省一等奖')
    if (promoted === undefined) {
      throw new Error(`提升项目未入库：${JSON.stringify((resume.projects ?? []).map((p) => p.name))}`)
    }
    if (promoted.id === undefined) throw new Error('提升项目缺少稳定 id')
    if (promoted.startDate !== '2023-04') throw new Error(`提升项目 startDate 异常：${promoted.startDate}`)
    if (!(promoted.techStack ?? []).includes('Python')) throw new Error(`提升项目 techStack 异常：${JSON.stringify(promoted.techStack)}`)
    const resumeCount = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n
    if (resumeCount !== 1) {
      throw new Error(`提升后无改动不应创建新版本：resumes 应为 1，实际 ${resumeCount}`)
    }
    console.log(`  [db] task=${task.status} honors=1 projects=${(resume.projects ?? []).length} promoted=${promoted.name} resumes=${resumeCount} answers=${JSON.stringify(answers)} ✓`)
  } finally {
    db.close()
  }
}

/** empty 场景：触发 → 无需修改 → 键盘确认 → 断言。 */
async function runEmptyFlow(page, userDataDir) {
  await page.locator('.nav-item', { hasText: '简历' }).first().click()
  await page.waitForSelector('.view.cols', { timeout: 10_000 })
  await page.waitForSelector('.res-row', { timeout: 10_000 })

  const row = page.locator('.res-row').first()
  await row.locator('button', { hasText: '内容优化' }).first().click()

  await page.waitForSelector('.opt-task-card', { timeout: 10_000 })
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('无需修改')
  }, undefined, { timeout: 15_000 })
  const taskCard = await page.locator('.opt-task-card').first().innerText()
  console.log('  任务卡片：')
  console.log('  ' + taskCard.split('\n').join('\n  '))

  // 键盘驱动确认（等价 OS 级按键）
  const confirmBtn = page.locator('.opt-task-card button', { hasText: '确认' }).first()
  await confirmBtn.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('已确认')
  }, undefined, { timeout: 10_000 })
  console.log('  确认后任务卡片状态 = 已确认（键盘 Enter 驱动）✓')

  const shotPath = join(userDataDir, 'task-card-confirmed.png')
  await page.screenshot({ path: shotPath, fullPage: false })
  console.log(`  截图：${shotPath}`)
  const a11y = await page.locator('.opt-task-card').ariaSnapshot()
  if (!a11y.includes('已确认')) {
    throw new Error(`无障碍快照未包含任务状态文本：${a11y.slice(0, 200)}`)
  }
  console.log('  无障碍快照断言 ✓')

  const taskRow = readTaskRow(userDataDir)
  if (taskRow === undefined) throw new Error('未发现内容优化任务落库')
  assertEmptyDatabase(userDataDir, taskRow.id)
}

/** questions 场景（T04）：触发 → 等待回答（表单：分组/证据/四选一/自由输入）→ 生成优化稿 → 可确认 → 确认。 */
async function runQuestionsFlow(page, userDataDir) {
  await page.locator('.nav-item', { hasText: '简历' }).first().click()
  await page.waitForSelector('.view.cols', { timeout: 10_000 })
  await page.waitForSelector('.res-row', { timeout: 10_000 })

  const row = page.locator('.res-row').first()
  await row.locator('button', { hasText: '内容优化' }).first().click()

  // 等待任务卡片进入「等待回答」并出现批量问答表单
  await page.waitForSelector('.opt-task-card', { timeout: 10_000 })
  await page.waitForSelector('.opt-answers', { timeout: 15_000 })
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('等待回答')
  }, undefined, { timeout: 15_000 })

  // 无障碍快照断言：分组标题 / 原文证据 / 四选一按钮存在
  const formA11y = await page.locator('.opt-answers').ariaSnapshot()
  for (const expectText of ['项目：', '原文证据：', '确认属实', '编辑后确认', '不属实', '无法补充', '已答 0/2 项']) {
    if (!formA11y.includes(expectText)) {
      throw new Error(`追问表单无障碍快照缺少「${expectText}」：${formA11y.slice(0, 300)}`)
    }
  }
  console.log('  追问表单（分组/证据/四选一）无障碍快照断言 ✓')

  // 驱动问题 1：点「确认属实」（候选原文入答案）——鼠标驱动
  const q1 = page.locator('.opt-ans-question', { hasText: '技术难点' }).first()
  await q1.locator('button', { hasText: '确认属实' }).first().click()

  // 驱动问题 2：自由输入（点击文本框 + 键盘输入）——键盘驱动
  const q2 = page.locator('.opt-ans-question', { hasText: '结果' }).first()
  await q2.locator('textarea').click()
  await page.keyboard.type('p95 180ms')

  // 断言计数实时更新：已答 2/2 项 · 未答 0 项
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('已答 2/2 项') && card.textContent.includes('未答 0 项')
  }, undefined, { timeout: 10_000 })
  console.log('  已答 2/2 项 · 未答 0 项（实时计数）✓')

  const shotPath = join(userDataDir, 'task-card-awaiting-answers.png')
  await page.screenshot({ path: shotPath, fullPage: false })
  console.log(`  截图：${shotPath}`)

  // 生成优化稿 → rewriting → 可确认（改写轮返回合法 ContentRewrite）
  await page.locator('.opt-answers-submit button', { hasText: '生成优化稿' }).first().click()
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('可确认')
  }, undefined, { timeout: 15_000 })
  console.log('  生成优化稿 → 任务流转到「可确认」✓')

  // T06/#96 逐项目确认区：改写稿/来源标签/接受·保留控件出现
  await page.waitForSelector('.opt-review', { timeout: 10_000 })
  const reviewA11y = await page.locator('.opt-review').ariaSnapshot()
  for (const expectText of ['逐项目确认', '已改写', '接受改写', '保留原文', '用户回答', '改写后']) {
    if (!reviewA11y.includes(expectText)) {
      throw new Error(`逐项目确认区缺少「${expectText}」：${reviewA11y.slice(0, 400)}`)
    }
  }
  console.log('  逐项目确认区（改写稿/来源/接受·保留）无障碍快照断言 ✓')
  const reviewShot = join(userDataDir, 'task-card-review.png')
  await page.screenshot({ path: reviewShot, fullPage: false })
  console.log(`  截图：${reviewShot}`)

  // 键盘确认
  const confirmBtn = page.locator('.opt-task-card button', { hasText: '确认' }).first()
  await confirmBtn.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('已确认')
  }, undefined, { timeout: 10_000 })
  console.log('  确认后任务卡片状态 = 已确认（键盘 Enter 驱动）✓')

  const taskRow = readTaskRow(userDataDir)
  if (taskRow === undefined) throw new Error('未发现内容优化任务落库')
  assertQuestionsDatabase(userDataDir, taskRow.id)
}

/** full 场景（T09）：全流程冒烟——触发 → 诊断进度 → 追问作答 → 逐项确认（接受改写 + inferred 勾选）→ 确认入库新基准。 */
async function runFullFlow(page, userDataDir) {
  await page.locator('.nav-item', { hasText: '简历' }).first().click()
  await page.waitForSelector('.view.cols', { timeout: 10_000 })
  await page.waitForSelector('.res-row', { timeout: 10_000 })

  const row = page.locator('.res-row').first()
  await row.locator('button', { hasText: '内容优化' }).first().click()

  // AC2 触发：任务卡片出现，且先经过「诊断中…」阶段（full 场景诊断轮留出可见窗口）
  await page.waitForSelector('.opt-task-card', { timeout: 10_000 })
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('诊断中')
  }, undefined, { timeout: 10_000 })
  console.log('  触发后任务卡片显示「诊断中…」阶段进度 ✓')
  const diagShot = join(userDataDir, 'task-card-diagnosing.png')
  await page.screenshot({ path: diagShot, fullPage: false })
  console.log(`  截图：${diagShot}`)

  // AC2 追问：等待回答 → 批量问答表单出现
  await page.waitForSelector('.opt-answers', { timeout: 15_000 })
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('等待回答')
  }, undefined, { timeout: 15_000 })
  const formA11y = await page.locator('.opt-answers').ariaSnapshot()
  for (const expectText of ['项目：', '原文证据：', '确认属实', '编辑后确认', '不属实', '无法补充', '已答 0/2 项']) {
    if (!formA11y.includes(expectText)) {
      throw new Error(`追问表单无障碍快照缺少「${expectText}」：${formA11y.slice(0, 300)}`)
    }
  }
  console.log('  追问表单（分组/证据/四选一）无障碍快照断言 ✓')

  // 追问作答（鼠标 + 键盘驱动）
  const q1 = page.locator('.opt-ans-question', { hasText: '技术难点' }).first()
  await q1.locator('button', { hasText: '确认属实' }).first().click()
  const q2 = page.locator('.opt-ans-question', { hasText: '结果' }).first()
  await q2.locator('textarea').click()
  await page.keyboard.type('p95 180ms')
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('已答 2/2 项') && card.textContent.includes('未答 0 项')
  }, undefined, { timeout: 10_000 })
  console.log('  追问作答完成：已答 2/2 项 · 未答 0 项 ✓')

  // 生成优化稿 → 可确认（改写轮返回含 inferred 改动的合法 ContentRewrite）
  await page.locator('.opt-answers-submit button', { hasText: '生成优化稿' }).first().click()
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('可确认')
  }, undefined, { timeout: 15_000 })
  console.log('  生成优化稿 → 任务流转到「可确认」✓')

  // AC2 逐项确认：确认区出现接受/拒绝控件与推断-待确认勾选（US16/US17）
  await page.waitForSelector('.opt-review', { timeout: 10_000 })
  const reviewA11y = await page.locator('.opt-review').ariaSnapshot()
  for (const expectText of ['逐项目确认', '已改写', '接受改写', '保留原文', '用户回答', '推断-待确认', '改写后', '确认纳入最终版']) {
    if (!reviewA11y.includes(expectText)) {
      throw new Error(`逐项目确认区缺少「${expectText}」：${reviewA11y.slice(0, 400)}`)
    }
  }
  console.log('  逐项目确认区（接受·保留 / 用户回答 / 推断-待确认勾选）无障碍快照断言 ✓')

  // 门禁：存在未勾选的推断-待确认改动 → 确认按钮禁用（先勾选提示）
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('先勾选推断-待确认 1 项')
  }, undefined, { timeout: 10_000 })
  console.log('  推断-待确认门禁：确认按钮禁用（先勾选提示）✓')
  const gateShot = join(userDataDir, 'task-card-inferred-gate.png')
  await page.screenshot({ path: gateShot, fullPage: false })
  console.log(`  截图：${gateShot}`)

  // 驱动接受改写（鼠标点击控件）
  const reviewProject = page.locator('.opt-review-project').first()
  await reviewProject.locator('button', { hasText: '接受改写' }).first().click()
  console.log('  接受改写（逐项目决策控件）驱动 ✓')

  // 驱动推断-待确认勾选（鼠标点击 checkbox）→ 确认按钮恢复可用
  await page.locator('.opt-review .opt-review-confirm input[type="checkbox"]').first().click()
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && !card.textContent.includes('先勾选推断-待确认')
  }, undefined, { timeout: 10_000 })
  // 等待 setReview IPC 持久化完成（确认门禁以落库状态为准）——同时断言「UI 勾选 → 落库一致」
  await waitForInferredPersisted(userDataDir, 'chg-1')
  console.log('  推断-待确认勾选 → 确认按钮恢复可用（落库一致）✓')
  const reviewShot = join(userDataDir, 'task-card-review-confirmed.png')
  await page.screenshot({ path: reviewShot, fullPage: false })
  console.log(`  截图：${reviewShot}`)

  // AC2 入库：键盘 Enter 确认 → 任务已确认（新基准入库）
  const confirmBtn = page.locator('.opt-task-card button.btn.primary', { hasText: '确认' }).first()
  await confirmBtn.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('已确认')
  }, undefined, { timeout: 10_000 })
  console.log('  确认后任务卡片状态 = 已确认（键盘 Enter 驱动）✓')
  const doneShot = join(userDataDir, 'task-card-full-confirmed.png')
  await page.screenshot({ path: doneShot, fullPage: false })
  console.log(`  截图：${doneShot}`)
  const a11y = await page.locator('.opt-task-card').ariaSnapshot()
  if (!a11y.includes('已确认')) {
    throw new Error(`无障碍快照未包含任务状态文本：${a11y.slice(0, 200)}`)
  }
  console.log('  无障碍快照断言 ✓')

  const taskRow = readTaskRow(userDataDir)
  if (taskRow === undefined) throw new Error('未发现内容优化任务落库')
  assertFullDatabase(userDataDir, taskRow.id)
}

/** 真实 agent 冒烟（T09/AC4，手动运行）：不注入假 agent，触发内容优化并等待到达稳定阶段。 */
async function runRealSmoke(page, userDataDir) {
  await page.locator('.nav-item', { hasText: '简历' }).first().click()
  await page.waitForSelector('.view.cols', { timeout: 10_000 })
  await page.waitForSelector('.res-row', { timeout: 10_000 })

  const row = page.locator('.res-row').first()
  await row.locator('button', { hasText: '内容优化' }).first().click()

  await page.waitForSelector('.opt-task-card', { timeout: 10_000 })
  // 冒烟接缝：真实 agent 输出不确定——等待任务到达稳定阶段（等待回答 / 可确认 / 无需修改 / 失败）
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    if (card === null) return false
    const text = card.textContent
    return (
      text.includes('等待回答') ||
      text.includes('可确认') ||
      text.includes('无需修改') ||
      text.includes('失败')
    )
  }, undefined, { timeout: 600_000 })
  const shotPath = join(userDataDir, 'task-card-real-smoke.png')
  await page.screenshot({ path: shotPath, fullPage: false })
  console.log(`  截图：${shotPath}`)

  const taskRow = readTaskRow(userDataDir)
  if (taskRow === undefined) throw new Error('未发现内容优化任务落库')
  if (taskRow.status === 'failed') {
    throw new Error(`真实 agent 冒烟失败：${String(taskRow.error ?? '').slice(0, 500)}`)
  }
  console.log(`  真实 agent 冒烟：任务到达稳定阶段 ${taskRow.status}（确定性断言不适用，冒烟接缝）`)
}

/** promotion 场景（T08）：触发 → 等待回答（大赛提升建议区：证据/缺失字段追问）→ 确认提升 → 重新诊断 → 无需修改 → 确认。 */
async function runPromotionFlow(page, userDataDir) {
  await page.locator('.nav-item', { hasText: '简历' }).first().click()
  await page.waitForSelector('.view.cols', { timeout: 10_000 })
  await page.waitForSelector('.res-row', { timeout: 10_000 })

  const row = page.locator('.res-row').first()
  await row.locator('button', { hasText: '内容优化' }).first().click()

  // 等待任务卡片出现「大赛提升建议」区
  await page.waitForSelector('.opt-task-card', { timeout: 10_000 })
  await page.waitForSelector('.opt-promotions', { timeout: 15_000 })
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('大赛提升建议')
  }, undefined, { timeout: 15_000 })

  // 无障碍快照断言：大赛名 / 原文证据 / 缺失字段追问 / 确认提升按钮
  const promoA11y = await page.locator('.opt-promotions').ariaSnapshot()
  for (const expectText of [
    '全国大学生数学建模竞赛省一等奖',
    '原文证据：',
    '开始时间',
    '技术栈',
    '项目描述',
    '确认提升为项目',
    '暂不提升'
  ]) {
    if (!promoA11y.includes(expectText)) {
      throw new Error(`大赛提升建议区缺少「${expectText}」：${promoA11y.slice(0, 400)}`)
    }
  }
  console.log('  大赛提升建议区（证据/缺失字段/确认按钮）无障碍快照断言 ✓')

  // 键盘驱动补齐缺失字段：开始时间 / 技术栈 / 项目描述
  const fields = [
    { text: '开始时间', value: '2023-04' },
    { text: '技术栈', value: 'Python' },
    { text: '项目描述', value: '为高校数学建模竞赛优化求解方案' }
  ]
  for (const { text, value } of fields) {
    const q = page.locator('.opt-promotion-card .opt-ans-question', { hasText: text }).first()
    await q.locator('textarea').click()
    await page.keyboard.type(value)
  }
  console.log('  缺失字段（开始时间/技术栈/描述）键盘输入 ✓')

  const shotPath = join(userDataDir, 'task-card-promotions.png')
  await page.screenshot({ path: shotPath, fullPage: false })
  console.log(`  截图：${shotPath}`)

  // 确认提升 → 重新诊断（honors 已无大赛 → 全部保持 → 无需修改）
  await page.locator('.opt-promotion-card button', { hasText: '确认提升为项目' }).first().click()
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('无需修改')
  }, undefined, { timeout: 20_000 })
  console.log('  确认提升 → 重新诊断 → 无需修改（提升项目参与诊断后判定保持）✓')

  // 键盘确认
  const confirmBtn = page.locator('.opt-task-card button', { hasText: '确认' }).first()
  await confirmBtn.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const card = document.querySelector('.opt-task-card')
    return card !== null && card.textContent.includes('已确认')
  }, undefined, { timeout: 10_000 })
  console.log('  确认后任务卡片状态 = 已确认（键盘 Enter 驱动）✓')

  const taskRow = readTaskRow(userDataDir)
  if (taskRow === undefined) throw new Error('未发现内容优化任务落库')
  assertPromotionDatabase(userDataDir, taskRow.id)
}

async function main() {
  const scenario = process.env['JOBHUNT_E2E_SCENARIO'] ?? 'empty'
  const realAgent = process.env['JOBHUNT_E2E_REAL'] === '1'

  // 前置：build 产物必须存在（真实启动用 out/）
  if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    console.log('未发现 out/ 构建产物，先执行 npm run build …')
    const build = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }

  // 真实 agent 冒烟（T09/AC4）：JOBHUNT_E2E_USER_DATA 指定持久 userData（预先配置过 agent）；
  // 假 agent 场景一律使用临时目录（隔离）。
  const userDataDir =
    process.env['JOBHUNT_E2E_USER_DATA'] ?? mkdtempSync(join(tmpdir(), 'jh-e2e-content-optimize-'))
  console.log(`临时 userData：${userDataDir}（场景：${scenario}${realAgent ? '，真实 agent 冒烟' : ''}）`)

  // 真实启动应用（假 agent + E2E 种子）——子进程必须是真应用，不能继承 ELECTRON_RUN_AS_NODE
  // T09/AC4：JOBHUNT_E2E_REAL=1 时不注入假 agent（真实 agent 冒烟入口，手动运行）
  const env = {
    ...process.env,
    ...(realAgent ? {} : { JOBHUNT_FAKE_AGENT: '1' }),
    JOBHUNT_E2E_SEED: '1',
    JOBHUNT_USER_DATA_DIR: userDataDir,
    ...(scenario === 'questions' || scenario === 'promotion' || scenario === 'full'
      ? { JOBHUNT_E2E_SCENARIO: scenario }
      : {})
  }
  delete env['ELECTRON_RUN_AS_NODE']
  const app = spawn(electronPath, [projectRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let appLog = ''
  app.stdout.on('data', (d) => (appLog += d))
  app.stderr.on('data', (d) => (appLog += d))
  app.on('error', (err) => console.log('应用启动错误：', err.message))
  let exited = false
  app.on('exit', (code, signal) => {
    exited = true
    console.log(`应用退出 code=${code} signal=${signal}`)
  })

  try {
    const port = await readDevToolsPort(userDataDir)
    console.log(`CDP 端口：${port}`)

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const contexts = browser.contexts()
    const page = contexts[0]?.pages()[0]
    if (page === undefined) throw new Error('CDP 未发现渲染页面')
    await page.waitForLoadState('domcontentloaded')


    if (realAgent) {
      await runRealSmoke(page, userDataDir)
    } else if (scenario === 'questions') {
      await runQuestionsFlow(page, userDataDir)
    } else if (scenario === 'promotion') {
      await runPromotionFlow(page, userDataDir)
    } else if (scenario === 'full') {
      await runFullFlow(page, userDataDir)
    } else {
      await runEmptyFlow(page, userDataDir)
    }

    await browser.close()
    console.log(`\nE2E 内容优化冒烟通过 ✓（场景：${scenario}）`)
  } finally {
    if (!exited) {
      app.kill()
    }
    if (appLog.trim() !== '') {
      console.log('--- 应用输出 ---')
      console.log(appLog.slice(0, 4000))
      console.log('--- 结束 ---')
    }
    await sleep(500)
    // 等待退出后清理（DB 文件可能仍被占用）
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // 清理失败不阻塞（Windows 句柄释放延迟）
    }
  }
}

main().catch((err) => {
  console.error('E2E 失败：', err)
  process.exit(1)
})
