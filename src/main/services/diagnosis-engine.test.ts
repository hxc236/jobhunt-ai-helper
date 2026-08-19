import { describe, expect, it } from 'vitest'
import {
  buildDiagnosisPrompt,
  deriveProjectVerdict,
  parseDiagnosis
} from './diagnosis-engine'
import type { Resume } from '../../shared/types/resume'
import type { ContentDiagnosis } from '../../shared/types'

const RESUME: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟', phone: '13800001234' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
  experience: [{ company: '某公司', title: '实习生', highlights: ['完成订单模块'] }],
  projects: [
    { id: 'proj-1', name: '二手交易平台', description: 'C2C 二手交易\nSpring Boot 实现', techStack: ['Java'] },
    { id: 'proj-2', name: '课程设计', description: '学生管理系统', techStack: [] }
  ],
  skills: [{ category: '工程能力', text: 'Java 开发' }]
}

describe('buildDiagnosisPrompt（#93 规则诊断引擎）', () => {
  it('提示词覆盖 R1–R4+结果 全部规则与质量维度定义', () => {
    const prompt = buildDiagnosisPrompt(RESUME)
    expect(prompt).toContain('[内容优化 1/2')
    expect(prompt).toContain('R1')
    expect(prompt).toContain('R2')
    expect(prompt).toContain('R3')
    expect(prompt).toContain('R4')
    // 质量维度定义
    expect(prompt).toContain('目标用户')
    expect(prompt).toContain('具体目标与约束')
    expect(prompt).toContain('本人边界')
    expect(prompt).toContain('关键行动')
    expect(prompt).toContain('可归因成果')
    expect(prompt).toContain('证据等级')
    expect(prompt).toContain('技术栈')
  })

  it('提示词含边界约束：不依赖 JD、不做岗位相关性判断、不输出总分/等级、大赛归项目经历', () => {
    const prompt = buildDiagnosisPrompt(RESUME)
    expect(prompt).toContain('无 JD')
    expect(prompt).toContain('岗位相关性')
    expect(prompt).toContain('总分')
    expect(prompt).toContain('大赛')
  })

  it('提示词内嵌简历 JSON（含项目稳定 ID）供 LLM 对照', () => {
    const prompt = buildDiagnosisPrompt(RESUME)
    expect(prompt).toContain('简历 JSON：')
    expect(prompt).toContain('proj-1')
    expect(prompt).toContain('二手交易平台')
  })

  it('R3 实习前置规则定义无条件相对顺序（实习排在项目/大赛之前）', () => {
    const prompt = buildDiagnosisPrompt(RESUME)
    expect(prompt).toContain('无条件')
    expect(prompt).toMatch(/实习.*(?:之前|前置|排在前)/)
  })

  it('R3 提示词注明 na 条件：无实习经历或仅一条实习经历 → 不适用(na)', () => {
    const prompt = buildDiagnosisPrompt(RESUME)
    expect(prompt).toMatch(/无实习.*仅一条.*不适用/)
    expect(prompt).toContain('(na)')
  })
})

describe('parseDiagnosis（#93 规则判定解析与一致性推导）', () => {
  it('完整规则矩阵回复 → 结构化解析（ruleId/target/status/evidence/issue/suggestion/factSource）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R1', target: 'project:proj-1', status: 'improve', evidence: '无难点描述', issue: '缺难点与解决行动', suggestion: '补充 1 条难点+行动', factSource: 'original' },
        { ruleId: 'R2', target: 'global', status: 'improve', evidence: '全角引号混用', issue: '标点不统一', suggestion: '统一中文标点', factSource: 'original' },
        { ruleId: 'R3', target: 'section:order', status: 'pass', evidence: '实习在前', issue: '', suggestion: '', factSource: 'original' },
        { ruleId: 'R4-简介', target: 'project:proj-2', status: 'insufficient', evidence: '仅一句话', issue: '缺目标用户', suggestion: '补充场景与目标用户', factSource: 'original' }
      ],
      projects: [
        { projectId: 'proj-1', verdict: 'keep' },
        { projectId: 'proj-2', verdict: 'needs-info' }
      ],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.rules).toHaveLength(4)
    expect(d.rules[0]).toEqual({
      ruleId: 'R1',
      target: 'project:proj-1',
      status: 'improve',
      evidence: '无难点描述',
      issue: '缺难点与解决行动',
      suggestion: '补充 1 条难点+行动',
      factSource: 'original'
    })
    // R2 全局维度作用对象 = global
    expect(d.rules.find((r) => r.ruleId === 'R2')?.target).toBe('global')
    expect(d.rules.find((r) => r.ruleId === 'R3')?.target).toBe('section:order')
  })

  it('项目判定一致性：任一 insufficient → needs-info（最高优先级）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R1', target: 'project:proj-1', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' },
        { ruleId: 'R4-简介', target: 'project:proj-1', status: 'insufficient', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' }
      ],
      projects: [{ projectId: 'proj-1', verdict: 'rewrite' }],
      questions: []
    })
    const d = parseDiagnosis(reply)
    // LLM 说 rewrite，但含 insufficient → 推导为 needs-info
    expect(d.projects[0].verdict).toBe('needs-info')
  })

  it('项目判定一致性：无 insufficient 但有 improve → rewrite', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R4-结果', target: 'project:proj-1', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' }
      ],
      projects: [{ projectId: 'proj-1', verdict: 'keep' }],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.projects[0].verdict).toBe('rewrite')
  })

  it('项目判定一致性：全部 pass → keep（LLM 的 keep 一致保留）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R1', target: 'project:proj-1', status: 'pass', evidence: 'e', issue: '', suggestion: '', factSource: 'original' },
        { ruleId: 'R4-简介', target: 'project:proj-1', status: 'pass', evidence: 'e', issue: '', suggestion: '', factSource: 'original' }
      ],
      projects: [{ projectId: 'proj-1', verdict: 'keep' }],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.projects[0].verdict).toBe('keep')
  })

  it('项目无规则条目时采用 LLM 判定（兜底）；question 结构保留', () => {
    const reply = JSON.stringify({
      rules: [],
      projects: [{ projectId: 'proj-1', verdict: 'needs-info' }],
      questions: [
        { projectId: 'proj-1', field: '难点', question: '最大难点？', evidence: '原文', candidates: ['分布式锁'] }
      ]
    })
    const d = parseDiagnosis(reply)
    expect(d.projects[0].verdict).toBe('needs-info')
    expect(d.questions[0]).toEqual({
      projectId: 'proj-1',
      field: '难点',
      question: '最大难点？',
      evidence: '原文',
      candidates: ['分布式锁']
    })
  })

  it('非法字段降级：未知 status → na、未知 verdict → keep、缺失字段补空串', () => {
    const reply = JSON.stringify({
      rules: [{ ruleId: 'R1', target: 'project:proj-1', status: '什么状态' }],
      projects: [{ projectId: 'proj-1', verdict: '啥' }],
      questions: [{ projectId: 'proj-1' }]
    })
    const d = parseDiagnosis(reply)
    expect(d.rules[0].status).toBe('na')
    expect(d.rules[0].evidence).toBe('')
    expect(d.rules[0].factSource).toBe('original')
    expect(d.projects[0].verdict).toBe('keep')
    expect(d.questions[0].field).toBe('')
  })

  it('非 JSON 回复 → 抛错（bad-json 语义，供服务层标记 failed）', () => {
    expect(() => parseDiagnosis('这不是 JSON')).toThrow(/诊断输出结构非法|JSON/)
  })

  it('空诊断（全部保持 + 无规则 + 无追问）解析成功且保持空诊断语义', () => {
    const d = parseDiagnosis(JSON.stringify({ rules: [], projects: [{ projectId: 'proj-1', verdict: 'keep' }], questions: [] }))
    expect(d).toEqual<ContentDiagnosis>({
      rules: [],
      projects: [{ projectId: 'proj-1', verdict: 'keep' }],
      questions: [],
      promotions: []
    })
  })

  it('LLM 省略 projects 数组但有项目 improve 规则 → 由规则推导项目判定（rewrite）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R1', target: 'project:proj-1', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' },
        { ruleId: 'R4-结果', target: 'project:proj-2', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' }
      ],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.projects).toEqual([
      { projectId: 'proj-1', verdict: 'rewrite' },
      { projectId: 'proj-2', verdict: 'rewrite' }
    ])
  })

  it('LLM 省略 projects 数组且含 insufficient 项目规则 → 推导为 needs-info（最高优先级）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R4-简介', target: 'project:proj-1', status: 'insufficient', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' },
        { ruleId: 'R4-简介', target: 'project:proj-2', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' }
      ],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.projects).toEqual([
      { projectId: 'proj-1', verdict: 'needs-info' },
      { projectId: 'proj-2', verdict: 'rewrite' }
    ])
  })

  it('无 projects 数组且无项目规则（仅全局规则）→ projects 保持空（不凭空生成）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R2', target: 'global', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' }
      ],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.projects).toEqual([])
  })

  it('projects 数组为空但项目规则存在 → 同样由规则推导（projects 空数组不阻断推导）', () => {
    const reply = JSON.stringify({
      rules: [
        { ruleId: 'R1', target: 'project:proj-1', status: 'improve', evidence: 'e', issue: 'i', suggestion: 's', factSource: 'original' }
      ],
      projects: [],
      questions: []
    })
    const d = parseDiagnosis(reply)
    expect(d.projects).toEqual([{ projectId: 'proj-1', verdict: 'rewrite' }])
  })
})

describe('deriveProjectVerdict（#93 一致性推导纯函数）', () => {
  it('insufficient 优先于 improve 与 keep', () => {
    const rules = [
      { ruleId: 'R1', target: 'project:p1', status: 'improve', evidence: '', issue: '', suggestion: '', factSource: 'original' },
      { ruleId: 'R4-简介', target: 'project:p1', status: 'insufficient', evidence: '', issue: '', suggestion: '', factSource: 'original' }
    ] as ContentDiagnosis['rules']
    expect(deriveProjectVerdict('p1', rules)).toBe('needs-info')
  })

  it('improve → rewrite；全部 pass → keep', () => {
    const improve = [
      { ruleId: 'R1', target: 'project:p1', status: 'improve', evidence: '', issue: '', suggestion: '', factSource: 'original' }
    ] as ContentDiagnosis['rules']
    expect(deriveProjectVerdict('p1', improve)).toBe('rewrite')
    const pass = [
      { ruleId: 'R1', target: 'project:p1', status: 'pass', evidence: '', issue: '', suggestion: '', factSource: 'original' }
    ] as ContentDiagnosis['rules']
    expect(deriveProjectVerdict('p1', pass)).toBe('keep')
  })

  it('只统计该项目规则（target=project:<id>），全局规则不影响', () => {
    const rules = [
      { ruleId: 'R2', target: 'global', status: 'improve', evidence: '', issue: '', suggestion: '', factSource: 'original' }
    ] as ContentDiagnosis['rules']
    // 全局 improve 不应把项目推导为 rewrite（作用对象不是该项目）
    expect(deriveProjectVerdict('p1', rules)).toBe('keep')
  })

  it('无该项目规则 → keep（调用方再决定是否用 LLM 判定兜底）', () => {
    expect(deriveProjectVerdict('p1', [])).toBe('keep')
  })
})

describe('parseDiagnosis 大赛提升建议（T08/#98）', () => {
  it('解析合法 promotions（缺失字段子集 + 稳定 id + honorIndex）', () => {
    const reply = JSON.stringify({
      rules: [],
      projects: [],
      questions: [],
      promotions: [
        { id: 'promo-0', honorIndex: 0, honorName: '全国大学生数学建模竞赛省一等奖', evidence: '原文：竞赛省一等奖', missingFields: ['startDate', 'techStack', 'description'] }
      ]
    })
    const d = parseDiagnosis(reply)
    expect(d.promotions).toEqual([
      {
        id: 'promo-0',
        honorIndex: 0,
        honorName: '全国大学生数学建模竞赛省一等奖',
        evidence: '原文：竞赛省一等奖',
        missingFields: ['startDate', 'techStack', 'description']
      }
    ])
  })

  it('缺失 id 时按 promo-<honorIndex> 兜底；缺失字段缺省为空数组', () => {
    const d = parseDiagnosis(
      JSON.stringify({ rules: [], projects: [], questions: [], promotions: [{ honorIndex: 2, honorName: '挑战杯', evidence: 'e' }] })
    )
    expect(d.promotions).toEqual([{ id: 'promo-2', honorIndex: 2, honorName: '挑战杯', evidence: 'e', missingFields: [] }])
  })

  it('非法条目跳过：honorIndex 非数字、missingFields 含非法字段', () => {
    const d = parseDiagnosis(
      JSON.stringify({
        rules: [],
        projects: [],
        questions: [],
        promotions: [
          { id: 'bad', honorIndex: 'x', honorName: '非法', evidence: 'e' },
          { id: 'ok', honorIndex: 1, honorName: '合法', evidence: 'e', missingFields: ['startDate', 'illegal', 'startDate'] }
        ]
      })
    )
    // 非法条目被跳过；合法条目 missingFields 过滤非法 + 去重
    expect(d.promotions).toEqual([{ id: 'ok', honorIndex: 1, honorName: '合法', evidence: 'e', missingFields: ['startDate'] }])
  })

  it('#98 review：honorName 缺失/空白的建议被跳过（名称是提升对象的确认依据）', () => {
    const d = parseDiagnosis(
      JSON.stringify({
        rules: [],
        projects: [],
        questions: [],
        promotions: [
          { id: 'no-name', honorIndex: 0, evidence: 'e' },
          { id: 'blank-name', honorIndex: 1, honorName: '   ', evidence: 'e' },
          { id: 'num-name', honorIndex: 2, honorName: 42, evidence: 'e' },
          { id: 'ok', honorIndex: 3, honorName: '挑战杯', evidence: 'e' }
        ]
      })
    )
    expect(d.promotions).toEqual([{ id: 'ok', honorIndex: 3, honorName: '挑战杯', evidence: 'e', missingFields: [] }])
  })

  it('非大赛荣誉（无 promotions 字段/空数组）→ 空数组，不破坏空诊断语义', () => {
    const d = parseDiagnosis(JSON.stringify({ rules: [], projects: [{ projectId: 'p1', verdict: 'keep' }], questions: [] }))
    expect(d.promotions).toEqual([])
    expect(d.projects).toEqual([{ projectId: 'p1', verdict: 'keep' }])
  })

  it('提示词包含大赛提升契约（honorIndex/missingFields/非大赛不输出）', () => {
    const prompt = buildDiagnosisPrompt({ meta: { title: 'x' }, basics: { name: 'n' }, education: [] })
    expect(prompt).toContain('promotions')
    expect(prompt).toContain('honorIndex')
    expect(prompt).toContain('missingFields')
    expect(prompt).toContain('非大赛荣誉')
  })
})
