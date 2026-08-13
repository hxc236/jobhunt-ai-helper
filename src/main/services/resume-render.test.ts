import { describe, expect, it } from 'vitest'
import { dateRange, esc, renderResumeHtml, renderSheet } from './resume-render'
import type { Resume } from '../../shared/types/resume'

const sample: Resume = {
  meta: { title: '基准简历' },
  basics: {
    name: '张伟',
    phone: '13800001234',
    email: 'z@example.com',
    gender: '男',
    birthday: '2004-06',
    politicalStatus: '共青团员',
    hometown: '河北石家庄',
    jobIntention: { position: '后端开发工程师（校招）', city: ['北京', '杭州'], salary: '面议' },
    links: [{ label: 'GitHub', url: 'https://github.com/z' }]
  },
  education: [
    {
      school: '北京理工大学',
      degree: '本科',
      major: '计算机科学与技术',
      startDate: '2022-09',
      endDate: '2026-06',
      gpa: '3.7/4.0',
      courses: ['数据结构'],
      honors: ['一等奖学金']
    }
  ],
  skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
  projects: [
    {
      name: '二手交易平台',
      startDate: '2025-03',
      endDate: '2025-08',
      description: 'C2C 平台',
      techStack: ['Java', 'Spring Boot']
    }
  ],
  experience: [{ company: '某公司', title: '实习生', highlights: ['完成订单模块'] }],
  certificates: [{ name: 'CET-6', issuer: '教育部', date: '2024-06' }],
  selfAssessment: '基础扎实'
}

describe('resume-render A4 模板（F-15/#30）', () => {
  it('完整文档：A4 sheet + 打印样式（@media print）+ 全分节渲染', () => {
    const html = renderResumeHtml(sample)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('class="sheet"')
    expect(html).toContain('@media print')
    expect(html).toContain('width: 794px') // A4 宽度
  })

  it('分节渲染：基本信息/意向/链接/教育/技能/项目/经历/证书/自评齐全', () => {
    const sheet = renderSheet(sample)
    expect(sheet).toContain('<h1>张伟</h1>')
    expect(sheet).toContain('男　|　2004-06　|　共青团员　|　河北石家庄') // headline
    expect(sheet).toContain('求职意向：后端开发工程师（校招）')
    expect(sheet).toContain('https://github.com/z')
    for (const heading of ['教育背景', '专业技能', '项目经历', '实习经历', '证书', '自我评价']) {
      expect(sheet).toContain(`<h2>${heading}</h2>`)
    }
    expect(sheet).toContain('北京理工大学　本科 · 计算机科学与技术')
    expect(sheet).toContain('GPA 3.7/4.0')
    expect(sheet).toContain('工程能力')
    expect(sheet).toContain('Java、Python 服务端开发')
    expect(sheet).toContain('<span class="tag">Java</span>')
    expect(sheet).toContain('某公司　<em>实习生</em>')
    expect(sheet).toContain('基础扎实')
  })

  it('空节省略：无经历/证书/自评 → 不输出对应分节', () => {
    const empty: Resume = {
      meta: {},
      basics: { name: '李娜' },
      education: []
    }
    const sheet = renderSheet(empty)
    expect(sheet).toContain('<h1>李娜</h1>')
    expect(sheet).not.toContain('<h2>教育背景</h2>')
    expect(sheet).not.toContain('<h2>项目经历</h2>')
    expect(sheet).not.toContain('<h2>自我评价</h2>')
  })

  it('用户字段 HTML 转义（防注入/样式破坏）', () => {
    const evil: Resume = {
      meta: {},
      basics: { name: '<script>alert(1)</script>' },
      education: [],
      projects: [{ name: '"><img src=x onerror=alert(1)>', description: '<b>加粗</b>' }]
    }
    const sheet = renderSheet(evil)
    expect(sheet).not.toContain('<script>')
    expect(sheet).toContain('&lt;script&gt;')
    expect(sheet).toContain('&lt;b&gt;加粗&lt;/b&gt;')
  })
})

describe('dateRange / esc', () => {
  it('dateRange：YYYY-MM 归一为 YYYY.MM；无结束 → 至今；全缺 → 空串', () => {
    expect(dateRange('2022-09', '2026-06')).toBe('2022.09 ~ 2026.06')
    expect(dateRange('2022-09', null)).toBe('2022.09 ~ 至今')
    expect(dateRange('2022-09', '至今')).toBe('2022.09 ~ 至今')
    expect(dateRange(null, null)).toBe('')
    expect(dateRange(undefined, undefined)).toBe('')
  })

  it('esc 转义 & < > " \'', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})
