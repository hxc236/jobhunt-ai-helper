// E2E 内容优化冒烟（#90/T02）：真实启动应用（假 agent）+ 鼠标/键盘驱动 + 截图/无障碍快照断言 + 落库断言。
//
// 运行方式（Electron-as-Node，better-sqlite3 为 Electron ABI）：
//   ELECTRON_RUN_AS_NODE=1 electron scripts/e2e-content-optimize.mjs
// 或 npm script：npm run e2e:content-optimize
//
// 前置：先 `npm run build`（electron-vite 产物 out/）。
//
// 流程：
//  1) 创建临时 userData 目录；
//  2) 以 JOBHUNT_FAKE_AGENT=1 + JOBHUNT_E2E_SEED=1 + JOBHUNT_USER_DATA_DIR=临时目录 真实启动应用；
//  3) 读取 userData/DevToolsActivePort → playwright-core connectOverCDP；
//  4) 驱动 UI：切到「简历」→ 点击基准简历行的「内容优化」→ 等待任务卡片显示「无需修改」→ 点确认；
//  5) 断言：截图 + 无障碍快照 + 落库（content_optimize_tasks 状态 confirmed；resumes 数不变）；
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

/** 断言落库状态：任务 confirmed + 空诊断不创建新版本。 */
function assertDatabase(userDataDir, taskId) {
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

async function main() {
  // 前置：build 产物必须存在（真实启动用 out/）
  if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    console.log('未发现 out/ 构建产物，先执行 npm run build …')
    const build = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'jh-e2e-content-optimize-'))
  console.log(`临时 userData：${userDataDir}`)

  // 真实启动应用（假 agent + E2E 种子）——子进程必须是真应用，不能继承 ELECTRON_RUN_AS_NODE
  const env = { ...process.env, JOBHUNT_FAKE_AGENT: '1', JOBHUNT_E2E_SEED: '1', JOBHUNT_USER_DATA_DIR: userDataDir }
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

    // 切到「简历」视图（侧边栏点击，模拟鼠标）
    await page.locator('.nav-item', { hasText: '简历' }).first().click()
    await page.waitForSelector('.view.cols', { timeout: 10_000 })

    // 等待 E2E 种子基准简历行出现
    await page.waitForSelector('.res-row', { timeout: 10_000 })

    // 点击基准简历行的「内容优化」按钮（模拟鼠标）
    const row = page.locator('.res-row').first()
    await row.locator('button', { hasText: '内容优化' }).first().click()

    // 等待任务卡片出现并流转到「无需修改 / 可确认」（假 agent 即时返回空诊断）
    await page.waitForSelector('.opt-task-card', { timeout: 10_000 })
    await page.waitForFunction(() => {
      const card = document.querySelector('.opt-task-card')
      return card !== null && card.textContent.includes('无需修改')
    }, undefined, { timeout: 15_000 })
    const taskCard = await page.locator('.opt-task-card').first().innerText()
    console.log('  任务卡片：')
    console.log('  ' + taskCard.split('\n').join('\n  '))

    // 点击确认 —— 改用键盘驱动：聚焦确认按钮 + Enter（验证键盘模拟通道，等价于 OS 级按键）
    const confirmBtn = page.locator('.opt-task-card button', { hasText: '确认' }).first()
    await confirmBtn.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => {
      const card = document.querySelector('.opt-task-card')
      return card !== null && card.textContent.includes('已确认')
    }, undefined, { timeout: 10_000 })
    console.log('  确认后任务卡片状态 = 已确认（键盘 Enter 驱动）✓')

    // 截图 + 无障碍快照断言（ariaSnapshot：role/name 结构断言，等价于无障碍树）
    const shotPath = join(userDataDir, 'task-card-confirmed.png')
    await page.screenshot({ path: shotPath, fullPage: false })
    console.log(`  截图：${shotPath}`)
    const a11y = await page.locator('.opt-task-card').ariaSnapshot()
    if (!a11y.includes('已确认')) {
      throw new Error(`无障碍快照未包含任务状态文本：${a11y.slice(0, 200)}`)
    }
    console.log('  无障碍快照断言 ✓')

    // 任务 id：从页面数据不易取，改从 DB 反查（唯一一条内容优化任务）
    const db = new Database(join(userDataDir, 'jobhunt.db'), { readonly: true })
    const taskRow = db.prepare('SELECT id FROM content_optimize_tasks LIMIT 1').get()
    db.close()
    if (taskRow === undefined) throw new Error('未发现内容优化任务落库')
    assertDatabase(userDataDir, taskRow.id)

    await browser.close()
    console.log('\nE2E 内容优化冒烟通过 ✓')
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
