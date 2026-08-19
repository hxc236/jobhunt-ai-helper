import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { isLegacyResume, migrateLegacyResumes, transformLegacyResume } from './resume-migrate'
import type { Resume } from '../../shared/types/resume'

/** 旧结构样例（v1：技能 items/proficiency、项目 role/highlights/link）。 */
const legacyResume = {
  meta: { title: '基准简历', baseResumeId: null, targetJobId: null },
  basics: { name: '张伟', hometown: '河北石家庄' },
  education: [
    { school: '北京理工大学', degree: '本科', major: '计算机科学与技术', honors: ['一等奖学金', '蓝桥杯省二等奖'] }
  ],
  skills: [
    { category: '编程语言', items: ['Java', 'Python'], proficiency: '熟练' },
    { category: '框架', items: ['Spring Boot', 'MyBatis'], proficiency: '熟悉' }
  ],
  projects: [
    {
      name: '校园二手交易平台',
      role: '后端开发',
      startDate: '2025-03',
      endDate: '2025-08',
      description: 'C2C 交易平台',
      highlights: ['接口 p95 < 200ms'],
      techStack: ['Java', 'Spring Boot'],
      link: 'https://github.com/zhangwei/blog'
    }
  ],
  experience: [{ company: '某公司', title: '实习生', highlights: ['完成订单模块'] }],
  certificates: [{ name: 'CET-6', issuer: '教育部', date: '2024-06' }],
  selfAssessment: '基础扎实'
}

describe('isLegacyResume 形状检测', () => {
  it('旧结构（技能 items / 项目 role/highlights/link）→ true', () => {
    expect(isLegacyResume(legacyResume)).toBe(true)
  })

  it('新结构（三分类段落 + 精简项目）→ false', () => {
    const v2: Resume = {
      meta: { title: '基准简历' },
      basics: { name: '张伟' },
      education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
      skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
      projects: [{ name: '二手平台', description: 'C2C 平台', techStack: ['Java'] }]
    }
    expect(isLegacyResume(v2)).toBe(false)
  })

  it('#91 新结构含项目 id+highlights（无 role/link）→ false，不被误判为旧结构', () => {
    const v2WithHighlights: Resume = {
      meta: { title: '基准简历' },
      basics: { name: '张伟' },
      education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
      skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
      projects: [
        {
          id: 'proj-abc',
          name: '二手平台',
          description: 'C2C 平台',
          highlights: ['接口 p95 < 200ms'],
          techStack: ['Java']
        }
      ]
    }
    expect(isLegacyResume(v2WithHighlights)).toBe(false)
  })
})

describe('transformLegacyResume', () => {
  it('技能条目合并为「工程能力」一段话；项目裁剪 role/highlights/link', () => {
    const next = transformLegacyResume(legacyResume)
    expect(next.skills).toEqual([
      { category: '工程能力', text: '编程语言：Java、Python；框架：Spring Boot、MyBatis' }
    ])
    expect(next.projects).toEqual([
      {
        name: '校园二手交易平台',
        startDate: '2025-03',
        endDate: '2025-08',
        description: 'C2C 交易平台',
        techStack: ['Java', 'Spring Boot']
      }
    ])
    // 荣誉：教育条目 → 顶层聚合，教育条目不再含荣誉
    expect(next.honors).toEqual(['一等奖学金', '蓝桥杯省二等奖'])
    expect(next.education?.[0]).not.toHaveProperty('honors')
    expect(next.education?.[0]).toMatchObject({ school: '北京理工大学', degree: '本科' })
    // 其余分节原样保留；证书字段剥离（已从模型移除）
    expect(next.experience).toEqual(legacyResume.experience)
    expect(next.basics).toEqual(legacyResume.basics)
    expect(next.meta).toEqual(legacyResume.meta)
    expect(next).not.toHaveProperty('certificates')
  })

  it('技能空条目 → skills 省略；项目字段缺失保持 undefined', () => {
    const next = transformLegacyResume({ ...legacyResume, skills: [{ category: '工具', items: [] }] })
    expect(next.skills).toEqual([])
  })

  it('#91 防御性：项目若带 id（v2 字段）则原样保留', () => {
    const next = transformLegacyResume({
      ...legacyResume,
      projects: [{ ...legacyResume.projects![0]!, id: 'proj-keep' }]
    })
    expect(next.projects?.[0]?.id).toBe('proj-keep')
    // 旧结构裁剪行为不变：role/highlights/link 仍被剥离
    expect(next.projects?.[0]).not.toHaveProperty('role')
    expect(next.projects?.[0]).not.toHaveProperty('highlights')
    expect(next.projects?.[0]).not.toHaveProperty('link')
  })
})

describe('migrateLegacyResumes（库级扫描）', () => {
  it('转换旧行、跳过新行；幂等（二次执行 0 行）', () => {
    const db = openDatabase()
    db.prepare('INSERT INTO resumes (id, json, created_at) VALUES (?, ?, ?)').run('legacy-1', JSON.stringify(legacyResume), '2026-01-01')
    const v2: Resume = {
      meta: { title: '新' },
      basics: { name: '李娜' },
      education: [],
      skills: [{ category: '科研能力', text: '数学建模' }]
    }
    db.prepare('INSERT INTO resumes (id, json, created_at) VALUES (?, ?, ?)').run('v2-1', JSON.stringify(v2), '2026-01-01')

    expect(migrateLegacyResumes(db)).toBe(1)

    const row = db.prepare('SELECT json FROM resumes WHERE id = ?').get('legacy-1') as { json: string }
    const migrated = JSON.parse(row.json) as Resume
    expect(migrated.skills).toEqual([{ category: '工程能力', text: '编程语言：Java、Python；框架：Spring Boot、MyBatis' }])
    expect(migrated.projects?.[0]).not.toHaveProperty('role')
    expect(migrated.projects?.[0]).not.toHaveProperty('highlights')

    // 幂等：新结构不再转换
    expect(migrateLegacyResumes(db)).toBe(0)
  })

  it('#91 新结构含项目 id+highlights 的行不转换：id/highlights 原样保留（修复数据丢失回归）', () => {
    const db = openDatabase()
    const v2WithHighlights: Resume = {
      meta: { title: '基准简历' },
      basics: { name: '张伟' },
      education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
      skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
      sectionOrder: ['basics', 'education', 'skills'],
      projects: [
        {
          id: 'proj-abc',
          name: '二手平台',
          description: 'C2C 平台',
          highlights: ['接口 p95 < 200ms'],
          techStack: ['Java']
        }
      ]
    }
    db.prepare('INSERT INTO resumes (id, json, created_at) VALUES (?, ?, ?)').run(
      'v2-highlights',
      JSON.stringify(v2WithHighlights),
      '2026-01-01'
    )

    expect(migrateLegacyResumes(db)).toBe(0)

    const row = db.prepare('SELECT json FROM resumes WHERE id = ?').get('v2-highlights') as {
      json: string
    }
    const after = JSON.parse(row.json) as Resume
    expect(after.projects?.[0]?.id).toBe('proj-abc')
    expect(after.projects?.[0]?.highlights).toEqual(['接口 p95 < 200ms'])
    expect(after.sectionOrder).toEqual(['basics', 'education', 'skills'])
  })
})
