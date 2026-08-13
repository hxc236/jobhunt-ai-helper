import { describe, expect, it } from 'vitest'
import { extractKeywords, normalizeKeyword, score } from './score'
import type { Resume } from './types/resume'

/** 基准样例简历：技能/项目/经历/学历齐全。 */
const fullResume: Resume = {
  meta: { title: '基准' },
  basics: { name: '张伟' },
  education: [
    {
      school: '北京理工大学',
      degree: '本科',
      major: '计算机科学与技术',
      startDate: '2022-09',
      endDate: '2026-06',
      courses: ['数据结构', '操作系统']
    }
  ],
  skills: [
    { category: '工程能力', text: 'Java、Python、TypeScript 服务端开发，Spring Boot、MyBatis、Redis、Kafka 中间件；Docker、Git、Linux 部署工具链。' },
    { category: '科研能力', text: '蓝桥杯省二等奖，算法与竞赛编程基础。' },
    { category: '其他能力', text: 'CET-6，可阅读英文技术文档。' }
  ],
  projects: [
    {
      name: '校园二手交易平台',
      description: 'C2C 交易平台',
      techStack: ['Java', 'Spring Boot', 'Redis', 'MySQL', 'Docker']
    }
  ],
  experience: [
    {
      company: '某互联网公司',
      title: '后端开发实习生',
      highlights: ['完成订单模块开发', '优化接口响应'],
      techStack: ['Java', 'Spring Boot']
    }
  ],
  selfAssessment: '基础扎实，热爱后端技术'
}

const fullJd = `
岗位：后端开发工程师（校招）
要求：
- 熟练掌握 Java、Spring Boot、MySQL、Redis，了解 Kafka、Docker
- 扎实的计算机基础：数据结构、操作系统、计算机网络
- 有分布式、高并发项目经验者优先
- 本科及以上学历，计算机相关专业
`

describe('extractKeywords JD 关键词提取（F-06/#27）', () => {
  it('提取英文技术词 + 中文词表术语，去重', () => {
    const keywords = extractKeywords(fullJd)
    expect(keywords).toEqual(
      expect.arrayContaining(['Java', 'Spring', 'MySQL', 'Redis', 'Kafka', 'Docker'])
    )
    expect(keywords).toEqual(
      expect.arrayContaining(['数据结构', '操作系统', '计算机网络', '分布式', '高并发'])
    )
    expect(keywords).toEqual([...new Set(keywords)]) // 去重
  })

  it('别名归一化：Spring Boot → Spring；SpringBoot 连写同样归一', () => {
    expect(normalizeKeyword('Spring Boot')).toBe('Spring')
    expect(normalizeKeyword('SpringBoot')).toBe('Spring')
    expect(extractKeywords('要求熟悉 Spring Boot 与 Node.js')).toEqual(
      expect.arrayContaining(['Spring', 'Node'])
    )
  })

  it('JD 无关键词 → 空数组（打分维度空匹配语义）', () => {
    expect(extractKeywords('招人，待遇好，快来')).toEqual([])
  })
})

describe('ScoreEngine 边界（F-06/#27 验收）', () => {
  it('空简历不抛错：学历/技能/项目/经历维度 0 分，关键词维度按 JD 覆盖计算', () => {
    const empty: Resume = { meta: {}, basics: { name: '' }, education: [] }
    const result = score({ jd: fullJd, resume: empty })

    expect(result.total).toBeTypeOf('number')
    expect(result.dimensions).toHaveLength(5)
    const byName = Object.fromEntries(result.dimensions.map((d) => [d.name, d]))
    expect(byName.education.score).toBe(0)
    expect(byName.skills.score).toBe(0)
    expect(byName.projects.score).toBe(0)
    expect(byName.experience.score).toBe(0)
    expect(byName.education.misses).toContain('无学历信息')
  })

  it('JD 无关键词：关键词/技能/项目/经历维度空匹配语义 = 100 分（无缺失项）', () => {
    const result = score({ jd: '招人', resume: fullResume })
    const byName = Object.fromEntries(result.dimensions.map((d) => [d.name, d]))
    expect(byName.keywords.score).toBe(100)
    expect(byName.skills.score).toBe(100)
    expect(byName.projects.score).toBe(100)
    expect(byName.experience.score).toBe(100)
    expect(byName.keywords.misses).toEqual([])
  })

  it('JD 关键词全命中 → keywords 维度 100；其余维度按各自节覆盖计分，总分与依据一致', () => {
    // 6 个关键词均可在简历某节命中（Java/Spring/Kafka/Docker/Python 在技能，数据结构在课程）
    const jd = '要求：Java、Spring Boot、Kafka、Docker、Python、数据结构'
    const result = score({ jd, resume: fullResume })
    const byName = Object.fromEntries(result.dimensions.map((d) => [d.name, d]))

    expect(byName.keywords.score).toBe(100)
    expect(byName.keywords.misses).toEqual([])
    // 技能节含 5/6（数据结构不在技能）→ 83；项目节 3/6 → 50；经历节 2/6 → 33；JD 无学历要求 → 100
    expect(byName.skills.score).toBe(83)
    expect(byName.projects.score).toBe(50)
    expect(byName.experience.score).toBe(33)
    expect(byName.education.score).toBe(100)
    expect(result.total).toBe(76) // round((100*25+83*25+50*20+33*15+100*15)/100)
  })
})

describe('ScoreEngine 5 维度加权与依据清单（F-06/#27）', () => {
  it('权重：关键词25/技能25/项目20/经历15/学历15', () => {
    const result = score({ jd: fullJd, resume: fullResume })
    const weights = Object.fromEntries(result.dimensions.map((d) => [d.name, d.weight]))
    expect(weights).toEqual({ keywords: 25, skills: 25, projects: 20, experience: 15, education: 15 })
  })

  it('关键词维度：命中/缺失依据清单与分数一致（半命中）', () => {
    const jd = '要求：Java、Golang、Redis、Kubernetes、数据结构'
    const result = score({ jd, resume: fullResume })
    const kw = result.dimensions.find((d) => d.name === 'keywords')
    expect(kw).toBeDefined()
    // Java/Redis/数据结构 命中；Golang/Kubernetes 缺失 → 3/5 = 60
    expect(kw!.score).toBe(60)
    expect(kw!.evidence).toEqual(expect.arrayContaining(['Java', 'Redis', '数据结构']))
    expect(kw!.misses).toEqual(['Golang', 'Kubernetes'])
  })

  it('技能维度：JD 关键词在 skills 中的覆盖（含别名归一：Spring Boot 命中 Spring）', () => {
    const jd = '要求：Spring Boot、Kafka、Python'
    const result = score({ jd, resume: fullResume })
    const skills = result.dimensions.find((d) => d.name === 'skills')
    expect(skills!.score).toBe(100)
    expect(skills!.evidence).toEqual(expect.arrayContaining(['Spring', 'Kafka', 'Python']))
  })

  it('项目/经历维度：JD 关键词在项目技术栈与实习经历中的覆盖', () => {
    const jd = '要求：Java、Redis、MySQL、分布式、高并发'
    const result = score({ jd, resume: fullResume })
    const projects = result.dimensions.find((d) => d.name === 'projects')
    const experience = result.dimensions.find((d) => d.name === 'experience')
    // Java/Redis/MySQL 在项目 techStack → 3/5=60；分布式/高并发缺失
    expect(projects!.score).toBe(60)
    expect(projects!.misses).toEqual(['分布式', '高并发'])
    // 经历：仅 Java 命中 → 1/5=20
    expect(experience!.score).toBe(20)
    expect(experience!.misses).toEqual(['Redis', 'MySQL', '分布式', '高并发'])
  })

  it('学历维度：JD 要求硕士 + 简历本科 → 降分；要求本科 → 100', () => {
    const masterJd = '硕士及以上学历，计算机相关专业'
    const bachelorJd = '本科及以上学历'
    const masterResume: Resume = {
      ...fullResume,
      education: [
        ...fullResume.education!,
        { school: '清华大学', degree: '硕士', major: '软件工程' }
      ]
    }
    const r1 = score({ jd: masterJd, resume: fullResume })
    const r2 = score({ jd: bachelorJd, resume: fullResume })
    const r3 = score({ jd: masterJd, resume: masterResume })
    expect(r1.dimensions.find((d) => d.name === 'education')!.score).toBeLessThan(100)
    expect(r2.dimensions.find((d) => d.name === 'education')!.score).toBe(100)
    expect(r3.dimensions.find((d) => d.name === 'education')!.score).toBe(100)
  })

  it('总分为各维度加权和（round）', () => {
    const jd = '要求：Java、Redis、分布式'
    const result = score({ jd, resume: fullResume })
    const weighted = result.dimensions.reduce((sum, d) => sum + (d.score * d.weight) / 100, 0)
    expect(result.total).toBe(Math.round(weighted))
  })
})
