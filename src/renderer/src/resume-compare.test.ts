import { describe, expect, it } from 'vitest'
import { buildDerivedResume, diffResumeSections } from './resume-compare'
import type { Resume } from '@shared/types/resume'
import type { OptimizeChange } from '@shared/types'

const base: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟', phone: '13800001234' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机' }],
  skills: [{ category: '工程能力', text: 'Java 开发' }],
  projects: [{ name: '平台', techStack: ['Java'] }],
  experience: [],
  selfAssessment: '基础扎实'
}

const optimized: Resume = {
  ...base,
  meta: { title: '优化稿' },
  basics: { ...base.basics!, name: '张伟', phone: '13800001234', email: 'z@example.com' },
  skills: [{ category: '工程能力', text: 'Java、Python 开发' }],
  projects: [{ name: '平台', techStack: ['Java', 'Spring Boot'] }],
  selfAssessment: '基础扎实，热爱后端'
}

const changes: OptimizeChange[] = [
  { section: 'skills', before: '…', after: '…', reason: '补充 JD 关键词 Python' },
  { section: 'selfAssessment', before: '…', after: '…', reason: '突出学习能力' }
]

describe('diffResumeSections（F-20/#34 验收：对比视图高亮正确）', () => {
  it('改动节标记 changed 并带 changes 中的理由；未改节 changed=false', () => {
    const diffs = diffResumeSections(base, optimized, changes)
    const bySection = Object.fromEntries(diffs.map((d) => [d.section, d]))

    expect(bySection.basics?.changed).toBe(true) // 新增 email
    expect(bySection.basics?.reason).toBeUndefined() // changes 未覆盖 → 无理由
    expect(bySection.education?.changed).toBe(false)
    expect(bySection.skills?.changed).toBe(true)
    expect(bySection.skills?.reason).toBe('补充 JD 关键词 Python')
    expect(bySection.projects?.changed).toBe(true) // techStack 增 Spring Boot
    expect(bySection.experience?.changed).toBe(false)
    expect(bySection.selfAssessment?.changed).toBe(true)
    expect(bySection.selfAssessment?.reason).toBe('突出学习能力')
  })

  it('科研经历参与对比：research 节变化被检出（含顺序在 experience 之后）', () => {
    const withResearch: Resume = {
      ...base,
      research: [{ title: '课题A', achievement: '论文' }]
    }
    const diffs = diffResumeSections(base, withResearch, [])
    expect(diffs.find((d) => d.section === 'research')?.changed).toBe(true)
    // 展示顺序：… education → experience → projects → research → honors → skills → selfAssessment
    const order = diffs.map((d) => d.section)
    expect(order.indexOf('research')).toBeGreaterThan(order.indexOf('projects'))
    expect(order.indexOf('research')).toBeLessThan(order.indexOf('honors'))
    // 双方均无 research → 未改
    expect(diffResumeSections(base, base, []).find((d) => d.section === 'research')?.changed).toBe(false)
  })

  it('完全一致 → 全部未改', () => {
    const diffs = diffResumeSections(base, base, [])
    expect(diffs.every((d) => !d.changed)).toBe(true)
  })

  it('节不存在（undefined vs undefined）→ 未改；undefined vs 有值 → 改', () => {
    const empty: Resume = { meta: {}, basics: { name: '' }, education: [] }
    const withExp: Resume = {
      ...empty,
      experience: [{ company: 'A', title: 'T' }]
    }
    const diffs = diffResumeSections(empty, withExp, [])
    expect(diffs.find((d) => d.section === 'experience')?.changed).toBe(true)
    expect(diffs.find((d) => d.section === 'skills')?.changed).toBe(false) // 双方均无 → 未改
  })
})

describe('buildDerivedResume（F-20/#34 验收：确认后派生稿入库且关联职位卡）', () => {
  it('meta.baseResumeId/targetJobId 写入；title 缺省按 baseTitle 生成', () => {
    const derived = buildDerivedResume('res-1', 'job-9', optimized, '', '基准简历')
    expect(derived.meta?.baseResumeId).toBe('res-1')
    expect(derived.meta?.targetJobId).toBe('job-9')
    expect(derived.meta?.title).toBe('基准简历-job-9')
    expect(derived.basics?.email).toBe('z@example.com') // 优化内容保留
  })

  it('显式 title 优先', () => {
    const derived = buildDerivedResume('res-1', 'job-2', optimized, '腾讯-后端-优化稿')
    expect(derived.meta?.title).toBe('腾讯-后端-优化稿')
  })
})
