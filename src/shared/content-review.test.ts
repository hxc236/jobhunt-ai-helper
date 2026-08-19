import { describe, expect, it } from 'vitest'
import type { Resume, ResumeProject } from './types/resume'
import type { ContentRewrite } from './types'
import {
  buildFinalResume,
  buildIntegrationSummary,
  CHANGE_SOURCE_LABELS,
  CONTENT_DECISION_LABELS,
  pendingInferredChanges,
  projectDecision,
  resumesDiffer,
  reviewProjectState
} from './content-review'

const ORIGINAL_PROJECTS: ResumeProject[] = [
  { id: 'p1', name: '二手交易平台', description: 'C2C 二手交易系统', techStack: ['Java', 'Spring Boot'] },
  { id: 'p2', name: '大赛作品', description: '智能推荐系统', techStack: ['Python'] }
]

const ORIGINAL: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟' },
  education: [{ school: '北理工', degree: '本科', major: '计算机' }],
  skills: [{ category: '工程能力', text: 'Java' }],
  projects: ORIGINAL_PROJECTS,
  sectionOrder: ['basics', 'education', 'skills', 'projects']
}

/** 改写稿：p1 改写（含推断新增），p2 保持，experience 增一条（R3 实习前置）。 */
const REWRITE: ContentRewrite = {
  resume: {
    ...ORIGINAL,
    experience: [{ company: '某公司', title: '实习生', startDate: '2024-06', endDate: '2024-09', highlights: ['完成订单模块'] }],
    sectionOrder: ['basics', 'experience', 'education', 'skills', 'projects'],
    projects: [
      { ...ORIGINAL_PROJECTS[0]!, highlights: ['C2C 二手交易', '高并发秒杀压测优化'], description: 'C2C 二手交易系统（含高并发难点）' },
      ORIGINAL_PROJECTS[1]!
    ]
  },
  changes: [
    { id: 'chg-0', projectId: 'p1', section: 'projects', before: 'C2C 二手交易系统', after: 'C2C 二手交易系统（含高并发难点）', reason: 'R1 补充难点与解决行动', source: 'user-answer' },
    { id: 'chg-1', projectId: 'p1', section: 'highlights', before: '', after: '高并发秒杀压测优化', reason: '（推断-待确认）', source: 'inferred' },
    { id: 'chg-2', section: 'sectionOrder', before: '基础/教育/技能/项目', after: '基础/实习/教育/技能/项目', reason: 'R3 实习前置', source: 'original' }
  ]
}

/** 删除建议改写稿：p2 从改写稿中移除（有 change 记录）。 */
function deletionRewrite(): ContentRewrite {
  return {
    resume: {
      ...ORIGINAL,
      projects: [REWRITE.resume.projects![0]!]
    },
    changes: [
      { id: 'chg-d0', projectId: 'p2', section: 'projects', before: '大赛作品', after: '（建议删除）', reason: '无可补充的难点/结果，建议删除', source: 'original' }
    ]
  }
}

describe('content-review — 决策缺省与状态', () => {
  it('缺省决策 = 接受改写', () => {
    expect(projectDecision(null, 'p1')).toBe('accept')
    expect(projectDecision({ p1: 'reject' }, 'p2')).toBe('accept')
    expect(projectDecision({ p1: 'reject' }, 'p1')).toBe('reject')
  })

  it('标签映射完整（接受改写/保留原文 + 改动来源三值）', () => {
    expect(CONTENT_DECISION_LABELS.accept).toBe('接受改写')
    expect(CONTENT_DECISION_LABELS.reject).toBe('保留原文')
    expect(CHANGE_SOURCE_LABELS.original).toBe('原文')
    expect(CHANGE_SOURCE_LABELS['user-answer']).toBe('用户回答')
    expect(CHANGE_SOURCE_LABELS.inferred).toBe('推断-待确认')
  })

  it('项目状态：改写=changed、保持=unchanged、仅原文=deleted、仅改写稿=unchanged（新增）', () => {
    expect(reviewProjectState(ORIGINAL, REWRITE, 'p1')).toBe('changed')
    expect(reviewProjectState(ORIGINAL, REWRITE, 'p2')).toBe('unchanged')
    expect(reviewProjectState(ORIGINAL, deletionRewrite(), 'p2')).toBe('deleted')
    expect(reviewProjectState(ORIGINAL, REWRITE, 'p-new')).toBe('unchanged')
  })
})

describe('content-review — US17 推断-待确认门禁', () => {
  it('inferred 未勾选 → 待勾选；已勾选 → 不再待勾选', () => {
    const pending = pendingInferredChanges(REWRITE, null, [])
    expect(pending.map((c) => c.id)).toEqual(['chg-1'])
    expect(pendingInferredChanges(REWRITE, null, ['chg-1'])).toEqual([])
  })

  it('被拒项目（保留原文）的 inferred 改动不进入最终版 → 无需勾选', () => {
    expect(pendingInferredChanges(REWRITE, { p1: 'reject' }, [])).toEqual([])
  })

  it('删除记录（改写稿已无该项目）→ 不参与推断勾选门禁（删除确认走项目决策）', () => {
    const deletionRewrite: ContentRewrite = {
      resume: {
        ...ORIGINAL,
        projects: [ORIGINAL_PROJECTS[0]!]
      },
      changes: [
        { id: 'chg-del', projectId: 'p2', section: 'projects', before: '大赛作品', after: '（建议删除）', reason: '建议删除', source: 'inferred' }
      ]
    }
    expect(pendingInferredChanges(deletionRewrite, null, [])).toEqual([])
  })

  it('非 inferred 改动（原文/用户回答）不参与门禁', () => {
    const pending = pendingInferredChanges(REWRITE, null, [])
    expect(pending.some((c) => c.source !== 'inferred')).toBe(false)
  })

  it('节级（无 projectId）inferred 改动被计入待勾选——即使缺 id 也保守待勾选（防确认死锁门禁）', () => {
    const sectionRewrite: ContentRewrite = {
      resume: { ...REWRITE.resume },
      changes: [
        { id: 'chg-sec-1', section: 'experience', before: '', after: '某公司 实习（纯新增）', reason: '（推断-待确认）', source: 'inferred' },
        { section: 'basics', before: '', after: '无 id 的推断新增', reason: '（推断-待确认）', source: 'inferred' }
      ]
    }
    const pending = pendingInferredChanges(sectionRewrite, null, [])
    expect(pending.map((c) => c.id)).toEqual(['chg-sec-1', undefined])
    expect(pendingInferredChanges(sectionRewrite, null, ['chg-sec-1']).map((c) => c.id)).toEqual([undefined])
  })
})

describe('content-review — 整合汇总（US15/18/19）', () => {
  it('全接受：改写项目/排序调整计入汇总，无删除/未解决', () => {
    const summary = buildIntegrationSummary(ORIGINAL, REWRITE, null)
    expect(summary.orderingAdjustments).toContain('模块顺序调整（sectionOrder）')
    expect(summary.orderingAdjustments).toContain('实习/经历顺序调整（R3 实习前置）')
    expect(summary.deletedProjects).toEqual([])
    expect(summary.keptWithWarning).toEqual([])
    expect(summary.unresolvedProjects).toEqual([])
    expect(summary.punctuationFixed).toEqual([]) // p1 是实质改写（含内容新增），非纯标点
  })

  it('纯标点/格式差异（语义一致）→ 计入标点修复', () => {
    const punctuationRewrite: ContentRewrite = {
      resume: {
        ...ORIGINAL,
        projects: [
          { ...ORIGINAL_PROJECTS[0]!, description: 'C2C二手交易系统。' },
          ORIGINAL_PROJECTS[1]!
        ]
      },
      changes: [
        { id: 'chg-p0', projectId: 'p1', section: 'projects', before: 'C2C 二手交易系统', after: 'C2C二手交易系统。', reason: 'R2 标点修复', source: 'original' }
      ]
    }
    const summary = buildIntegrationSummary(ORIGINAL, punctuationRewrite, null)
    expect(summary.punctuationFixed).toEqual(['p1'])
    expect(summary.unresolvedProjects).toEqual([])
  })

  it('改写被拒 → 保留原文并计入「仍有未解决项目」（US19）', () => {
    const summary = buildIntegrationSummary(ORIGINAL, REWRITE, { p1: 'reject' })
    expect(summary.unresolvedProjects).toEqual(['p1'])
    expect(summary.punctuationFixed).toEqual([])
  })

  it('纯标点修复被拒 → 不计入标点修复（最终版保留原文，无实际修复）', () => {
    const punctuationRewrite: ContentRewrite = {
      resume: {
        ...ORIGINAL,
        projects: [
          { ...ORIGINAL_PROJECTS[0]!, description: 'C2C二手交易系统。' },
          ORIGINAL_PROJECTS[1]!
        ]
      },
      changes: [
        { id: 'chg-p0', projectId: 'p1', section: 'projects', before: 'C2C 二手交易系统', after: 'C2C二手交易系统。', reason: 'R2 标点修复', source: 'original' }
      ]
    }
    const summary = buildIntegrationSummary(ORIGINAL, punctuationRewrite, { p1: 'reject' })
    expect(summary.punctuationFixed).toEqual([]) // 被拒项目最终保留原文 → 无标点修复
    expect(summary.unresolvedProjects).toEqual([]) // 语义一致，不算「未解决」
  })

  it('删除建议接受 → 计入删除；拒绝 → 保留原文 + 警告（US18）', () => {
    const accepted = buildIntegrationSummary(ORIGINAL, deletionRewrite(), { p2: 'accept' })
    expect(accepted.deletedProjects).toEqual(['p2'])
    expect(accepted.keptWithWarning).toEqual([])

    const kept = buildIntegrationSummary(ORIGINAL, deletionRewrite(), { p2: 'reject' })
    expect(kept.deletedProjects).toEqual([])
    expect(kept.keptWithWarning).toEqual(['p2'])
  })
})

describe('content-review — 最终简历整合（buildFinalResume）', () => {
  it('全接受：最终稿采用改写稿（含新增 experience/项目改写），非项目节来自改写稿', () => {
    const final = buildFinalResume(ORIGINAL, REWRITE, null)
    expect(final.experience?.length).toBe(1)
    expect(final.sectionOrder).toEqual(['basics', 'experience', 'education', 'skills', 'projects'])
    const p1 = final.projects?.find((p) => p.id === 'p1')
    expect(p1?.highlights).toEqual(['C2C 二手交易', '高并发秒杀压测优化'])
    expect(final.projects?.some((p) => p.id === 'p2')).toBe(true)
  })

  it('p1 被拒 → 该位置替换回原文；p2 保持；experience/顺序仍来自改写稿', () => {
    const final = buildFinalResume(ORIGINAL, REWRITE, { p1: 'reject' })
    const p1 = final.projects?.find((p) => p.id === 'p1')
    expect(p1?.highlights).toBeUndefined() // 原文版本（无要点）
    expect(p1?.description).toBe('C2C 二手交易系统')
    expect(final.experience?.length).toBe(1) // 非项目节照常生效（US19 其他修改不受影响）
    expect(final.projects?.some((p) => p.id === 'p2')).toBe(true)
  })

  it('删除确认 → 项目不进最终稿；删除拒绝 → 原文保留', () => {
    const deleted = buildFinalResume(ORIGINAL, deletionRewrite(), { p2: 'accept' })
    expect(deleted.projects?.some((p) => p.id === 'p2')).toBe(false)
    expect(deleted.projects?.some((p) => p.id === 'p1')).toBe(true)

    const kept = buildFinalResume(ORIGINAL, deletionRewrite(), { p2: 'reject' })
    const p2 = kept.projects?.find((p) => p.id === 'p2')
    expect(p2?.description).toBe('智能推荐系统') // 原文保留
    expect(kept.projects?.map((p) => p.id)).toEqual(['p1', 'p2']) // 拒绝删除 → 保留原位置（不追加末尾）
  })

  it('删除拒绝：中间位置的删除建议项目留在原位置，不静默重排到末尾', () => {
    const threeOriginal: Resume = {
      ...ORIGINAL,
      projects: [
        { id: 'p1', name: '项目一', description: '描述一', techStack: [] },
        { id: 'p2', name: '大赛作品', description: '智能推荐系统', techStack: ['Python'] },
        { id: 'p3', name: '项目三', description: '描述三', techStack: [] }
      ]
    }
    const delP2Rewrite: ContentRewrite = {
      resume: { ...threeOriginal, projects: [threeOriginal.projects![0]!, threeOriginal.projects![2]!] },
      changes: [
        { id: 'chg-del-p2', projectId: 'p2', section: 'projects', before: '大赛作品', after: '（建议删除）', reason: '无可补充内容', source: 'original' }
      ]
    }
    // 全接受：删除确认 → p2 不进最终稿，其余按原文顺序
    const deleted = buildFinalResume(threeOriginal, delP2Rewrite, null)
    expect(deleted.projects?.map((p) => p.id)).toEqual(['p1', 'p3'])
    // 拒绝删除：p2 保留在 p1 与 p3 之间（原位置），而非追加末尾
    const kept = buildFinalResume(threeOriginal, delP2Rewrite, { p2: 'reject' })
    expect(kept.projects?.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('全部拒绝 → 最终稿与原简历一致（无改动不建版本判定用）', () => {
    const final = buildFinalResume(ORIGINAL, REWRITE, { p1: 'reject', p2: 'reject' })
    // 仍有 experience/sectionOrder 来自改写稿 → 与原简历不同
    expect(resumesDiffer(ORIGINAL, final)).toBe(true)
    // 若改写稿与原文除 meta 外一致 → 视为无改动
    const sameRewrite: ContentRewrite = { resume: { ...ORIGINAL }, changes: [] }
    expect(resumesDiffer(ORIGINAL, buildFinalResume(ORIGINAL, sameRewrite, null))).toBe(false)
  })

  it('resumesDiffer 对对象键序不敏感（数组仍有序比较）；meta 差异忽略', () => {
    const reordered: Resume = {
      meta: { title: '另一个标题' },
      basics: { name: '张伟' },
      education: [],
      projects: [
        { techStack: ['Java'], name: '二手交易平台', id: 'p1', description: 'C2C 二手交易系统' },
        { techStack: ['Python'], name: '大赛作品', id: 'p2', description: '智能推荐系统' }
      ],
      sectionOrder: ['basics', 'projects']
    }
    const original: Resume = {
      meta: { title: '基准简历' },
      basics: { name: '张伟' },
      education: [],
      projects: [
        { id: 'p1', name: '二手交易平台', description: 'C2C 二手交易系统', techStack: ['Java'] },
        { id: 'p2', name: '大赛作品', description: '智能推荐系统', techStack: ['Python'] }
      ],
      sectionOrder: ['basics', 'projects']
    }
    expect(resumesDiffer(original, reordered)).toBe(false) // 键序不同不算改动
    const different: Resume = { ...original, basics: { name: '李四' } }
    expect(resumesDiffer(original, different)).toBe(true)
    const reorderedArray: Resume = {
      ...original,
      projects: [original.projects![1]!, original.projects![0]!]
    }
    expect(resumesDiffer(original, reorderedArray)).toBe(true) // 数组顺序敏感
  })

  it('新增项目（仅改写稿存在）随改写稿进入最终稿', () => {
    const withNew: ContentRewrite = {
      resume: {
        ...ORIGINAL,
        projects: [...ORIGINAL_PROJECTS, { id: 'p-new', name: '新项目', description: '大赛经历提升', techStack: [] }]
      },
      changes: [
        { id: 'chg-n0', projectId: 'p-new', section: 'projects', before: '', after: '新项目', reason: '大赛经历提升为项目', source: 'inferred' }
      ]
    }
    const final = buildFinalResume(ORIGINAL, withNew, null)
    expect(final.projects?.some((p) => p.id === 'p-new')).toBe(true)
  })
})
