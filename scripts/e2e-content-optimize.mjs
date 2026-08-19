// E2E 内容优化冒烟（#90/T02，T04 追问场景）：真实启动应用（假 agent）+ 鼠标/键盘驱动 + 截图/无障碍快照断言 + 落库断言。
//
// 运行方式（Electron-as-Node，better-sqlite3 为 Electron ABI）：
//   ELECTRON_RUN_AS_NODE=1 electron scripts/e2e-content-optimize.mjs
// 或 npm script：npm run e2e:content-optimize
//
// 场景（JOBHUNT_E2E_SCENARIO）：
//   empty（默认）     —— 空诊断垂直切片：触发 → 无需修改 → 确认不建版本；
//   questions（T04）  —— 追问流程：触发 → 等待回答（批量问答表单：分组/证据/四选一/自由输入）
//                        → 生成优化稿 → 可确认 → 确认创建新基准简历。
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

/** 断言落库状态（empty 场景）：任务 confirmed + 空诊断不创建新版本。 */
function assertEmptyDatabase(userDataDir, taskId) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    const task = db
      .prepare('SELECT status, no_changes, progress FROM content_optimize_tasks WHERE id = ?')
      .get(taskId)
    if (task === undefined) throw new Error(`任务 ${taskId} 未落库`)
    if (task.status !== 'confirmed') throw new Error(`任务状态应为 confirmed，实际 ${task.status}`)
    if (task.no_changes !== 1) throw new Error('空诊断路径 no_changes 应为 1')
    if (task.progress !== '已确认') throw new Error(`进度文案异常：${task.progress}`)
    const resumeCount = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n
    if (resumeCount !== 1) {
      throw new Error(`空诊断不应创建新版本：resumes 应为 1，实际 ${resumeCount}`)
    }
    console.log(`  [db] task=${task.status} no_changes=${task.no_changes} resumes=${resumeCount} ✓`)
  } finally {
    db.close()
  }
}

/** 断言落库状态（questions 场景）：任务 confirmed + answers 持久化 + 新基准简历创建。 */
function assertQuestionsDatabase(userDataDir, taskId) {
  const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
  try {
    const task = db
      .prepare('SELECT status, no_changes, answers_json, summary_json FROM content_optimize_tasks WHERE id = ?')
      .get(taskId)
    if (task === undefined) throw new Error(`任务 ${taskId} 未落库`)
    if (task.status !== 'confirmed') throw new Error(`任务状态应为 confirmed，实际 ${task.status}`)
    if (task.no_changes !== 0) throw new Error('追问场景有改写，no_changes 应为 0')
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
    console.log(`  [db] task=${task.status} no_changes=${task.no_changes} resumes=${resumeCount} answers=${JSON.stringify(answers)} ✓`)
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

async function main() {
  const scenario = process.env['JOBHUNT_E2E_SCENARIO'] ?? 'empty'

  // 前置：build 产物必须存在（真实启动用 out/）
  if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    console.log('未发现 out/ 构建产物，先执行 npm run build …')
    const build = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'jh-e2e-content-optimize-'))
  console.log(`临时 userData：${userDataDir}（场景：${scenario}）`)

  // 真实启动应用（假 agent + E2E 种子）——子进程必须是真应用，不能继承 ELECTRON_RUN_AS_NODE
  const env = {
    ...process.env,
    JOBHUNT_FAKE_AGENT: '1',
    JOBHUNT_E2E_SEED: '1',
    JOBHUNT_USER_DATA_DIR: userDataDir,
    ...(scenario === 'questions' ? { JOBHUNT_E2E_SCENARIO: 'questions' } : {})
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

    if (scenario === 'questions') {
      await runQuestionsFlow(page, userDataDir)
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
