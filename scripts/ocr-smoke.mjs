#!/usr/bin/env node
/**
 * Windows OCR 冒烟/性能基准（#79）——独立命令，不混入跨平台单元测试。
 *
 * 作用：
 * - 真实调用系统中文 OCR（resources/win-ocr.ps1）识别合成夹具
 *   （src/main/services/fixtures/ocr/，均为匿名化合成材料，无私人简历）；
 * - 记录每页耗时、三页总耗时与识别结果；检查关键字段（姓名/电话/邮箱/教育）命中；
 * - 系统缺 zh-Hans-CN 语言包时明确报 blocker（本机实测：ENGINE_FAIL），不假装成功。
 *
 * 用法：node scripts/ocr-smoke.mjs            # 全部夹具
 *      node scripts/ocr-smoke.mjs page1.png page2.png page3.png   # 指定（三页基准）
 *
 * 运行环境：Windows + PowerShell + 中文语言包（设置 → 时间和语言 → 语言 → 中文(简体) → 语言选项 → OCR）。
 * 结果追加写入 .checkpoint/ocr-smoke-report.md（gitignore，隐私/噪音不入库）。
 */
import { execFile } from 'node:child_process'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = join(root, 'src/main/services/fixtures/ocr')
const ps1Path = [join(root, 'resources/win-ocr.ps1'), join(root, 'out/main/../../resources/win-ocr.ps1')].find((p) => existsSync(p))
if (ps1Path === undefined) throw new Error('找不到 resources/win-ocr.ps1')

const samples = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['text-zh.png', 'scan-low-quality.png', 'two-column.png', 'error-chars.png', 'page1.png', 'page2.png', 'page3.png']

/** 关键字段期望（夹具合成内容；命中 = 关键字段正确性）。 */
const KEY_FIELDS = {
  'text-zh.png': ['张伟', '138-0000-1234', 'zhangwei@example.com', '北京理工大学'],
  'scan-low-quality.png': ['王芳', '中山大学'],
  'two-column.png': ['李娜'],
  'error-chars.png': ['1O8-0O00-1234'],
  'page1.png': ['张伟', '138-0000-1234'],
  'page2.png': ['北京理工大学'],
  'page3.png': ['校园二手交易平台']
}

function ocrOne(imagePath) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-ImagePath', imagePath],
      { timeout: 120_000, encoding: 'utf8' },
      (err, stdout) => {
        const ms = performance.now() - t0
        const text = (stdout ?? '').trim()
        resolve({ ms, ok: err === null && text !== '' && !text.includes('ENGINE_FAIL'), text, engineFail: text.includes('ENGINE_FAIL') })
      }
    )
  })
}

async function main() {
  const report = [`# OCR 冒烟/性能报告（#79）`, `- 时间：${new Date().toISOString()}`, `- 系统：${process.platform} / ${process.arch}`, ``]
  const pageTimes = []
  const lines = []
  let engineBlocker = false

  for (const name of samples) {
    const path = join(fixtureDir, name)
    if (!existsSync(path)) {
      console.error(`跳过（不存在）：${name}`)
      continue
    }
    const r = await ocrOne(path)
    pageTimes.push(r.ms)
    const expected = KEY_FIELDS[name] ?? []
    const hits = expected.filter((k) => r.text.includes(k))
    const miss = expected.filter((k) => !r.text.includes(k))
    lines.push(`- ${name}: ${r.ms.toFixed(0)}ms ${r.ok ? 'OK' : r.engineFail ? 'ENGINE_FAIL' : 'FAIL'} 关键字段 ${hits.length}/${expected.length}${miss.length > 0 ? ` 漏：${miss.join('、')}` : ''}`)
    if (r.engineFail) engineBlocker = true
    console.log(lines[lines.length - 1])
    if (r.text !== '' && !r.engineFail) console.log(`   识别结果：${r.text.slice(0, 200).replace(/\n/g, ' | ')}`)
  }

  const pageMs = pageTimes.map((t) => t)
  pageMs.sort((a, b) => a - b)
  const p95 = pageMs.length > 0 ? pageMs[Math.floor(pageMs.length * 0.95)] ?? pageMs[pageMs.length - 1] : 0
  const p50 = pageMs.length > 0 ? pageMs[Math.floor(pageMs.length * 0.5)] : 0
  const threePage = ['page1.png', 'page2.png', 'page3.png'].every((n) => samples.includes(n))
  const threeTotal = threePage ? ['page1.png', 'page2.png', 'page3.png'].reduce((acc, n) => acc + (pageTimes[samples.indexOf(n)] ?? 0), 0) : null

  report.push(`## 耗时`, `- 单页 P50：${p50.toFixed(0)}ms；P95：${p95.toFixed(0)}ms（目标：OCR 每页 P95 ≤ 3000ms）`, `- 三页总耗时：${threeTotal === null ? '未运行三页集' : `${threeTotal.toFixed(0)}ms`}（目标：三页扫描简历 ≤ 10000ms）`, ``)
  report.push(`## 结果`, ...lines, ``)
  if (engineBlocker) {
    report.push(
      `## Blocker`,
      `系统缺少 zh-Hans-CN OCR 语言包（win-ocr.ps1 TryCreateFromLanguage 返回 null → ENGINE_FAIL）。`,
      `安装路径：设置 → 时间和语言 → 语言 → 中文(简体) → 语言选项 → OCR。安装后重跑本脚本记录真实数据。`,
      ``,
      `（本报告为占位证据：未达到性能目标的原因 = 语言包缺失，非 OCR 本身超时。）`
    )
  }
  const out = join(root, '.checkpoint/ocr-smoke-report.md')
  mkdirSync(dirname(out), { recursive: true })
  appendFileSync(out, `\n\n${report.join('\n')}\n`)
  console.log(`\n报告已追加：${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
