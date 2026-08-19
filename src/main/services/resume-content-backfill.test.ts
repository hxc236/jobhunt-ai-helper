import { describe, expect, it } from 'vitest'
import {
  backfillContentOptimizationData,
  descriptionToHighlights,
  generateProjectId,
  inferSectionOrder,
  MAX_PROJECT_HIGHLIGHTS
} from './resume-content-backfill'
import type { Resume } from '../../shared/types/resume'

/** 存量简历样例：项目无 id/highlights，简历无 sectionOrder（T01 自动补齐的目标形态）。 */
const legacyResume: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
  projects: [
    {
      name: '校园二手交易平台',
      description: '面向校内学生的 C2C 二手交易平台\n日均 500+ 访问\n接口 p95 < 200ms',
      techStack: ['Java', 'Spring Boot']
    },
    {
      name: '个人博客系统',
      description: 'Markdown 驱动的个人博客',
      techStack: ['Vue 3', 'Express']
    }
  ],
  experience: [{ company: '某公司', title: '实习生', highlights: ['完成订单模块'] }],
  honors: ['一等奖学金']
}

describe('descriptionToHighlights', () => {
  it('按行拆条、trim、过滤空行', () => {
    expect(descriptionToHighlights('行一\n  行二  \n\n行三')).toEqual(['行一', '行二', '行三'])
  })

  it('单行 → 单条；空/undefined → undefined', () => {
    expect(descriptionToHighlights('单行描述')).toEqual(['单行描述'])
    expect(descriptionToHighlights('')).toBeUndefined()
    expect(descriptionToHighlights(undefined)).toBeUndefined()
  })

  it('超过 4 行截断到 4 条（schema maxItems 同步）', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 条`)
    expect(descriptionToHighlights(lines.join('\n'))).toEqual(lines.slice(0, MAX_PROJECT_HIGHLIGHTS))
  })
})

describe('inferSectionOrder', () => {
  it('由既有顺序推断：默认顺序中实际存在的节（basics 恒首位，空节剔除）', () => {
    expect(inferSectionOrder(legacyResume)).toEqual([
      'basics',
      'education',
      'experience',
      'projects',
      'honors'
    ])
  })

  it('最小简历（仅 basics）→ 只含 basics', () => {
    expect(inferSectionOrder({ meta: {}, basics: { name: '张伟' }, education: [] })).toEqual(['basics'])
  })
})

describe('generateProjectId', () => {
  it('生成 proj- 前缀的稳定 ID，两次调用互异', () => {
    const a = generateProjectId()
    const b = generateProjectId()
    expect(a).toMatch(/^proj-/)
    expect(a).not.toBe(b)
  })
})

describe('backfillContentOptimizationData', () => {
  it('补齐项目 id、highlights（description 按行迁移）与 sectionOrder', () => {
    const { resume, changed } = backfillContentOptimizationData(legacyResume)
    expect(changed).toBe(true)

    // 项目 ID
    expect(resume.projects?.[0]?.id).toMatch(/^proj-/)
    expect(resume.projects?.[1]?.id).toMatch(/^proj-/)
    expect(resume.projects?.[0]?.id).not.toBe(resume.projects?.[1]?.id)

    // description 迁移为要点起点（≤4 条）
    expect(resume.projects?.[0]?.highlights).toEqual([
      '面向校内学生的 C2C 二手交易平台',
      '日均 500+ 访问',
      '接口 p95 < 200ms'
    ])
    expect(resume.projects?.[1]?.highlights).toEqual(['Markdown 驱动的个人博客'])
    // 原文保留（description 作为要点起点，不回退旧消费者）
    expect(resume.projects?.[0]?.description).toBe(legacyResume.projects?.[0]?.description)

    // sectionOrder 按既有顺序推断
    expect(resume.sectionOrder).toEqual(['basics', 'education', 'experience', 'projects', 'honors'])
  })

  it('幂等：二次运行不再生成（changed=false，结果与首次一致）', () => {
    const once = backfillContentOptimizationData(legacyResume)
    const twice = backfillContentOptimizationData(once.resume)
    expect(twice.changed).toBe(false)
    expect(twice.resume).toEqual(once.resume)
    // 项目 ID 稳定：不重新生成
    expect(twice.resume.projects?.[0]?.id).toBe(once.resume.projects?.[0]?.id)
  })

  it('已有 id/highlights/sectionOrder 的简历原样保留（不覆盖）', () => {
    const input: Resume = {
      ...legacyResume,
      sectionOrder: ['basics', 'education', 'honors', 'experience', 'projects'],
      projects: [
        {
          id: 'proj-fixed',
          name: '平台',
          highlights: ['已有要点'],
          description: '旧描述',
          techStack: ['Java']
        }
      ]
    }
    const { resume, changed } = backfillContentOptimizationData(input)
    expect(changed).toBe(false)
    expect(resume).toEqual(input)
  })

  it('无项目/无 description 的简历：仅补 sectionOrder（若有实际节）', () => {
    const minimal: Resume = { meta: {}, basics: { name: '张伟' }, education: [] }
    const { resume, changed } = backfillContentOptimizationData(minimal)
    expect(changed).toBe(true)
    expect(resume.sectionOrder).toEqual(['basics'])
    expect(resume.projects).toBeUndefined()
  })

  it('projects 无 description → 不补 highlights，只补 id', () => {
    const input: Resume = {
      meta: {},
      basics: { name: '张伟' },
      education: [],
      projects: [{ name: '无描述项目', techStack: ['Java'] }]
    }
    const { resume } = backfillContentOptimizationData(input)
    expect(resume.projects?.[0]?.id).toMatch(/^proj-/)
    expect(resume.projects?.[0]?.highlights).toBeUndefined()
  })

  it('#91 highlights: []（空数组，schema 合法）视作未补齐 → 由 description 迁移，二次运行幂等', () => {
    const input: Resume = {
      meta: {},
      basics: { name: '张伟' },
      education: [],
      projects: [
        {
          id: 'proj-empty',
          name: '平台',
          description: '面向校内学生的 C2C 二手交易平台\n日均 500+ 访问\n接口 p95 < 200ms',
          highlights: [],
          techStack: ['Java']
        }
      ]
    }
    const once = backfillContentOptimizationData(input)
    expect(once.changed).toBe(true)
    expect(once.resume.projects?.[0]?.id).toBe('proj-empty')
    expect(once.resume.projects?.[0]?.highlights).toEqual([
      '面向校内学生的 C2C 二手交易平台',
      '日均 500+ 访问',
      '接口 p95 < 200ms'
    ])

    const twice = backfillContentOptimizationData(once.resume)
    expect(twice.changed).toBe(false)
    expect(twice.resume).toEqual(once.resume)
  })

  it('补齐结果通过 resume schema 校验（id/highlights/sectionOrder 均合法）', () => {
    const { resume } = backfillContentOptimizationData(legacyResume)
    // 通过 shared schema 校验（import 触发编译期类型，运行时校验见 resume.test.ts）
    expect(resume.projects?.[0]?.highlights?.length).toBeLessThanOrEqual(4)
    expect(resume.sectionOrder?.every((s) => ['basics', 'education', 'experience', 'projects', 'research', 'honors', 'skills', 'selfAssessment'].includes(s))).toBe(true)
  })
})
