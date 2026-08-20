// 全量验证 v2（真实 agent + 真实 UI 接缝）：对 userData 中所有基准简历，
// 逐条完成内容优化全流程：触发（或续接进行中任务）→ 追问表单作答（确认属实/自由输入/无法补充）
// → 生成优化稿 → 推断-待确认勾选（如有）→ 确认 → 断言 confirmed + 新基准入库。
// 用法：ELECTRON_RUN_AS_NODE=1 electron scripts/verify-all-base-resumes.mjs <cdpPort> <userDataDir>
import { chromium } from 'playwright-core'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const port = process.argv[2]
const userDataDir = process.argv[3]
if (!port || !userDataDir) {
  console.error('用法：verify-all-base-resumes.mjs <cdpPort> <userDataDir>')
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function dbState() {
  const db = new Database(join(userDataDir, 'jobhunt.db'))
  const resumes = db
    .prepare('SELECT id, json, base_resume_id FROM resumes ORDER BY created_at')
    .all()
    .map((r) => ({ id: r.id, title: JSON.parse(r.json).meta?.title ?? '(无标题)', isBase: r.base_resume_id === null }))
  const tasks = db
    .prepare(
      'SELECT id, resume_id, status, error, no_changes, created_resume_id, archived_at FROM content_optimize_tasks ORDER BY created_at'
    )
    .all()
  db.close()
  return { resumes, tasks }
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0].pages()[0]

  const { resumes, tasks } = dbState()
  const baseResumes = resumes.filter((r) => r.isBase)
  console.log(`\n===== 基准简历（${baseResumes.length} 条）=====`)
  for (const r of baseResumes) {
    const task = tasks.find((t) => t.resume_id === r.id)
    console.log(` - ${r.title} ${task ? `[任务: ${task.status}]` : '[无任务]'}`)
  }

  const summary = []
  for (const base of baseResumes) {
    const t0 = Date.now()
    console.log(`\n===== 优化：${base.title} =====`)
    try {
      await page.evaluate(() => { window.location.hash = '#/resumes' })
      await page.waitForTimeout(800)

      // 1) 定位该简历的任务卡片（标题含简历名）；无卡片则触发内容优化
      const hasCard = await page.evaluate((title) => {
        const card = [...document.querySelectorAll('.opt-task-card')].find((c) => c.textContent.includes(title))
        return card !== undefined
      }, base.title)
      if (!hasCard) {
        const triggered = await page.evaluate((title) => {
          const rows = [...document.querySelectorAll('.res-row')]
          const row = rows.find((r) => r.textContent.includes(title))
          if (!row) return false
          const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '内容优化')
          if (!btn) return false
          btn.scrollIntoView({ block: 'center' })
          btn.click()
          return true
        }, base.title)
        if (!triggered) throw new Error('无法触发内容优化')
        console.log('  已触发内容优化（新任务）')
        await sleep(1500)
      } else {
        console.log('  续接进行中任务（awaiting_answers）')
      }

      // 2) 主循环：驱动到终态（最长 15 分钟/条）
      const deadline = Date.now() + 15 * 60 * 1000
      let last = ''
      let confirmed = false
      let failed = null
      for (;;) {
        await page.evaluate(() => { window.location.hash = '#/resumes' })
        await page.waitForTimeout(500)
        // 状态以 DB 为准（UI 文本仅用于交互定位）
        const { tasks: ts } = dbState()
        const taskRow = ts.find((x) => x.resume_id === base.id)
        const st = { status: taskRow?.status ?? 'no-task' }

        if (st.status !== last) {
          console.log(`  状态：${st.status}${taskRow?.error ? `（${taskRow.error.slice(0, 80)}）` : ''}`)
          last = st.status
        }

        if (st.status === 'failed') {
          const retried = await page.evaluate((title) => {
            const card = [...document.querySelectorAll('.opt-task-card')].find((c) => c.textContent.includes(title))
            if (!card) return false
            const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('重试'))
            if (!btn) return false
            btn.scrollIntoView({ block: 'center' })
            btn.click()
            return true
          }, base.title)
          if (retried) {
            console.log('  任务失败 → 点击「重试」续跑')
            await sleep(2000)
          } else {
            failed = taskRow?.error ?? 'failed'
            break
          }
        } else if (st.status === 'awaiting_answers') {
          const answered = await page.evaluate((title) => {
            const card = [...document.querySelectorAll('.opt-task-card')].find((c) => c.textContent.includes(title))
            if (!card) return { done: false, reason: 'no-card' }
            const questions = [...card.querySelectorAll('.opt-ans-question')]
            if (questions.length === 0) return { done: false, reason: 'no-questions' }
            let answeredCount = 0
            questions.forEach((q, i) => {
              // 已答判定：该题「确认属实/编辑后确认/不属实/无法补充」任一按钮处于激活态（class 含 active/on/selected 或 disabled）
              const btns = [...q.querySelectorAll('button')].filter((b) => /确认属实|编辑后确认|不属实|无法补充/.test(b.textContent ?? ''))
              const answeredAlready = btns.some((b) => /active|on|selected/.test(b.className) || b.disabled)
              if (answeredAlready) {
                answeredCount++
                return
              }
              const textarea = q.querySelector('textarea')
              const first = btns.find((b) => (b.textContent ?? '').includes('确认属实'))
              const last = btns[btns.length - 1]
              if (i === 0 && textarea) {
                // 第 1 题：自由输入（模拟用户补充真实事实）
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                setter.call(textarea, '曾做过一次 3 人小团队的完整迭代，负责核心模块并完成上线。')
                textarea.dispatchEvent(new Event('input', { bubbles: true }))
              } else if (i === questions.length - 1 && last) {
                // 最后一题：无法补充
                last.click()
              } else if (first) {
                // 其余：确认属实（候选 0）
                first.click()
              }
              answeredCount++
            })
            return { done: true, answeredCount, total: questions.length }
          }, base.title)
          if (answered.done && answered.answeredCount > 0) {
            console.log(`  表单作答：${answered.answeredCount}/${answered.total} 题已处理`)
          }
          // 点「生成优化稿」
          const submitted = await page.evaluate((title) => {
            const card = [...document.querySelectorAll('.opt-task-card')].find((c) => c.textContent.includes(title))
            if (!card) return false
            const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('生成优化稿'))
            if (!btn) return false
            btn.scrollIntoView({ block: 'center' })
            btn.click()
            return true
          }, base.title)
          if (submitted) console.log('  点击「生成优化稿」→ 提交回答')
          await sleep(2000)
        } else if (st.status === 'ready_for_review') {
          // 勾选推断-待确认（如有）→ 确认
          const acted = await page.evaluate((title) => {
            const card = [...document.querySelectorAll('.opt-task-card')].find((c) => c.textContent.includes(title))
            if (!card) return { confirmed: false, reason: 'no-card' }
            const cbs = [...card.querySelectorAll('input[type=checkbox]')]
            for (const cb of cbs) {
              if (!cb.checked) {
                cb.click()
              }
            }
            const btn = [...card.querySelectorAll('button')].find((b) => {
              const t = (b.textContent ?? '').trim()
              return t === '确认' || t.startsWith('确认（')
            })
            if (!btn) return { confirmed: false, reason: 'no-confirm-btn' }
            btn.scrollIntoView({ block: 'center' })
            btn.click()
            return { confirmed: true, checkboxes: cbs.length }
          }, base.title)
          if (acted.confirmed) console.log(`  点击确认${acted.checkboxes > 0 ? `（勾选 ${acted.checkboxes} 个推断-待确认）` : ''}`)
          else console.log('  确认按钮状态：', acted.reason)
          await sleep(2000)
        } else if (st.status === 'confirmed') {
          confirmed = true
          break
        } else if (st.status === 'failed') {
          failed = st.text.slice(0, 160)
          break
        } else if (st.status === 'no-card') {
          // 任务卡片消失（异常）——查 DB 兜底
          const { tasks: ts } = dbState()
          const t = ts.find((x) => x.resume_id === base.id)
          if (t && ['confirmed', 'failed', 'cancelled'].includes(t.status)) {
            if (t.status === 'confirmed') confirmed = true
            else failed = t.error ?? t.status
            break
          }
        }
        if (Date.now() > deadline) {
          failed = '等待终态超时（15 分钟）'
          break
        }
        await sleep(3000)
      }

      const after = dbState()
      const task = after.tasks.find((t) => t.resume_id === base.id)
      const created = after.resumes.find((r) => r.id === task?.created_resume_id)
      const secs = Math.round((Date.now() - t0) / 1000)
      const ok = confirmed
      summary.push({ title: base.title, ok, status: task?.status ?? 'n/a', secs, createdResume: created?.title ?? null, failed })
      console.log(`  结果：${ok ? '✓ 已确认' : '✗ 未完成'} 耗时=${secs}s 新基准=${created?.title ?? '（无）'}${failed ? ` 失败=${failed}` : ''}`)
    } catch (err) {
      summary.push({ title: base.title, ok: false, status: 'ERROR', secs: Math.round((Date.now() - t0) / 1000), createdResume: null, failed: String(err?.message ?? err) })
      console.log(`  异常：${err?.message ?? err}`)
    }
  }

  const final = dbState()
  console.log('\n===== 全量结果 =====')
  let allOk = true
  for (const s of summary) {
    if (!s.ok) allOk = false
    console.log(` ${s.ok ? '✓' : '✗'} ${s.title} → ${s.status}（${s.secs}s）${s.createdResume ? `新基准=${s.createdResume}` : ''}${s.failed ? ` 失败=${s.failed}` : ''}`)
  }
  console.log(`\n落库总览：基准简历 ${final.resumes.filter((r) => r.isBase).length} 条，任务 ${final.tasks.length} 条`)
  for (const t of final.tasks) {
    console.log(`  任务 ${t.resume_id.slice(0, 8)} → ${t.status}${t.created_resume_id ? ` 新基准=${t.created_resume_id.slice(0, 8)}` : ''}${t.error ? ` err=${t.error.slice(0, 60)}` : ''}`)
  }
  console.log(`\n结论：${allOk ? '全部基准简历完成优化 ✓' : '存在未完成项 ✗'}`)
  await browser.close()
  process.exit(allOk ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
