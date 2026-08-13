import type { BrowserWindow } from 'electron'
import type { BossPageExtractResult, HireType } from '../../shared/types'
import { parseSalary } from './parsers/boss'

/**
 * BOSS 详情页人工浏览提取（issue #62）：零自动化、零额外请求、零页面注入。
 *
 * 用户在应用内置 BOSS 窗口正常浏览岗位详情页，按 F8（boss-login.ts 的
 * before-input-event 钩子）→ 主进程执行 COLLECT_SCRIPT **只读**收集页面文本
 * （document.title / body.innerText / 首个 h1 / 当前 URL），识别逻辑全部在
 * 主进程纯函数 toBossPageDraft 中（可单测；spec Testing Decisions：真实
 * BrowserWindow 部分仅手动冒烟）。
 *
 * 与 #56 自动抓取（隐藏窗口 + 页面内补发 fetch）的区别：不发任何网络请求，
 * 风控无新增信号。
 */

/** 只读采集脚本返回的原始信号（脚本保持哑：只收集，不识别）。 */
export interface BossPageRaw {
  /** document.title（BOSS 详情页形如 `{岗位}招聘-{公司}-BOSS直聘`）。 */
  title: string
  /** body innerText（截断 20k 字符）。 */
  bodyText: string
  /** 首个 h1 文本（部分页面岗位名在 h1）。 */
  h1: string
  /** 当前页面 URL（渠道溯源）。 */
  url: string
}

/** 只读采集脚本：仅读 DOM/位置，无网络请求、无 DOM 修改。 */
export const COLLECT_SCRIPT = `(() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim()
  return {
    title: document.title ?? '',
    h1: norm(document.querySelector('h1')?.textContent),
    bodyText: (document.body?.innerText ?? '').slice(0, 20000),
    url: location.href
  }
})()`

/** JD 节起始标题（BOSS 详情页渲染形态）。 */
const JD_HEADING = /职位描述|工作职责|岗位职责|职位详情/

/** JD 节结束：后续顶层小节标题（"任职要求"等职责内分节不在此列）。 */
const JD_END_SECTIONS = /公司介绍|公司信息|工作地址|面试评价|职位发布者|公司福利|福利待遇|公司相册|相似职位|相关职位|BOSS直聘/

/**
 * 原始页面信号 → 职位卡草稿（纯函数）。
 * 非详情页（识别不到 JD 节）→ { draft: null, error }。
 */
export function toBossPageDraft(raw: BossPageRaw): BossPageExtractResult {
  const jd = extractJd(raw.bodyText)
  if (jd === null) {
    return {
      draft: null,
      error: '未识别到职位描述——请确认当前是 BOSS 岗位详情页（点开某个岗位卡片后再按 F8）'
    }
  }
  const salaryText = extractSalaryText(raw.bodyText)
  const salary = parseSalary(salaryText)
  const { company, title } = parseTitleCompany(raw.title, raw.h1)
  return {
    draft: {
      company,
      title,
      jd,
      city: extractCity(raw.bodyText),
      channel: 'BOSS直聘',
      channel_url: raw.url.trim(),
      hire_type: guessHireType(title, jd),
      salary_min: salary.min,
      salary_max: salary.max,
      salary_text: salary.text ?? undefined
    }
  }
}

/** 从 BOSS 窗口执行只读采集（主进程侧；抛错交调用方兜底为提取失败事件）。 */
export async function collectBossPage(win: BrowserWindow): Promise<BossPageRaw> {
  return (await win.webContents.executeJavaScript(COLLECT_SCRIPT)) as BossPageRaw
}

/**
 * body 文本 → JD 节（起始标题到下一个顶层小节标题之间；无起始标题 → null）。
 * 剥起始标题行、保留行结构（innerText 换行），逐行去空白/去空行。
 */
function extractJd(body: string): string | null {
  const start = body.search(JD_HEADING)
  if (start === -1) return null
  const after = body.slice(start)
  const end = after.search(JD_END_SECTIONS)
  const section = end === -1 ? after : after.slice(0, end)
  const content = section
    .replace(JD_HEADING, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
  return content === '' ? null : content
}

/** 头部 3000 字符内找薪资串（K 区间 / K 以上；面议等形态由 parseSalary 兜底）。 */
function extractSalaryText(body: string): string {
  const head = body.slice(0, 3000)
  const range = head.match(/\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*K(?:·\d+薪)?/i)
  if (range !== null) return range[0]
  const minOnly = head.match(/\d+(?:\.\d+)?\s*K\s*以上/i)
  if (minOnly !== null) return minOnly[0]
  const negotiable = head.match(/薪资面议/)
  return negotiable !== null ? '薪资面议' : ''
}

/** document.title → 公司/岗位（`{岗位}招聘-{公司}-BOSS直聘`；「」包裹与招聘后缀剥离）。 */
function parseTitleCompany(documentTitle: string, h1: string): { company: string; title: string } {
  const cleanTitle = (s: string): string =>
    s.replace(/[「」]/g, '').replace(/\s*招聘\s*$/, '').trim()
  let t = documentTitle.trim().replace(/[-_]\s*BOSS直聘\s*$/i, '')
  let company = ''
  const sep = t.lastIndexOf('-')
  if (sep > 0) {
    company = t.slice(sep + 1).trim()
    t = t.slice(0, sep)
  }
  let title = cleanTitle(t)
  if (title === '') title = cleanTitle(h1)
  return { company, title }
}

/** body 文本 → 城市（`上海·浦东新区` 形态优先；兜底常见城市名单）。 */
function extractCity(body: string): string | undefined {
  const district = body.match(/([\u4e00-\u9fa5]{2,8})·([\u4e00-\u9fa5]{2,8})/)
  if (district !== null) return district[1]
  const known = body.match(
    /(北京|上海|广州|深圳|杭州|南京|成都|武汉|西安|苏州|天津|重庆|长沙|郑州|青岛|大连|厦门|合肥|济南|福州|无锡|宁波|东莞|佛山)/
  )
  return known?.[1]
}

/** 招聘类型猜测（表单可改）：标题含实习 → 实习；含校招/应届/届 → 校招；否则社招。 */
function guessHireType(title: string, jd: string): HireType {
  if (/实习/.test(title)) return '实习'
  if (/(校招|应届|20\d{2}\s*届)/.test(`${title}\n${jd}`)) return '校招'
  return '社招'
}
