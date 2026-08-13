import { describe, expect, it } from 'vitest'
import { defaultBaseTitle, emptyResumeForm, formToResume, issueSection, keepEmptyRows, resumeToForm, type ResumeForm } from './resume-form'
import type { Resume } from '@shared/types/resume'

const sample: Resume = {
  meta: { title: '基准简历', baseResumeId: null, targetJobId: null },
  basics: {
    name: '张伟',
    phone: '138-0000-1234',
    email: 'zhangwei@example.com',
    location: '北京',
    birthday: '2004-06',
    gender: '男',
    politicalStatus: '共青团员',
    hometown: '河北石家庄',
    jobIntention: { position: '后端开发工程师（校招）', city: ['北京', '杭州'], salary: '面议' },
    links: [{ label: 'GitHub', url: 'https://github.com/zhangwei' }]
  },
  education: [
    {
      school: '北京理工大学',
      degree: '本科',
      major: '计算机科学与技术',
      startDate: '2022-09',
      endDate: '2026-06',
      gpa: '3.7/4.0',
      rank: '前 15%',
      courses: ['数据结构', '操作系统']
    }
  ],
  honors: ['校级一等奖学金（2024）'],
  skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
  projects: [
    {
      name: '校园二手交易平台',
      startDate: '2025-03',
      endDate: '2025-08',
      description: 'C2C 交易平台',
      techStack: ['Java', 'Spring Boot']
    }
  ],
  experience: [
    {
      company: '某互联网公司',
      title: '后端开发实习生',
      startDate: '2026-01',
      endDate: '2026-06',
      highlights: ['完成订单模块'],
      techStack: ['Java']
    }
  ],
  research: [
    {
      title: '基于 Transformer 的 NER 研究',
      startDate: '2025-03',
      endDate: '2025-09',
      description: '低资源场景 NER 迁移方法',
      achievement: '以第一作者发表 EI 论文一篇'
    }
  ],
  selfAssessment: '基础扎实'
}

describe('resumeToForm / formToResume 往返', () => {
  it('Resume → 表单态 → Resume 数据不丢失（多值数组经文本行承载）', () => {
    const resume = formToResume(resumeToForm(sample))
    expect(resume).toEqual(sample)
  })

  it('表单态可编辑：文本行（城市/课程/技术栈/能力段落）增删行后映射正确', () => {
    const form = resumeToForm(sample)
    form.basics.jobIntention.cityText = '北京\n上海\n'
    form.education[0]!.coursesText = '数据结构\n操作系统\n数据库原理'
    form.projects[0]!.techStackText = 'Java\nSpring Boot\nRedis'
    form.skills['工程能力'] = 'Java\nPython\nTypeScript'
    form.honorsText = '一等奖学金\n蓝桥杯省二等奖'

    const resume = formToResume(form)
    expect(resume.basics?.jobIntention?.city).toEqual(['北京', '上海'])
    expect(resume.education?.[0]?.courses).toEqual(['数据结构', '操作系统', '数据库原理'])
    expect(resume.projects?.[0]?.techStack).toEqual(['Java', 'Spring Boot', 'Redis'])
    expect(resume.skills?.[0]).toEqual({ category: '工程能力', text: 'Java\nPython\nTypeScript' })
    expect(resume.honors).toEqual(['一等奖学金', '蓝桥杯省二等奖'])
  })
})

describe('formToResume 归一化', () => {
  it('空串 → undefined；首尾空白去除；空行条目丢弃', () => {
    const form = emptyResumeForm()
    form.meta.title = ' 基准简历 '
    form.basics.name = ' 张伟 '
    form.basics.phone = ''
    form.basics.gender = ''
    form.basics.jobIntention.cityText = '  北京  , 杭州、深圳\n\n'
    form.education.push({ school: '   ', degree: '', major: '', startDate: '', endDate: '', gpa: '', rank: '', coursesText: '' })
    form.education.push({ school: '清华大学', degree: '硕士', major: '软件工程', startDate: '2026-09', endDate: '', gpa: '', rank: '', coursesText: '\n' })
    form.skills['工程能力'] = '  精通 Java 服务端开发  '
    form.skills['其他能力'] = '\n  \n'

    const resume = formToResume(form)

    expect(resume.meta?.title).toBe('基准简历')
    expect(resume.basics?.name).toBe('张伟')
    expect(resume.basics?.phone).toBeUndefined()
    expect(resume.basics?.gender).toBeUndefined()
    // 逗号/顿号不再拆分：整行作为一项（ADR-0009 取消自动分割）
    expect(resume.basics?.jobIntention?.city).toEqual(['北京  , 杭州、深圳'])
    // 全空的教育行丢弃；有效行保留（coursesText 全空 → 空数组）
    expect(resume.education).toHaveLength(1)
    expect(resume.education?.[0]).toMatchObject({ school: '清华大学', degree: '硕士' })
    expect(resume.education?.[0]?.courses).toEqual([])
    // 空分类不输出；有效分类映射为 分类+一段话
    expect(resume.skills).toEqual([{ category: '工程能力', text: '精通 Java 服务端开发' }])
  })

  it('国企字段映射：政治面貌/生源地/生日/性别/排名', () => {
    const form = resumeToForm(sample)
    form.basics.politicalStatus = '中共党员'
    form.basics.hometown = '四川绵阳'
    form.basics.birthday = '2003-11'
    form.basics.gender = '女'
    form.education[0]!.rank = '前 5%'

    const resume = formToResume(form)
    expect(resume.basics).toMatchObject({
      politicalStatus: '中共党员',
      hometown: '四川绵阳',
      birthday: '2003-11',
      gender: '女'
    })
    expect(resume.education?.[0]?.rank).toBe('前 5%')
  })

  it('照片字段映射：导入文件名随表单往返', () => {
    const form = resumeToForm({ ...sample, basics: { ...sample.basics, photo: 'abc.png' } })
    expect(form.basics.photo).toBe('abc.png')
    expect(formToResume(form).basics?.photo).toBe('abc.png')
    expect(emptyResumeForm().basics.photo).toBe('')
  })

  it('defaultBaseTitle：姓名-基准简历；空名返回空串', () => {
    expect(defaultBaseTitle(' 张伟 ')).toBe('张伟-基准简历')
    expect(defaultBaseTitle('   ')).toBe('')
    expect(defaultBaseTitle('')).toBe('')
  })
})

describe('issueSection 校验错误定位（F-13/#25 验收：保存时校验错误定位显示）', () => {
  it('分节 + 序号 + 字段中文标签', () => {
    expect(issueSection('/education/0/endDate')).toBe('教育经历 · 第1条 · 结束时间')
    expect(issueSection('/education/1/school')).toBe('教育经历 · 第2条 · 学校')
    expect(issueSection('/basics/name')).toBe('基本信息 · 姓名')
    expect(issueSection('/basics/politicalStatus')).toBe('基本信息 · 政治面貌')
    expect(issueSection('/projects/0/highlights/2')).toBe('项目经历 · 第1条 · 要点 · 第3条')
    expect(issueSection('/basics/jobIntention/position')).toBe('基本信息 · 求职意向 · 求职意向岗位')
    expect(issueSection('/basics/links/0/url')).toBe('基本信息 · 链接 · 第1条 · 链接地址')
    expect(issueSection('')).toBe('简历整体')
  })

  it('科研经历往返：标题/时间/研究内容/成果保留；空条目丢弃', () => {
    const form = resumeToForm(sample)
    expect(form.research).toHaveLength(1)
    expect(form.research[0]).toEqual({
      title: '基于 Transformer 的 NER 研究',
      startDate: '2025-03',
      endDate: '2025-09',
      description: '低资源场景 NER 迁移方法',
      achievement: '以第一作者发表 EI 论文一篇'
    })
    const back = formToResume(form)
    expect(back.research).toEqual(sample.research)

    // 表单归一化：trim、空串 → undefined；全空条目丢弃
    const cleaned = formToResume(
      resumeToForm({ ...sample, research: [{ title: '  课题A  ', description: '', achievement: '专利' }, { title: '', description: '', achievement: '' }] })
    )
    expect(cleaned.research).toEqual([{ title: '课题A', description: undefined, achievement: '专利' }])
  })

  it('issueSection：科研经历分节 + 字段中文标签', () => {
    expect(issueSection('/research/0/achievement')).toBe('科研经历 · 第1条 · 成果')
    expect(issueSection('/research/1/description')).toBe('科研经历 · 第2条 · 研究内容')
    expect(issueSection('/research/0/title')).toBe('科研经历 · 第1条 · 标题')
  })

  it('未知分节/字段回退原路径', () => {
    expect(issueSection('/unknownField/x')).toBe('unknownField · x')
  })
})

describe('keepEmptyRows（保存回填保留空行：自动保存不清掉刚添加的空表单）', () => {
  const formWithEmpty: ResumeForm = (() => {
    const f = resumeToForm(sample)
    f.projects.push({ name: '', startDate: '', endDate: '', description: '', techStackText: '' }) // 末尾空行
    f.experience.unshift({ company: '', title: '', startDate: '', endDate: '', highlightsText: '', techStackText: '' }) // 中间空行
    f.basics.links.push({ label: '', url: '' })
    return f
  })()

  it('空行保留在原位（末尾/中间），非空行被已保存内容替换', () => {
    const filled = resumeToForm(formToResume(formWithEmpty)) // 服务端回读（空行已被过滤）
    expect(filled.projects).toHaveLength(1)
    expect(filled.experience).toHaveLength(1)
    const merged = keepEmptyRows(formWithEmpty, filled)
    // 项目：非空行 + 末尾空行
    expect(merged.projects).toHaveLength(2)
    expect(merged.projects[1]).toEqual({ name: '', startDate: '', endDate: '', description: '', techStackText: '' })
    // 实习：中间空行保留在第 1 位，已填行在第 2 位（保序）
    expect(merged.experience).toHaveLength(2)
    expect(merged.experience[0].company).toBe('')
    expect(merged.experience[1].company).toBe('某互联网公司')
    // 空链接保留
    expect(merged.basics.links).toHaveLength(2)
    expect(merged.basics.links[1]).toEqual({ label: '', url: '' })
    // 非空行内容来自 filled（服务端归一结果）
    expect(merged.education).toEqual(filled.education)
  })

  it('全部空行时：filled 为空数组，空行全部保留', () => {
    const f = emptyResumeForm()
    f.projects.push({ name: '', startDate: '', endDate: '', description: '', techStackText: '' })
    const filled = resumeToForm(formToResume(f))
    expect(filled.projects).toHaveLength(0)
    const merged = keepEmptyRows(f, filled)
    expect(merged.projects).toHaveLength(1)
  })
})
