#!/usr/bin/env node
/**
 * Moonshot Kimi 2.6 多模态识图对比基准（#80）——独立命令，不接入正式应用。
 *
 * 对比三条路径（固定提示 + 相同合成/匿名化夹具）：
 *   A. 纯 Windows OCR（win-ocr.ps1 真实调用）
 *   B. Kimi 2.6 直接识别页面图像
 *   C. Windows OCR 文本 + 页面图像 → Kimi 2.6 复核
 *
 * 认证：仅使用「本机独立 Pi」的全局 Moonshot 凭据（独立 pi 目录下 agent/auth.json），
 * 不读项目 userData/pi auth、不写任何 API Key 到仓库；独立认证不可用时
 * 明确停止并记录 blocker（不改用项目认证）。
 *
 * 用法：
 *   node scripts/ocr-benchmark-kimi.mjs --pi-home <独立 pi 目录> [--model <API模型名>] [--samples page1.png page2.png page3.png]
 * 环境变量：PI_INDEPENDENT_HOME（--pi-home 缺省时读取）
 *
 * 独立 Pi 目录要求：<dir>/agent/auth.json（pi 凭据格式，如
 * {"moonshotai-cn": {"type":"api_key","key":"sk-…"}}）且可用模型 moonshotai-cn/kimi-k2.6。
 * 报告追加到 .checkpoint/ocr-benchmark-kimi.md（gitignore；不含认证信息与私人材料）。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = join(root, 'src/main/services/fixtures/ocr')
const ps1Path = join(root, 'resources/win-ocr.ps1')
const reportPath = join(root, '.checkpoint/ocr-benchmark-kimi.md')

// ---------- 参数 ----------
const args = process.argv.slice(2)
function argValue(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const piHome = resolve(argValue('--pi-home') ?? process.env.PI_INDEPENDENT_HOME ?? '')
const samples = args.includes('--samples') ? args.slice(args.indexOf('--samples') + 1).filter((a) => !a.startsWith('--')) : ['page1.png', 'page2.png', 'page3.png']
/** Moonshot 模型（独立 Pi 的 moonshotai-cn/kimi-k2.6 对应的 API 模型名；可覆盖）。 */
const apiModel = argValue('--model') ?? 'kimi-k2.6'
const apiBase = argValue('--api-base') ?? 'https://api.moonshot.cn/v1'

// 固定提示（三路径共用同一结构化要求）
const STRUCTURE_PROMPT = '请提取这份简历页面的全部信息，按如下 JSON 输出：{"name":"姓名","phone":"电话","email":"邮箱","education":[{"school":"学校","degree":"学历","major":"专业"}],"skills":["技能"],"other":["其余可读内容，按阅读顺序"]}。只输出原文事实，不要补写或猜测。'

/** 关键字段期望（与 ocr-smoke 同一套夹具内容）。 */
const KEY_FIELDS = {
  'page1.png': ['张伟', '138-0000-1234'],
  'page2.png': ['北京理工大学', '计算机科学与技术'],
  'page3.png': ['校园二手交易平台', 'Java']
}

// ---------- 路径 A：Windows OCR ----------
function ocrWindows(imagePath) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-ImagePath', imagePath],
      { timeout: 120_000, encoding: 'utf8' },
      (err, stdout) => {
        const text = (stdout ?? '').trim()
        resolve({ ok: err === null && text !== '' && !text.includes('ENGINE_FAIL'), ms: performance.now() - t0, text, engineFail: text.includes('ENGINE_FAIL') })
      }
    )
  })
}

// ---------- 路径 B/C：Kimi 2.6 多模态 ----------
function kimiRecognize(apiKey, imagePath, ocrText) {
  const content = [
    { type: 'text', text: STRUCTURE_PROMPT },
    ...(ocrText ? [{ type: 'text', text: `补充：Windows OCR 提取文本如下（可能有误）：\n${ocrText}` }] : [])
  ]
  if (existsSync(imagePath)) {
    const b64 = readFileSync(imagePath).toString('base64')
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })
  }
  const t0 = performance.now()
  return fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: apiModel, messages: [{ role: 'user', content }], temperature: 0 })
  }).then(async (res) => {
    const body = await res.json()
    if (!res.ok) throw new Error(`Kimi API ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    return {
      ok: true,
      ms: performance.now() - t0,
      text: body.choices?.[0]?.message?.content ?? '',
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0
    }
  }).catch((err) => ({ ok: false, ms: performance.now() - t0, text: '', error: String(err), promptTokens: 0, completionTokens: 0 }))
}

// ---------- 指标 ----------
function fieldHits(label, text) {
  const expected = KEY_FIELDS[label] ?? []
  return { hit: expected.filter((k) => text.includes(k)).length, total: expected.length }
}

async function main() {
  const report = [
    `# OCR vs Kimi 2.6 多模态对比基准（#80）`,
    `- 时间：${new Date().toISOString()}`,
    `- 请求模型：${apiModel}（独立 Pi moonshotai-cn/kimi-k2.6）`,
    `- 夹具：${samples.join(', ')}（合成/匿名化，无私人简历）`,
    ``
  ]
  mkdirSync(dirname(reportPath), { recursive: true })

  // 认证检查：独立 Pi 的 agent/auth.json（缺省 → blocker，不改用项目认证）
  const authPath = join(piHome, 'agent', 'auth.json')
  if (piHome === '' || !existsSync(authPath)) {
    const blocker = [
      `## Blocker`,
      `未找到独立 Pi 认证：${authPath}（--pi-home / PI_INDEPENDENT_HOME 未设置或文件不存在）。`,
      `按要求不使用项目认证；请准备独立 Pi（moonshotai-cn/kimi-k2.6 可用）后重跑：`,
      `node scripts/ocr-benchmark-kimi.mjs --pi-home <独立 pi 目录>`,
      ``,
      `（本报告为占位证据：三路径对比未运行，原因 = 独立认证缺失。）`
    ].join('\n')
    appendFileSync(reportPath, `\n\n${report.join('\n')}\n${blocker}\n`)
    console.log(report.join('\n'))
    console.log(blocker)
    process.exit(1)
  }

  let auth
  try {
    auth = JSON.parse(readFileSync(authPath, 'utf8'))
  } catch (err) {
    appendFileSync(reportPath, `\n\n${report.join('\n')}\n## Blocker\n独立 auth.json 无法解析：${err.message}\n`)
    console.error('独立 auth.json 无法解析：', err.message)
    process.exit(1)
  }
  const apiKey = auth['moonshotai-cn']?.key ?? auth.moonshotai_cn?.key ?? auth.moonshot?.key
  if (!apiKey) {
    appendFileSync(reportPath, `\n\n${report.join('\n')}\n## Blocker\n独立 auth.json 中无 moonshot 凭据（keys: ${Object.keys(auth).join(', ')}）。\n`)
    console.error('独立 auth.json 中无 moonshot 凭据')
    process.exit(1)
  }

  // 逐样本三路径
  for (const label of samples) {
    const imagePath = join(fixtureDir, label)
    if (!existsSync(imagePath)) continue
    const a = await ocrWindows(imagePath)
    const b = a.engineFail
      ? { ok: false, ms: 0, text: '', error: 'Windows OCR 引擎不可用（缺语言包）' }
      : await kimiRecognize(apiKey, imagePath, undefined)
    const c = a.engineFail
      ? { ok: false, ms: 0, text: '', error: 'Windows OCR 引擎不可用（缺语言包）' }
      : await kimiRecognize(apiKey, imagePath, a.text)

    report.push(
      `## ${label}`,
      `- A 纯 OCR：${a.ok ? `${a.ms.toFixed(0)}ms` : `FAIL（${a.engineFail ? 'ENGINE_FAIL' : '未知'}）`}`,
      `- B Kimi 识图：${b.ok ? `${b.ms.toFixed(0)}ms tokens=${b.promptTokens}+${b.completionTokens}` : `FAIL（${b.error ?? ''}）`}`,
      `- C OCR+识图复核：${c.ok ? `${c.ms.toFixed(0)}ms tokens=${c.promptTokens}+${c.completionTokens}` : `FAIL（${c.error ?? ''}）`}`,
      `- 关键字段命中：A ${fieldHits(label, a.text).hit}/${fieldHits(label, a.text).total}；B ${fieldHits(label, b.text).hit}/${fieldHits(label, b.text).total}；C ${fieldHits(label, c.text).hit}/${fieldHits(label, c.text).total}`,
      `- B 输出：${b.text.slice(0, 300)}`,
      `- C 输出：${c.text.slice(0, 300)}`,
      ``
    )
  }
  report.push(
    '## 说明',
    '- 阅读顺序与正文漏失由 B/C 输出的 other 数组顺序与原文核对（人工/脚本二次确认）。',
    '- 成本 = usage tokens × 模型单价（Moonshot 定价）；本报告不含认证信息与私人材料。'
  )
  appendFileSync(reportPath, `\n\n${report.join('\n')}\n`)
  console.log(report.join('\n'))
  console.log(`\n报告已追加：${reportPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
