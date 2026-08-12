import { COMPANY_TYPES, type CompanyType } from '../../shared/types'
import {
  type AgentService,
  type AgentSessionOptions,
  type AgentStatus,
  type AgentTaskType
} from './agent'

/**
 * 企业性质 AI 推断（issue #54；spec 决策：真联网搜索 + 公司名缓存 + 兜底"其他"）。
 *
 * 编排（不扩 agent 工具面——应用 agent 层 noExtensions，见 pi-agent-provider.ts）：
 * 1. 缓存命中（同公司只查一次）→ 直接返回；
 * 2. agent 未配置 → '其他'（分层降级，不创建会话不搜索）；
 * 3. 联网搜索（CompanySearchProvider：真实实现 = 现有 BrowserWindow 抓 Bing 搜索页，
 *    调研建议"倾向复用现有 BrowserWindow 抓搜索结果页"）→ 摘要注入提示词；
 *    搜索失败降级为模型知识（不阻塞）；
 * 4. 模型回答解析为企业性质枚举；不可解析/模型错误 → 兜底'其他'。
 */

/** 联网搜索提供者：公司名 → 文本摘要行（空数组 = 无结果；抛错 = 搜索不可用）。 */
export interface CompanySearchProvider {
  search(company: string): Promise<string[]>
}

/** 抓取器形状（BrowserWindowFetcher 满足；测试可注入 stub）。 */
interface FetchLike {
  fetch(url: string): Promise<string>
}

/** 真实搜索实现：Bing 搜索页（SSR，无需 JS 渲染）+ 纯函数摘要提取。 */
export class BrowserWindowSearchProvider implements CompanySearchProvider {
  constructor(private readonly fetcher: FetchLike) {}

  async search(company: string): Promise<string[]> {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(`${company} 企业性质 央企 国企 大厂`)}`
    const html = await this.fetcher.fetch(url)
    return extractSearchSnippets(html)
  }
}

/**
 * 搜索页 HTML → 文本摘要行（纯函数，fixture 可测）：
 * 剥离 script/style/标签/实体，按行过滤噪声（太短/纯空白/导航词）。
 */
export function extractSearchSnippets(html: string): string[] {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(withoutBlocks).replace(/\s+/g, ' ').trim()
  if (text === '') return []
  const lines = text
    .split(/[。；\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12) // 噪声行过滤（导航/短标签）
  return lines.slice(0, 8)
}

/** HTML 实体解码（常用子集）。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export interface CompanyTypeServiceOptions {
  /** 联网搜索提供者（缺省 = 无搜索，仅模型知识）。 */
  search?: CompanySearchProvider
}

/**
 * 企业性质推断服务：缓存 + 搜索 + 模型解析 + 兜底。
 * agent 依赖按窄接口注入（AgentService 满足），fake 可测（先例 agent.test.ts）。
 */
export class CompanyTypeService {
  private readonly cache = new Map<string, CompanyType>()

  constructor(
    private readonly agent: {
      createSession(task: AgentTaskType, options?: AgentSessionOptions): ReturnType<AgentService['createSession']>
      getStatus(): AgentStatus
    },
    private readonly options: CompanyTypeServiceOptions = {}
  ) {}

  /** 推断企业性质（永远不抛：任何失败路径都收敛到'其他'）。 */
  async infer(company: string): Promise<CompanyType> {
    const name = company.trim()
    if (name === '') return '其他'

    const cached = this.cache.get(name)
    if (cached !== undefined) return cached

    const status = this.agent.getStatus()
    if (!status.configured) return '其他'

    // 联网搜索（失败不阻塞——摘要为空时模型凭知识回答）
    let snippets: string[] = []
    if (this.options.search !== undefined) {
      try {
        snippets = await this.options.search.search(name)
      } catch {
        snippets = []
      }
    }

    let result: CompanyType = '其他'
    try {
      const session = await this.agent.createSession('company_type')
      try {
        const reply = await session.prompt(buildPrompt(name, snippets))
        result = parseCompanyType(reply)
      } finally {
        session.dispose()
      }
    } catch {
      // 未配置已在 getStatus 拦截；模型/会话失败一律兜底'其他'（infer 永不抛）
    }
    this.cache.set(name, result)
    return result
  }

  /** 清空缓存（测试/设置变更时用）。 */
  clearCache(): void {
    this.cache.clear()
  }
}

/** 提示词：企业性质取值定义 + 搜索摘要；要求只输出一个词。 */
function buildPrompt(company: string, snippets: string[]): string {
  const rules = [
    '央企：国务院国资委直属（如国家电网、中石化、中国移动）',
    '国企：地方国企或国有控股（如上海汽车、北京银行）',
    '大厂：头部互联网/科技公司（如腾讯、字节跳动、阿里巴巴、华为）',
    '外企：外资企业（如微软、谷歌、宝洁）',
    '私企：其他民营企业',
    '事业单位：学校、医院、科研院所等',
    '信息不足或拿不准：输出"其他"'
  ].join('\n')
  const evidence = snippets.length > 0 ? snippets.join('\n') : '（无搜索结果，请基于你的知识判断）'
  return [
    `你是求职助手。请判断公司「${company}」的企业性质，取值只能是：${COMPANY_TYPES.join('、')}。`,
    `取值定义：\n${rules}`,
    `联网搜索结果摘要：\n${evidence}`,
    '请只输出一个词（企业性质取值），不要解释。'
  ].join('\n\n')
}

/** 模型回答 → 企业性质枚举；不可解析 → '其他'。 */
function parseCompanyType(reply: string): CompanyType {
  const trimmed = reply.trim()
  const exact = (COMPANY_TYPES as readonly string[]).find((t) => trimmed === t)
  if (exact !== undefined) return exact as CompanyType
  // 宽松匹配：回答含"大厂"等词（如「应该是大厂」）
  const loose = (COMPANY_TYPES as readonly string[]).find((t) => trimmed.includes(t))
  return (loose as CompanyType | undefined) ?? '其他'
}
