import { describe, expect, it } from 'vitest'
import { AgentService } from './agent'
import { FakeAgentProvider } from './fake-agent-provider'
import {
  BrowserWindowSearchProvider,
  CompanyTypeService,
  extractSearchSnippets,
  type CompanySearchProvider
} from './company-type'

/** 记录型搜索：可编程摘要/失败；记录调用序列。 */
function makeFakeSearch(snippets: string[] = [], fail = false): CompanySearchProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async search(company) {
      calls.push(company)
      if (fail) throw new Error('search network error')
      return snippets
    }
  }
}

function makeAgent(onPrompt?: (prompt: string) => string): { provider: FakeAgentProvider; service: AgentService } {
  const provider = new FakeAgentProvider({ onPrompt })
  return { provider, service: new AgentService(provider) }
}

describe('extractSearchSnippets（联网搜索摘要提取，纯函数）', () => {
  const HTML = `
<!DOCTYPE html><html><head><title>搜索</title><script>var x = 1;</script><style>.b_algo{color:red}</style></head>
<body>
<li class="b_algo"><h2><a href="https://example.com">法本信息 - 百度百科</a></h2><p>深圳市法本信息技术股份有限公司，全国领先的软件技术服务提供商，民营企业。</p></li>
<li class="b_algo"><p>法本信息：软件外包服务公司，非国企非央企。</p></li>
<span>这是太短的噪声行</span>
</body></html>`

  it('剥离脚本/样式/标签，返回有意义的文本行（噪声行过滤）', () => {
    const snippets = extractSearchSnippets(HTML)
    expect(snippets.length).toBeGreaterThanOrEqual(2)
    expect(snippets.join('')).not.toContain('<')
    expect(snippets.join('')).not.toContain('var x')
    expect(snippets.join('')).toContain('软件技术服务提供商')
  })

  it('空/异常 HTML → 空数组', () => {
    expect(extractSearchSnippets('')).toEqual([])
    expect(extractSearchSnippets('<html>no content</html>')).toEqual([])
  })
})

describe('CompanyTypeService.infer（issue #54）', () => {
  it('联网搜索摘要进入提示词，模型回答解析为企业性质', async () => {
    let promptCount = 0
    const { service } = makeAgent((prompt) => {
      promptCount++
      expect(prompt).toContain('法本信息') // 搜索摘要已注入
      expect(prompt).toContain('民营企业') // 摘要内容
      return '私企'
    })
    const search = makeFakeSearch(['法本信息：软件外包服务公司，民营企业。'])
    const svc = new CompanyTypeService(service, { search })

    await expect(svc.infer('法本信息')).resolves.toBe('私企')
    expect(search.calls).toEqual(['法本信息'])
    expect(promptCount).toBe(1)
  })

  it('缓存命中：同公司只搜索+调用模型一次', async () => {
    let promptCount = 0
    const { service } = makeAgent(() => {
      promptCount++
      return '大厂'
    })
    const search = makeFakeSearch(['腾讯：互联网巨头'])
    const svc = new CompanyTypeService(service, { search })

    await expect(svc.infer('腾讯')).resolves.toBe('大厂')
    await expect(svc.infer('腾讯')).resolves.toBe('大厂')
    expect(search.calls).toEqual(['腾讯']) // 只搜一次
    expect(promptCount).toBe(1) // 只调模型一次
  })

  it('查不到（模型回答不可解析）→ 兜底"其他"', async () => {
    const { service } = makeAgent(() => '我不知道这是什么公司')
    const svc = new CompanyTypeService(service, { search: makeFakeSearch([]) })
    await expect(svc.infer('某不知名公司')).resolves.toBe('其他')
  })

  it('agent 未配置 → 直接"其他"，不创建会话、不搜索', async () => {
    const provider = new FakeAgentProvider({ configured: false })
    const service = new AgentService(provider)
    const search = makeFakeSearch(['不会用到'])
    const svc = new CompanyTypeService(service, { search })

    await expect(svc.infer('腾讯')).resolves.toBe('其他')
    expect(search.calls).toEqual([])
    expect(provider.sessions).toHaveLength(0)
  })

  it('搜索失败不阻塞：跳过摘要继续（模型仍可回答），异常不冒泡', async () => {
    const { service } = makeAgent(() => '外企')
    const search = makeFakeSearch([], true)
    const svc = new CompanyTypeService(service, { search })

    await expect(svc.infer('宝洁')).resolves.toBe('外企')
  })

  it('模型调用失败（会话层错误）→ 兜底"其他"不抛', async () => {
    const failing = new FakeAgentProvider({
      onPrompt: () => {
        throw new Error('model error')
      }
    })
    const svc = new CompanyTypeService(new AgentService(failing), { search: makeFakeSearch(['x']) })
    await expect(svc.infer('腾讯')).resolves.toBe('其他')
  })
})

describe('BrowserWindowSearchProvider（真实搜索接线）', () => {
  it('用抓取器抓 Bing 搜索页并提取摘要（搜索 URL 含公司名）', async () => {
    const fetched: string[] = []
    const fetcher = {
      async fetch(url: string): Promise<string> {
        fetched.push(url)
        return '<html><li class="b_algo"><p>法本信息是一家民营软件技术服务公司，非国企非央企，总部位于深圳。</p></li></html>'
      }
    }
    const provider = new BrowserWindowSearchProvider(fetcher as never)
    const snippets = await provider.search('法本信息')

    expect(fetched[0]).toContain('cn.bing.com/search')
    expect(fetched[0]).toContain(encodeURIComponent('法本信息'))
    expect(snippets.some((s) => s.includes('民营软件技术服务公司'))).toBe(true)
  })
})
