import type { Resume } from './types/resume'

/**
 * 规则匹配度评估（F-06/#27，ADR-0004 规则层）：纯函数、无 LLM 依赖
 * （LLM 不可用时仍可用，spec 分层降级）。
 *
 * - JD 关键词提取：英文技术词（别名归一化：Spring Boot/SpringBoot → Spring、
 *   Node.js → Node、React.js → React、Vue.js → Vue、AngularJS → Angular）+ 中文术语词表；
 * - 5 维度加权（关键词 25 / 技能 25 / 项目 20 / 经历 15 / 学历 15，0-100），
 *   每维度带命中依据（evidence）与缺失项（misses）；
 * - 空匹配语义：JD 无关键词 → 词面覆盖维度 100 分（无缺失项）；空简历 → 对应维度 0 分。
 */

export interface ScoreDimension {
  name: 'keywords' | 'skills' | 'projects' | 'experience' | 'education'
  /** 中文标签（UI 展示）。 */
  label: string
  /** 权重（百分制内）。 */
  weight: number
  /** 0-100。 */
  score: number
  /** 命中依据。 */
  evidence: string[]
  /** 缺失项。 */
  misses: string[]
}

export interface FitScore {
  total: number
  dimensions: ScoreDimension[]
}

/** 别名归一化：JD/简历中的常见写法 → 规范名（匹配与展示统一）。 */
const ALIAS_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bSpring\s*Boot\b/gi, 'Spring'],
  [/\bSpringBoot\b/gi, 'Spring'],
  [/\bNode\.?js\b/gi, 'Node'],
  [/\bReact\.?js\b/gi, 'React'],
  [/\bVue\.?js\b/gi, 'Vue'],
  [/\bAngular\s*JS\b/gi, 'Angular'],
  [/\bTypeScript\b/gi, 'TypeScript'],
  [/\bJavaScript\b/gi, 'JavaScript']
]

/** 常见英文停用词（非技术词，过滤噪声）。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'you', 'your', 'our', 'will', 'have', 'has',
  'can', 'all', 'any', 'etc', 'not', 'are', 'was', 'but', 'this', 'that', 'who',
  'what', 'which', 'more', 'than', 'able', 'work', 'team', 'good', 'strong', 'skill',
  'skills', 'experience', 'ability', 'knowledge', 'familiar', 'master', 'proficient',
  'preferred', 'plus', 'requirement', 'requirements', 'require', 'required'
])

/** 中文术语词表（无分词库的轻量提取；覆盖校招 JD 高频计算机术语）。 */
const CJK_DICT = [
  '数据结构', '操作系统', '计算机网络', '数据库', '分布式', '微服务', '高并发',
  '机器学习', '深度学习', '自然语言处理', '计算机视觉', '消息队列', '缓存', '容器',
  '前端', '后端', '全栈', '测试', '运维', '安全', '云计算', '大数据', '嵌入式',
  '音视频', '推荐系统', '搜索引擎', '爬虫', '数据分析', '并发编程', '网络编程',
  '软件工程', '计算机基础', '物联网', '区块链', '虚拟化'
]

/** 单关键词别名归一化（如 'Spring Boot' → 'Spring'）。 */
export function normalizeKeyword(keyword: string): string {
  let result = keyword.trim()
  for (const [pattern, replacement] of ALIAS_RULES) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * JD 关键词提取：先对全文做别名归一化，再提取英文技术词（去停用词/纯数字）+
 * 中文词表术语；去重（大小写不敏感，保留首次出现的大小写）。
 */
export function extractKeywords(jd: string): string[] {
  const normalizedText = normalizeKeyword(jd)
  const seen = new Set<string>()
  const keywords: string[] = []

  const push = (keyword: string): void => {
    const key = keyword.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    keywords.push(keyword)
  }

  for (const match of normalizedText.matchAll(/[A-Za-z][A-Za-z0-9+#.]{1,}/g)) {
    const token = match[0]
    if (STOPWORDS.has(token.toLowerCase())) continue
    if (/^\d+$/.test(token)) continue
    push(token)
  }
  for (const term of CJK_DICT) {
    if (normalizedText.includes(term)) push(term)
  }
  return keywords
}

/** 评分维度权重（ADR-0004：关键词25/技能25/项目20/经历15/学历15）。 */
const DIMENSIONS: ReadonlyArray<{ name: ScoreDimension['name']; label: string; weight: number }> = [
  { name: 'keywords', label: '关键词覆盖', weight: 25 },
  { name: 'skills', label: '技能匹配', weight: 25 },
  { name: 'projects', label: '项目相关', weight: 20 },
  { name: 'experience', label: '经历相关', weight: 15 },
  { name: 'education', label: '学历专业', weight: 15 }
]

/**
 * 规则打分：JD 关键词 × 简历各节文本覆盖。
 * 空匹配语义：JD 无关键词 → 词面覆盖维度 100（无缺失项）；空简历 → 对应维度 0 并给缺失依据。
 */
export function score(input: { jd: string; resume: Resume }): FitScore {
  const { jd, resume } = input
  const keywords = extractKeywords(jd)

  const sections = resumeSections(resume)
  const hitMap = new Map<string, string[]>() // keyword → 命中的节名
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase()
    for (const [sectionName, text] of Object.entries(sections)) {
      if (text.toLowerCase().includes(needle)) {
        const hits = hitMap.get(keyword) ?? []
        hits.push(sectionName)
        hitMap.set(keyword, hits)
      }
    }
  }

  const dimensions: ScoreDimension[] = DIMENSIONS.map((dim) =>
    dim.name === 'education'
      ? educationDimension(dim.label, dim.weight, jd, resume)
      : coverageDimension(dim.name, dim.label, dim.weight, keywords, hitMap, sections)
  )

  const total = Math.round(
    dimensions.reduce((sum, d) => sum + (d.score * d.weight) / 100, 0)
  )
  return { total, dimensions }
}

/** 简历各节可检索文本（别名归一化后小写比较在调用处完成）。 */
function resumeSections(resume: Resume): Record<string, string> {

  const basics = resume.basics ?? {}
  const skills = (resume.skills ?? [])
    .map((s) => [s.category, s.text].join(' '))
    .join(' ')
  const projects = (resume.projects ?? [])
    .map((p) =>
      [
        p.name, p.description,
        ...(p.techStack ?? [])
      ]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
    )
    .join(' ')
  const experience = (resume.experience ?? [])
    .map((x) =>
      [x.company, x.title, ...(x.highlights ?? []), ...(x.techStack ?? [])]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
    )
    .join(' ')
  const education = (resume.education ?? [])
    .map((e) => [e.school, e.degree, e.major, e.gpa, e.rank, ...(e.courses ?? []), ...(e.honors ?? [])].join(' '))
    .join(' ')

  return {
    basics: [basics.name, basics.phone, basics.email, basics.location, basics.hometown].join(' '),
    skills,
    projects,
    experience,
    education
  }
}

/** 词面覆盖维度（keywords/skills/projects/experience）：JD 关键词在该节文本中的命中比例。 */
function coverageDimension(
  name: ScoreDimension['name'],
  label: string,
  weight: number,
  keywords: string[],
  hitMap: Map<string, string[]>,
  sections: Record<string, string>
): ScoreDimension {
  const sectionNames: Record<string, string[]> = {
    keywords: Object.keys(sections),
    skills: ['skills'],
    projects: ['projects'],
    experience: ['experience']
  }
  const searchSections = sectionNames[name]

  // 该维度可检索文本为空 → 0 分（空简历边界）
  const hasContent = searchSections.some((s) => sections[s].trim() !== '')
  if (!hasContent) {
    return {
      name,
      label,
      weight,
      score: 0,
      evidence: [],
      misses: name === 'education' ? [] : keywords.length > 0 ? [...keywords] : ['简历该部分为空']
    }
  }

  if (keywords.length === 0) {
    return { name, label, weight, score: 100, evidence: ['JD 无关键词可匹配'], misses: [] }
  }

  const matched = keywords.filter((kw) => (hitMap.get(kw) ?? []).some((s) => searchSections.includes(s)))
  const misses = keywords.filter((kw) => !matched.includes(kw))
  const scoreValue = Math.round((matched.length / keywords.length) * 100)
  return {
    name,
    label,
    weight,
    score: scoreValue,
    evidence: matched.length > 0 ? [...matched] : ['无命中'],
    misses
  }
}

/** 学历维度：JD 学历要求（博士>硕士>本科）vs 简历最高学历。 */
function educationDimension(
  label: string,
  weight: number,
  jd: string,
  resume: Resume
): ScoreDimension {
  const levels = ['博士', '硕士', '本科'] as const
  const required = levels.find((level) => jd.includes(level))
  const resumeDegrees = (resume.education ?? []).map((e) => e.degree ?? '')
  const maxLevel = levels.find((level) => resumeDegrees.some((d) => d.includes(level)))

  if (required === undefined) {
    return { name: 'education', label, weight, score: 100, evidence: ['JD 未要求学历'], misses: [] }
  }
  if (maxLevel === undefined) {
    return {
      name: 'education',
      label,
      weight,
      score: 0,
      evidence: [],
      misses: ['无学历信息']
    }
  }
  const requiredIdx = levels.indexOf(required)
  const resumeIdx = levels.indexOf(maxLevel)
  if (resumeIdx <= requiredIdx) {
    return {
      name: 'education',
      label,
      weight,
      score: 100,
      evidence: [`最高学历：${maxLevel}（满足 JD 要求 ${required}及以上）`],
      misses: []
    }
  }
  return {
    name: 'education',
    label,
    weight,
    score: 60,
    evidence: [`最高学历：${maxLevel}`],
    misses: [`学历未达要求：JD 要求 ${required}及以上，简历最高 ${maxLevel}`]
  }
}
