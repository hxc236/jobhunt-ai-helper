import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { openDatabase } from '../db/database'
import { AgentService, type AgentProvider, type AgentSession } from './agent'
import { FakeAgentProvider } from './fake-agent-provider'
import { ResumeService } from './resume'
import { SettingsService } from './settings'
import { ResumeImportService, AGENT_IMPORT_ENABLED, AGENT_IMPORT_CONSENT, type ImportEvent } from './resume-import'
import type { Resume } from '../../shared/types/resume'

/**
 * #77 服务层 seam 测试：ResumeImportService（注入真实 AgentService + FakeAgentProvider +
 * SettingsService）——覆盖成功、隐私同意、未配置/关闭降级、schema 修正一轮、网络重试、
 * 30s 超时决策（继续等待/本地草稿）、连续非法降级。
 */

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text
      .split('\n')
      .map((line) => `<w:p><w:r><w:t>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
      .join('')}<w:sectPr/></w:body></w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const SAMPLE_TEXT = [
  '张伟',
  '电话：138-0000-1234',
  '邮箱：zhangwei@example.com',
  '本科 北京理工大学 计算机科学与技术 2022-09 ~ 2026-06',
  '技能：Java、Spring Boot、TypeScript'
].join('\n')

/** 合法 Agent 结构化输出（完整 Resume）。 */
const AGENT_RESUME: Resume = {
  meta: { title: '技术向简历' },
  basics: { name: '张伟', phone: '13800001234', email: 'zhangwei@example.com' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术', startDate: '2022-09', endDate: '2026-06' }],
  skills: [{ category: '工程能力', text: '熟悉 Java、Spring Boot、TypeScript 开发。' }]
}

const FULL_V2_AGENT_RESUME: Resume = {
  meta: { title: '技术向简历' },
  basics: {
    name: '张伟',
    phone: '13800001234',
    email: 'zhangwei@example.com',
    birthday: '2002-03',
    politicalStatus: '中共党员',
    jobIntention: { position: '全栈工程师', city: ['北京'] },
    links: [{ label: 'Github', url: 'https://github.com/example' }]
  },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术', startDate: '2022-09', endDate: '2026-06', rank: '前10%', courses: ['数据结构'] }],
  projects: [{ name: '求职助手', startDate: '2025-01', endDate: '2025-06', description: '开发本地桌面求职助手。', techStack: ['Electron', 'TypeScript'] }],
  experience: [{ company: '示例公司', title: '开发实习生', startDate: '2025-06', endDate: '2025-08', highlights: ['完成系统开发'], techStack: ['Vue'] }],
  research: [{ title: '图像生成研究', startDate: '2024-09', endDate: '2026-04', description: '研究多模态图像生成。', achievement: '论文在投' }],
  honors: ['一等奖学金'],
  skills: [
    { category: '工程能力', text: '熟悉 TypeScript。' },
    { category: '科研能力', text: '熟悉深度学习。' },
    { category: '其他能力', text: '英语 CET-6。' }
  ]
}

interface Harness {
  svc: ResumeImportService
  fake: FakeAgentProvider
  settings: SettingsService
  events: ImportEvent[]
  dir: string
  agentWaitMs: number
}

function makeHarness(options: { configured?: boolean; agentWaitMs?: number; delayMs?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'resume-import-agent-'))
  const resumes = new ResumeService(openDatabase(':memory:'))
  const settings = new SettingsService(openDatabase(':memory:'))
  const fake = new FakeAgentProvider({ configured: options.configured ?? true, delayMs: options.delayMs ?? 0 })
  const agent = new AgentService(fake)
  const events: ImportEvent[] = []
  const agentWaitMs = options.agentWaitMs ?? 50
  const svc = new ResumeImportService({
    resumeService: resumes,
    settings,
    agent,
    agentWaitMs,
    emit: (e) => events.push(e)
  })
  return { svc, fake, settings, events, dir, agentWaitMs }
}

function writeFixture(dir: string, name: string, buf: Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, buf)
  return p
}

class HangingCreateSessionProvider implements AgentProvider {
  readonly name = 'hanging-create'

  getStatus() {
    return { configured: true, provider: 'hanging', model: 'test' }
  }

  async configureProvider(): Promise<void> {}

  createSession(_task: Parameters<AgentProvider['createSession']>[0]): Promise<AgentSession> {
    return new Promise<AgentSession>(() => {})
  }

  dispose(): void {}
}

async function settle(svc: ResumeImportService, token: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (svc.isFinished(token)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('import 流程未在超时内结束')
}

function doneEvent(h: Harness, token: string) {
  return h.events.find((e) => e.type === 'done' && e.token === token) as
    | Extract<ImportEvent, { type: 'done' }>
    | undefined
}

/** 等待 agent_pending 事件（consent/timeout）。 */
async function waitForPending(h: Harness, token: string, kind: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (h.events.some((e) => e.type === 'agent_pending' && e.token === token && e.kind === kind)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`未收到 agent_pending(${kind}) 事件`)
}

describe('ResumeImportService Agent 结构化（#77）', () => {
  it('Agent 建立会话超时：显示 timeout 决策并可选择本地草稿', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-import-agent-create-timeout-'))
    const resumes = new ResumeService(openDatabase(':memory:'))
    const settings = new SettingsService(openDatabase(':memory:'))
    settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    const events: ImportEvent[] = []
    const svc = new ResumeImportService({
      resumeService: resumes,
      settings,
      agent: new AgentService(new HangingCreateSessionProvider()),
      agentWaitMs: 20,
      emit: (event) => events.push(event)
    })
    const token = svc.start(writeFixture(dir, 'hanging.docx', await makeDocx(SAMPLE_TEXT)))

    await waitForPending({ events } as Harness, token, 'timeout', 250)
    svc.decide(token, 'timeout', 'local')
    await settle(svc, token)
    const done = events.find((event) => event.type === 'done' && event.token === token)
    expect(done).toBeDefined()
    expect(done && done.type === 'done' ? done.agent.failedReason : undefined).toBe('user-local')
  })

  it('Agent 输出合法：done 携带 Agent 映射的 Resume，字段状态标记 agent', async () => {
    const h = makeHarness()
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString()) // 已同意
    h.fake.onPrompt = () => JSON.stringify(AGENT_RESUME)
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h.svc, token)

    const done = doneEvent(h, token)
    expect(done).toBeDefined()
    expect(done?.agent?.used).toBe(true)
    expect(done?.resume.basics.name).toBe('张伟')
    expect(done?.resume.education[0]?.school).toBe('北京理工大学')
    // 字段状态：Agent 映射字段标记 agent
    expect(done?.draft.fieldStatus.name).toBe('agent')
    expect(done?.draft.fieldStatus.phone).toBe('agent')
  })

  it('首次使用前：先弹隐私告知（agent_pending consent），未同意前不发送文本', async () => {
    const h = makeHarness()
    h.fake.onPrompt = () => JSON.stringify(AGENT_RESUME)
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await waitForPending(h, token, 'consent')

    // 尚未同意：session 尚未创建（无任何文本发出）
    expect(h.fake.sessions).toHaveLength(0)
    expect(h.settings.get(AGENT_IMPORT_CONSENT)).toBeUndefined()

    // 同意 → 继续 Agent
    h.svc.decide(token, 'consent', 'agree')
    await settle(h.svc, token)
    const done = doneEvent(h, token)
    expect(done?.agent?.used).toBe(true)
    // 同意被记录：下次导入不再询问
    expect(h.settings.get(AGENT_IMPORT_CONSENT)).toBeTruthy()
  })

  it('拒绝同意 → 使用本地草稿并标记 consent-declined；同意仅当次生效后永久记录', async () => {
    const h = makeHarness()
    h.fake.onPrompt = () => JSON.stringify(AGENT_RESUME)
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await waitForPending(h, token, 'consent')
    h.svc.decide(token, 'consent', 'decline')
    await settle(h.svc, token)

    const done = doneEvent(h, token)
    expect(done?.agent?.used).toBe(false)
    expect(done?.agent?.failedReason).toBe('consent-declined')
    expect(done?.resume.basics.name).toBe('张伟') // 本地规则映射保底
    expect(h.settings.get(AGENT_IMPORT_CONSENT)).toBeUndefined() // 未记录同意
    expect(h.fake.sessions).toHaveLength(0) // 从未创建会话/发送文本
  })

  it('Agent 未配置 → 降级本地草稿并显示原因；设置关闭增强 → 同样降级', async () => {
    // 未配置
    const h1 = makeHarness({ configured: false })
    h1.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    const token1 = h1.svc.start(writeFixture(h1.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h1.svc, token1)
    const done1 = doneEvent(h1, token1)
    expect(done1?.agent?.used).toBe(false)
    expect(done1?.agent?.failedReason).toBe('agent-not-configured')

    // 设置关闭
    const h2 = makeHarness()
    h2.settings.set(AGENT_IMPORT_ENABLED, false)
    const token2 = h2.svc.start(writeFixture(h2.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h2.svc, token2)
    const done2 = doneEvent(h2, token2)
    expect(done2?.agent?.used).toBe(false)
    expect(done2?.agent?.failedReason).toBe('agent-disabled')
  })

  it('提示词使用当前 v2 schema，并允许 Agent 按语义归类原文内容', async () => {
    const h = makeHarness()
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    const prompts: string[] = []
    h.fake.onPrompt = (prompt) => {
      prompts.push(prompt)
      return JSON.stringify(AGENT_RESUME)
    }
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h.svc, token)
    expect(prompts.length).toBeGreaterThan(0)
    const prompt = prompts[0]
    expect(prompt).toContain('禁止补写')
    expect(prompt).toContain('原文')
    expect(prompt).toContain('不得猜测修改')
    expect(prompt).toContain('"company"')
    expect(prompt).toContain('"techStack"')
    expect(prompt).toContain('"research"')
    expect(prompt).toContain('"honors": ["')
    expect(prompt).toContain('语义最近')
    expect(prompt).not.toContain('"role"')
    expect(prompt).not.toContain('"organization"')
    // 只接收文本：提示中含提取全文的关键内容（无图片/页面信息）
    expect(prompt).toContain('张伟')
    expect(prompt).toContain('138-0000-1234')
    expect(prompt).toContain('北京理工大学')
  })

  it('Agent 按当前 v2 schema 输出完整内容时，项目/经历/科研/荣誉/技能均保留', async () => {
    const h = makeHarness()
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    h.fake.onPrompt = () => JSON.stringify(FULL_V2_AGENT_RESUME)
    const token = h.svc.start(writeFixture(h.dir, 'full.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h.svc, token)

    const done = doneEvent(h, token)
    expect(done?.agent?.used).toBe(true)
    expect(done?.resume.projects?.[0]?.name).toBe('求职助手')
    expect(done?.resume.experience?.[0]?.company).toBe('示例公司')
    expect(done?.resume.research?.[0]?.title).toBe('图像生成研究')
    expect(done?.resume.honors).toEqual(['一等奖学金'])
    expect(done?.resume.skills).toHaveLength(3)
  })

  it('Agent 输出非法 → 带校验问题修正一轮后成功（修正 prompt 含定位）', async () => {
    const h = makeHarness()
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    const prompts: string[] = []
    let first = true
    h.fake.onPrompt = (prompt) => {
      prompts.push(prompt)
      if (first && !prompt.startsWith('[修正')) {
        first = false
        return JSON.stringify({ meta: {}, basics: { name: '张伟' }, education: [{ school: '北京理工大学', degree: '本科' }] }) // 缺 major
      }
      return JSON.stringify(AGENT_RESUME)
    }
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h.svc, token)

    const done = doneEvent(h, token)
    expect(done?.agent?.used).toBe(true)
    expect(prompts.some((p) => p.startsWith('[修正'))).toBe(true)
    expect(prompts.find((p) => p.startsWith('[修正')) ?? '').toContain('education/0')
    expect(prompts.find((p) => p.startsWith('[修正')) ?? '').toContain('major')
  })

  it('网络错误自动重试一次成功；仍失败 → 降级本地草稿', async () => {
    const h = makeHarness()
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    let calls = 0
    h.fake.onPrompt = async () => {
      calls++
      if (calls === 1) throw new Error('fetch failed: connect ECONNREFUSED')
      return JSON.stringify(AGENT_RESUME)
    }
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h.svc, token)
    expect(doneEvent(h, token)?.agent?.used).toBe(true)
    expect(calls).toBe(2)

    // 重试仍失败 → 降级
    const h2 = makeHarness()
    h2.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    h2.fake.onPrompt = async () => {
      throw new Error('fetch failed: connect ECONNREFUSED')
    }
    const token2 = h2.svc.start(writeFixture(h2.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h2.svc, token2)
    const done2 = doneEvent(h2, token2)
    expect(done2?.agent?.used).toBe(false)
    expect(done2?.agent?.failedReason).toBe('agent-failed')
    expect(done2?.resume.basics.name).toBe('张伟') // 本地保底
  })

  it('Agent 等待超 30s：弹继续等待/使用本地草稿；继续等待后成功', async () => {
    const h = makeHarness({ agentWaitMs: 30, delayMs: 200 })
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    h.fake.onPrompt = () => JSON.stringify(AGENT_RESUME)
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await waitForPending(h, token, 'timeout')
    h.svc.decide(token, 'timeout', 'continue')
    await settle(h.svc, token)
    expect(doneEvent(h, token)?.agent?.used).toBe(true)
  })

  it('超时后选择本地草稿 → 终止 Agent，done 使用本地映射并标记 user-local', async () => {
    const h = makeHarness({ agentWaitMs: 30, delayMs: 200 })
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    h.fake.onPrompt = () => JSON.stringify(AGENT_RESUME)
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await waitForPending(h, token, 'timeout')
    h.svc.decide(token, 'timeout', 'local')
    await settle(h.svc, token)
    const done = doneEvent(h, token)
    expect(done?.agent?.used).toBe(false)
    expect(done?.agent?.failedReason).toBe('user-local')
    expect(done?.resume.basics.name).toBe('张伟')
  })

  it('Agent 输出连续非法（修正后仍非法）→ 降级本地草稿 + invalid-output', async () => {
    const h = makeHarness()
    h.settings.set(AGENT_IMPORT_CONSENT, new Date().toISOString())
    h.fake.onPrompt = () =>
      JSON.stringify({ meta: {}, basics: { name: '张伟' }, education: [{ school: 'X', degree: '本科' }] }) // 恒缺 major
    const token = h.svc.start(writeFixture(h.dir, 'r.docx', await makeDocx(SAMPLE_TEXT)))
    await settle(h.svc, token)
    const done = doneEvent(h, token)
    expect(done?.agent?.used).toBe(false)
    expect(done?.agent?.failedReason).toBe('invalid-output')
    expect(done?.resume.basics.name).toBe('张伟')
  })
})
