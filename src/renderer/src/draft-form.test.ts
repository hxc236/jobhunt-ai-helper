import { describe, expect, it } from 'vitest'
import { draftToResume, draftWarnings } from './draft-form'
import type { ResumeDraft } from '@shared/types'

const fullDraft: ResumeDraft = {
  fileName: 'resume.docx',
  text: '…',
  fields: {
    name: '张伟',
    phone: '13800001234',
    email: 'z@example.com',
    birthday: '2004-06',
    gender: '男',
    education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术', period: '2022.09 ~ 2026.06' }],
    skills: ['Java', 'Python']
  },
  confidence: 1,
  missingFields: [],
  scanned: false
}

describe('draftToResume（F-16/#31）', () => {
  it('草稿字段 → 简历：教育取第一条（起止从 period 解析），技能单组', () => {
    const resume = draftToResume(fullDraft, '上传的简历')
    expect(resume.basics).toMatchObject({
      name: '张伟',
      phone: '13800001234',
      email: 'z@example.com',
      birthday: '2004-06',
      gender: '男'
    })
    expect(resume.education).toEqual([
      { school: '北京理工大学', degree: '本科', major: '计算机科学与技术', startDate: '2022.09', endDate: '2026.06' }
    ])
    expect(resume.skills).toEqual([{ category: '专业技能', items: ['Java', 'Python'] }])
    expect(resume.meta?.title).toBe('上传的简历')
    expect(resume.meta?.baseResumeId).toBeNull()
  })

  it('缺字段/无教育/无技能：对应字段 undefined 或空数组（确认前不入库）', () => {
    const partial: ResumeDraft = {
      fileName: 'scan.pdf',
      text: '',
      fields: { name: '李娜', education: [], skills: [] },
      confidence: 0,
      missingFields: ['phone', 'email', 'education'],
      scanned: true
    }
    const resume = draftToResume(partial, '')
    expect(resume.basics?.name).toBe('李娜')
    expect(resume.basics?.phone).toBeUndefined()
    expect(resume.education).toEqual([])
    expect(resume.skills).toEqual([])
    expect(resume.meta?.title).toBeUndefined() // 空标题不写入
  })

  it('period 含「至今」→ endDate null（应届未毕业）', () => {
    const draft: ResumeDraft = {
      ...fullDraft,
      fields: { ...fullDraft.fields, education: [{ school: '清华', degree: '硕士', major: '软工', period: '2024.09 ~ 至今' }] }
    }
    const resume = draftToResume(draft, 'x')
    expect(resume.education?.[0]?.endDate).toBeNull()
    expect(resume.education?.[0]?.startDate).toBe('2024.09')
  })
})

describe('draftWarnings（F-16/#31）', () => {
  it('扫描件 + 缺字段 + 低置信度提示', () => {
    const warnings = draftWarnings({
      fileName: 's.pdf',
      text: '',
      fields: { name: 'x', education: [], skills: [] },
      confidence: 0.25,
      missingFields: ['phone', 'email', 'education'],
      scanned: true
    })
    expect(warnings.join('\n')).toContain('扫描件')
    expect(warnings.join('\n')).toContain('未识别到电话')
    expect(warnings.join('\n')).toContain('未识别到教育经历')
  })

  it('完整草稿无警告', () => {
    expect(draftWarnings(fullDraft)).toEqual([])
  })
})
