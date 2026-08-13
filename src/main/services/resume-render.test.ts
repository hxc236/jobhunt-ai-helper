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
    }
  ],
  honors: ['一等奖学金', '蓝桥杯省二等奖'],
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
  selfAssessment: '基础扎实'
}

describe('resume-render A4 模板（F-15/#30）', () => {
  it('完整文档：A4 sheet + 打印样式（@media print）+ 全分节渲染', () => {
    const html = renderResumeHtml(sample)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('class="sheet"')
    expect(html).toContain('@media print')
    expect(html).toContain('width: 794px') // A4 宽度
    // 基本信息纯值排列：分隔符由 CSS 伪元素提供（flex 换行时行首无前导分隔符）
    expect(html).toContain(".fact + .fact::before { content: ' | '")
  })

  it('分节顺序：教育 → 实习 → 项目 → 科研 → 竞赛荣誉 → 技能 → 自我评价', () => {
    const sheet = renderSheet({
      ...sample,
      research: [{ title: '某课题' }]
    })
    const headings = [...sheet.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])
    expect(headings).toEqual(['教育背景', '实习经历', '项目经历', '科研经历', '竞赛与荣誉', '技能和其他', '自我评价'])
  })

  it('科研经历：标题+时间、研究内容、成果（成果单条文本）', () => {
    const sheet = renderSheet({
      ...sample,
      research: [
        {
          title: '基于 Transformer 的命名实体识别研究',
          startDate: '2025-03',
          endDate: '2025-09',
          description: '研究低资源场景下 NER 的迁移方法，提出数据增强策略。',
          achievement: '以第一作者发表 EI 论文一篇'
        }
      ]
    })
    expect(sheet).toContain('<h2>科研经历</h2>')
    expect(sheet).toContain('基于 Transformer 的命名实体识别研究')
    expect(sheet).toContain('2025.03 ~ 2025.09')
    expect(sheet).toContain('研究低资源场景下 NER 的迁移方法，提出数据增强策略。')
    expect(sheet).toContain('成果：以第一作者发表 EI 论文一篇')
  })

  it('科研经历空条目不渲染；时间缺省时不显示时间', () => {
    const sheet = renderSheet({
      ...sample,
      research: [{ title: '未定题研究', description: '', achievement: '' }]
    })
    expect(sheet).toContain('<h2>科研经历</h2>')
    expect(sheet).toContain('未定题研究')
    expect(sheet).not.toContain('-至今')
  })

  it('科研经历标题为空但内容非空：内容不进 entry-head（布局正确）', () => {
    const sheet = renderSheet({
      ...sample,
      research: [{ title: '', description: '只有研究内容', achievement: '' }]
    })
    expect(sheet).toContain('<h2>科研经历</h2>')
    expect(sheet).not.toMatch(/entry-head"><span><div class="desc"/)
    expect(sheet).toMatch(/<div class="entry"><div class="entry-head"><span><\/span>/)
    expect(sheet).toContain('只有研究内容')
  })

  it('科研经历标题/内容/成果均空 → 整节省略', () => {
    const sheet = renderSheet({ ...sample, research: [{ title: '', description: '', achievement: '' }] })
    expect(sheet).not.toContain('科研经历')
  })

  it('分节渲染：基本信息/意向/链接/教育/技能/项目/经历/证书/自评齐全', () => {
    const sheet = renderSheet(sample)
    expect(sheet).toContain('<h1>张伟</h1>')
    // 基本信息：纯值无字段名（电话/邮箱/性别/生日/政治面貌/生源地…），flex 自适应排列
    expect(sheet).not.toContain('class="k"')
    const factsBlock = sheet.match(/<div class="facts">([\s\S]*?)<\/div>/)?.[1]
    expect(factsBlock).toContain('<span class="fact">13800001234</span>')
    expect(factsBlock).toContain('<span class="fact">z@example.com</span>')
    expect(factsBlock).toContain('<span class="fact">男</span>')
    // 顺序：电话 → 邮箱 → 性别 → 生日 → 政治面貌 → 生源地
    let last = -1
    for (const v of ['13800001234', 'z@example.com', '男', '2004-06', '共青团员', '河北石家庄']) {
      const i = factsBlock?.indexOf(`>${v}<`) ?? -1
      expect(i).toBeGreaterThan(last)
      last = i
    }
    expect(sheet).toContain('求职意向：后端开发工程师（校招）')
    expect(sheet).toContain('https://github.com/z')
    for (const heading of ['教育背景', '实习经历', '项目经历', '竞赛与荣誉', '技能和其他', '自我评价']) {
      expect(sheet).toContain(`<h2>${heading}</h2>`)
    }
    // 节顺序（用户定稿）：教育 → 实习 → 项目 → 科研 → 荣誉 → 技能 → 自我评价
    expect(sheet.indexOf('<h2>教育背景</h2>')).toBeLessThan(sheet.indexOf('<h2>实习经历</h2>'))
    expect(sheet.indexOf('<h2>实习经历</h2>')).toBeLessThan(sheet.indexOf('<h2>项目经历</h2>'))
    expect(sheet.indexOf('<h2>竞赛与荣誉</h2>')).toBeGreaterThan(sheet.indexOf('<h2>项目经历</h2>'))
    expect(sheet.indexOf('<h2>竞赛与荣誉</h2>')).toBeLessThan(sheet.indexOf('<h2>技能和其他</h2>'))
    // 荣誉从教育经历中移出，聚合为「竞赛与荣誉」单行 · 连接
    expect(sheet).not.toContain('荣誉：')
    expect(sheet).toContain('一等奖学金<span class="dot">·</span>蓝桥杯省二等奖')
    // 技能节在自我评价之前（用户定稿顺序）
    expect(sheet.indexOf('<h2>技能和其他</h2>')).toBeLessThan(sheet.indexOf('<h2>自我评价</h2>'))
    expect(sheet).toContain('北京理工大学　本科 · 计算机科学与技术')
    expect(sheet).toContain('GPA 3.7/4.0')
    // 课程标签行内
    expect(sheet).toContain('相关课程：<span class="tag">数据结构</span>')
    expect(sheet).toContain('工程能力')
    expect(sheet).toContain('Java、Python 服务端开发')
    expect(sheet).toContain('<span class="tag">Java</span>')
    expect(sheet).toContain('某公司　<em>实习生</em>')
    // 证书栏不再渲染（用户定稿：A4 不展示证书）
    expect(sheet).not.toContain('<h2>证书</h2>')
    expect(sheet).not.toContain('CET-6')
    expect(sheet).toContain('基础扎实')
  })

  it('照片：提供 data URI → 头部右侧照片位；缺省不渲染照片位（布局不塌）', () => {
    const withPhoto = renderSheet(sample, 'data:image/png;base64,AAAA')
    expect(withPhoto).toContain('<div class="photo"><img src="data:image/png;base64,AAAA" alt="照片" /></div>')
    expect(withPhoto).toContain('<div class="head">')

    const without = renderSheet(sample)
    expect(without).not.toContain('class="photo"')
    expect(without).toContain('<h1>张伟</h1>')
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
    expect(sheet).not.toContain('<h2>竞赛与荣誉</h2>')
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
