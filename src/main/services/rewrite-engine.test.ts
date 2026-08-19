import { describe, expect, it } from 'vitest'
import { buildRewritePrompt, parseRewrite, type RewriteRoundInput } from './rewrite-engine'
import { ResumeValidationError } from './resume-schema'
import type { Resume } from '../../shared/types/resume'
import type { ContentRewrite } from '../../shared/types'

/** 测试用简历（含稳定项目 ID 与已补齐字段，与 start() 补齐后的形态一致）。 */
const RESUME: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟', phone: '13800001234', email: 'z@example.com' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
  skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
  projects: [
    {
      id: 'proj-1',
      name: '二手交易平台',
      description: 'C2C 二手交易\nSpring Boot 实现',
      highlights: ['C2C 二手交易', 'Spring Boot 实现'],
      techStack: ['Java', 'Spring Boot']
    },
    { id: 'proj-2', name: '课程设计', description: '学生管理系统', highlights: ['学生管理系统'], techStack: [] }
  ],
  sectionOrder: ['basics', 'education', 'skills', 'projects']
}

/** 项目夹具（RESUME.projects 非空别名）。 */
const PROJECTS = RESUME.projects!

function makeInput(overrides: Partial<RewriteRoundInput> = {}): RewriteRoundInput {
  return {
    resume: RESUME,
    diagnosis: null,
    answers: null,
    ...overrides
  }
}

/** 一条合法 change（before 命中原文、after/reason 非空）。 */
const GROUNDED_CHANGE = {
  projectId: 'proj-1',
  section: 'highlights',
  before: 'C2C 二手交易',
  after: 'C2C 二手交易（含高并发秒杀压测难点与解决行动）',
  reason: 'R1 补充难点与解决行动',
  source: 'user-answer'
}

describe('buildRewritePrompt（#95 逐项目改写提示词）', () => {
  it('含改写轮标记与规则约束 R1–R4（难点/标点/实习前置/四要素/证据等级/技术栈）', () => {
    const prompt = buildRewritePrompt(makeInput())
    expect(prompt).toContain('[内容优化 2/2')
    expect(prompt).toContain('R1')
    expect(prompt).toContain('R2')
    expect(prompt).toContain('R3')
    expect(prompt).toContain('R4')
    expect(prompt).toContain('难点')
    expect(prompt).toContain('解决行动')
    expect(prompt).toContain('标点')
    expect(prompt).toContain('实习前置')
    expect(prompt).toContain('四要素')
    expect(prompt).toContain('目标用户')
    expect(prompt).toContain('本人边界')
    expect(prompt).toContain('关键行动')
    expect(prompt).toContain('可归因成果')
    expect(prompt).toContain('证据等级')
    expect(prompt).toContain('技术栈')
    expect(prompt).toContain('≤4')
  })

  it('含事实使用规则：原文优先 / 用户回答 / 新增无来源 → inferred 待确认 / 未答不得当作已确认', () => {
    const prompt = buildRewritePrompt(makeInput())
    expect(prompt).toContain('原文优先')
    expect(prompt).toContain('用户回答')
    expect(prompt).toContain('inferred')
    expect(prompt).toContain('待确认')
    expect(prompt).toContain('未回答')
    expect(prompt).toMatch(/不得当作已确认/)
  })

  it('含哨兵处理说明（不属实 / 无法补充 的候选不得写入简历）', () => {
    const prompt = buildRewritePrompt(makeInput())
    expect(prompt).toContain('[不属实]')
    expect(prompt).toContain('[无法补充]')
    expect(prompt).toMatch(/不得写入简历/)
  })

  it('含 changes 输出契约（before 原文 / after 非空 / reason / source 三值）', () => {
    const prompt = buildRewritePrompt(makeInput())
    expect(prompt).toContain('source')
    expect(prompt).toContain('original|user-answer|inferred')
    expect(prompt).toMatch(/before/)
    expect(prompt).toMatch(/after/)
    expect(prompt).toMatch(/reason/)
    expect(prompt).toMatch(/只记录实际改动/)
  })

  it('内嵌简历 JSON、诊断与用户回答（含哨兵值）', () => {
    const prompt = buildRewritePrompt(
      makeInput({
        diagnosis: {
          rules: [],
          projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
          questions: [{ id: 'q1', projectId: 'proj-1', field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: ['分布式锁'] }]
        },
        answers: { q1: '[不属实]' }
      })
    )
    expect(prompt).toContain('简历 JSON：')
    expect(prompt).toContain('proj-1')
    expect(prompt).toContain('二手交易平台')
    expect(prompt).toContain('"q1"')
    expect(prompt).toContain('[不属实]')
  })
})

describe('parseRewrite（#95 解析 + 事实溯源 + 一致性校验）', () => {
  it('合法回复 → resume + changes 解析通过（含项目稳定 ID）', () => {
    const result = parseRewrite(JSON.stringify({ resume: RESUME, changes: [GROUNDED_CHANGE] }), makeInput())
    expect(result.resume).toEqual(RESUME)
    expect(result.changes[0]?.projectId).toBe('proj-1')
    expect(result.changes[0]?.source).toBe('user-answer')
  })

  it('非 JSON 回复 → 抛错', () => {
    expect(() => parseRewrite('不是 JSON', makeInput())).toThrow()
  })

  it('缺少 resume 对象 → 抛错', () => {
    expect(() => parseRewrite(JSON.stringify({ changes: [] }), makeInput())).toThrow(/resume/)
  })

  it('resume 不符合 schema（要点 >4 条）→ ResumeValidationError', () => {
    const bad = {
      ...RESUME,
      projects: [
        { ...PROJECTS[0]!, highlights: ['a', 'b', 'c', 'd', 'e'] },
        PROJECTS[1]
      ]
    }
    expect(() =>
      parseRewrite(JSON.stringify({ resume: bad, changes: [] }), makeInput())
    ).toThrowError(ResumeValidationError)
  })

  it('before 未命中原文（宽松匹配）→ 抛错', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'highlights', before: '完全不存在的内容', after: 'x', reason: 'r', source: 'original' }]
    })
    expect(() => parseRewrite(reply, makeInput())).toThrow(/before/)
  })

  it('before 宽松匹配：标点/空白差异仍可命中原文', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [
        { section: 'highlights', before: ' C2C 二手交易。', after: 'C2C 二手交易（含难点）', reason: 'R1', source: 'original' }
      ]
    })
    const result = parseRewrite(reply, makeInput())
    expect(result.changes).toHaveLength(1)
  })

  it('after 为空 → 抛错', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'highlights', before: 'C2C 二手交易', after: '  ', reason: 'r', source: 'original' }]
    })
    expect(() => parseRewrite(reply, makeInput())).toThrow(/after/)
  })

  it('reason 为空 → 抛错', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'highlights', before: 'C2C 二手交易', after: 'x', reason: '', source: 'original' }]
    })
    expect(() => parseRewrite(reply, makeInput())).toThrow(/reason/)
  })

  it('no-op 改动（before≈after）被丢弃', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [
        { section: 'highlights', before: 'C2C 二手交易', after: 'C2C 二手交易。', reason: 'r', source: 'original' }
      ]
    })
    const result = parseRewrite(reply, makeInput())
    expect(result.changes).toHaveLength(0)
  })

  it('事实溯源：声称 user-answer 但既无原文锚点也无回答文本 → 降级 inferred 并标记待确认', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [
        { projectId: 'proj-1', section: 'highlights', before: 'C2C 二手交易', after: '完成秒杀场景压测调优，P95 降至 200ms 以下', reason: '新增结果', source: 'user-answer' }
      ]
    })
    const result = parseRewrite(reply, makeInput({ answers: {} }))
    expect(result.changes[0]?.source).toBe('inferred')
    expect(result.changes[0]?.reason).toContain('待确认')
  })

  it('事实溯源：after 含用户回答文本 → 保持 user-answer', () => {
    const reply = JSON.stringify({ resume: RESUME, changes: [GROUNDED_CHANGE] })
    const result = parseRewrite(reply, makeInput({ answers: { q1: '高并发秒杀压测优化' } }))
    expect(result.changes[0]?.source).toBe('user-answer')
  })

  it('inferred 来源 → reason 补「待确认」标记（重复运行不重复追加）', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'highlights', before: 'C2C 二手交易', after: 'C2C 二手交易，额外优化', reason: '补充', source: 'inferred' }]
    })
    const once = parseRewrite(reply, makeInput())
    expect(once.changes[0]?.reason).toContain('待确认')
    const twice = parseRewrite(reply, makeInput())
    expect(twice.changes[0]?.reason).toContain('待确认')
  })

  it('排序类改动（sectionOrder）：不要求 before 命中原文，来源不降级', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'sectionOrder', before: 'basics,education,skills,projects', after: 'basics,education,projects,skills', reason: 'R3 实习前置', source: 'original' }]
    })
    const result = parseRewrite(reply, makeInput())
    expect(result.changes[0]?.source).toBe('original')
  })

  it('非法 source 值 → 保守降级 inferred 并标记待确认', () => {
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'highlights', before: 'C2C 二手交易', after: 'C2C 二手交易（x）', reason: 'r', source: 'bogus' }]
    })
    const result = parseRewrite(reply, makeInput())
    expect(result.changes[0]?.source).toBe('inferred')
    expect(result.changes[0]?.reason).toContain('待确认')
  })

  it('哨兵抑制：不属实候选被新增进改写稿 → 抛错', () => {
    const input = makeInput({
      diagnosis: {
        rules: [],
        projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
        questions: [{ id: 'q1', projectId: 'proj-1', field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: ['分布式锁保证一致性'] }]
      },
      answers: { q1: '[不属实]' }
    })
    const reply = JSON.stringify({
      resume: {
        ...RESUME,
        projects: [
          { ...PROJECTS[0]!, highlights: ['C2C 二手交易', 'Spring Boot 实现', '使用分布式锁保证一致性'] },
          PROJECTS[1]
        ]
      },
      changes: [{ projectId: 'proj-1', section: 'highlights', before: 'Spring Boot 实现', after: 'Spring Boot 实现；分布式锁保证一致性', reason: 'R1', source: 'user-answer' }]
    })
    expect(() => parseRewrite(reply, input)).toThrow(/不属实/)
  })

  it('哨兵抑制：无法补充候选被新增进改写稿 → 抛错', () => {
    const input = makeInput({
      diagnosis: {
        rules: [],
        projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
        questions: [{ id: 'q1', projectId: 'proj-1', field: '结果', question: '结果？', evidence: 'e', candidates: ['上线后转化率提升 20%'] }]
      },
      answers: { q1: '[无法补充]' }
    })
    const reply = JSON.stringify({
      resume: {
        ...RESUME,
        projects: [
          { ...PROJECTS[0]!, highlights: ['C2C 二手交易', 'Spring Boot 实现', '上线后转化率提升 20%'] },
          PROJECTS[1]
        ]
      },
      changes: [{ projectId: 'proj-1', section: 'highlights', before: 'Spring Boot 实现', after: 'Spring Boot 实现；转化率提升 20%', reason: 'R4-结果', source: 'inferred' }]
    })
    expect(() => parseRewrite(reply, input)).toThrow(/无法补充/)
  })

  it('哨兵候选原本就在原文中 → 不算新增，放行', () => {
    const input = makeInput({
      diagnosis: {
        rules: [],
        projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
        questions: [{ id: 'q1', projectId: 'proj-1', field: '难点', question: '最大的技术难点？', evidence: 'e', candidates: ['Spring Boot 实现'] }]
      },
      answers: { q1: '[不属实]' }
    })
    const reply = JSON.stringify({ resume: RESUME, changes: [] })
    expect(() => parseRewrite(reply, input)).not.toThrow()
  })

  it('项目可溯源：项目被静默改动且无 change → 抛错', () => {
    const reply = JSON.stringify({
      resume: { ...RESUME, projects: [{ ...PROJECTS[0]!, highlights: ['改后的要点'] }, PROJECTS[1]] },
      changes: []
    })
    expect(() => parseRewrite(reply, makeInput())).toThrow(/未在 changes 中记录/)
  })

  it('项目可溯源：项目被改动但有对应 change → 通过', () => {
    const reply = JSON.stringify({
      resume: { ...RESUME, projects: [{ ...PROJECTS[0]!, highlights: ['C2C 二手交易', 'Spring Boot 实现', '分布式锁保证一致性'] }, PROJECTS[1]] },
      changes: [{ projectId: 'proj-1', section: 'highlights', before: 'Spring Boot 实现', after: 'Spring Boot 实现；分布式锁保证一致性', reason: 'R1', source: 'user-answer' }]
    })
    const result = parseRewrite(reply, makeInput())
    expect(result.resume.projects?.[0]?.highlights).toContain('分布式锁保证一致性')
  })

  it('项目可溯源：项目被静默删除且无 change → 抛错；有节级 change → 通过', () => {
    const deleted = JSON.stringify({ resume: { ...RESUME, projects: [PROJECTS[1]] }, changes: [] })
    expect(() => parseRewrite(deleted, makeInput())).toThrow(/消失/)
    const sectionLevel = JSON.stringify({
      resume: { ...RESUME, projects: [PROJECTS[1]] },
      changes: [{ section: 'projects', before: '二手交易平台', after: '二手交易平台（已删除）', reason: '项目无实质内容，建议删除', source: 'original' }]
    })
    expect(() => parseRewrite(sectionLevel, makeInput())).not.toThrow()
  })

  it('项目可溯源：新增项目无 change → 抛错；有对应 change → 通过', () => {
    const added = JSON.stringify({
      resume: { ...RESUME, projects: [...PROJECTS, { id: 'proj-9', name: '新项目', description: '新经历', highlights: ['新经历'], techStack: [] }] },
      changes: []
    })
    expect(() => parseRewrite(added, makeInput())).toThrow(/新增/)
    const withChange = JSON.stringify({
      resume: { ...RESUME, projects: [...PROJECTS, { id: 'proj-9', name: '新项目', description: '新经历', highlights: ['新经历'], techStack: [] }] },
      changes: [{ projectId: 'proj-9', section: 'projects', before: '', after: '新项目：新经历', reason: '大赛经历提升为项目', source: 'user-answer' }]
    })
    expect(() => parseRewrite(withChange, makeInput())).not.toThrow()
  })

  it('未答项不当作已确认事实：回答缺失键时提示词明示约束（解析层不编造）', () => {
    // 未答 = answers 缺键；改写轮只能基于原文或已答文本，新增无来源 → inferred（由溯源兜底保证）
    const reply = JSON.stringify({
      resume: RESUME,
      changes: [{ section: 'highlights', before: 'C2C 二手交易', after: '完成压测优化', reason: '补', source: 'user-answer' }]
    })
    const result = parseRewrite(reply, makeInput({ answers: {} }))
    expect(result.changes[0]?.source).toBe('inferred')
  })
})

/** 兼容旧契约的命名空间导出检查（服务层引用）。 */
describe('parseRewrite 返回类型', () => {
  it('返回 ContentRewrite 结构（resume + changes）', () => {
    const result: ContentRewrite = parseRewrite(
      JSON.stringify({ resume: RESUME, changes: [GROUNDED_CHANGE] }),
      makeInput()
    )
    expect(result.changes[0]).toMatchObject({ before: 'C2C 二手交易', after: expect.any(String), reason: expect.any(String) })
  })
})
