/**
 * 简历实体类型（shared）— resume.schema.json 的结构镜像，单一 schema 覆盖
 * 基准简历与优化简历（派生稿），派生关系记在 meta（ADR-0003）。
 * 运行时校验以 resume.schema.json 为准（主进程 ajv 校验），本文件仅供类型安全。
 */

/** 导入溯源（#75：正式简历只保留简要溯源，不保存源文件/全文/诊断）。 */
export interface ResumeImportProvenance {
  /** 原文件名（不含路径）。 */
  fileName: string
  /** 源文件类型：docx / pdf。 */
  fileType: 'docx' | 'pdf'
  /** 导入时间（ISO 8601 date-time）。 */
  importedAt: string
  /** 解析路径：text（文本提取）/ ocr / mixed（混合）。 */
  parsePath: 'text' | 'ocr' | 'mixed'
}

export interface ResumeMeta {
  /** 简历 id（服务端生成；入库后必有，schema 层为可选） */
  id?: string
  /** 简历名，如「基准简历」/「华为-软件开发-优化稿」 */
  title?: string
  /** 派生自哪个基准简历（优化稿填写；基准简历为 null） */
  baseResumeId?: string | null
  /** 针对哪个职位卡优化（优化稿填写；基准简历为 null） */
  targetJobId?: string | null
  /** 最近更新时间（ISO 8601 date-time；服务端写入） */
  updatedAt?: string
  /** 导入溯源（仅导入创建的基准简历有；确认时服务端写入） */
  importedFrom?: ResumeImportProvenance
}

export interface ResumeJobIntention {
  position?: string
  city?: string[]
  salary?: string
}

export interface ResumeLink {
  label?: string
  url?: string
}

export interface ResumeBasics {
  name: string
  /** 照片文件名（存于应用照片目录，ADR-0009；A4 头部右侧显示） */
  photo?: string
  phone?: string
  email?: string
  /** 现居城市 */
  location?: string
  /** YYYY-MM */
  birthday?: string
  gender?: '男' | '女'
  /** 政治面貌：群众/团员/党员（国企必填项） */
  politicalStatus?: string
  /** 生源地（国企常用） */
  hometown?: string
  jobIntention?: ResumeJobIntention
  /** GitHub / 博客 / 作品链接 */
  links?: ResumeLink[]
}

export interface ResumeEducation {
  school: string
  /** 本科/硕士/博士 */
  degree: string
  major: string
  /** YYYY-MM */
  startDate?: string
  /** YYYY-MM；应届未毕业可留 null */
  endDate?: string | null
  /** 如 3.8/4.0 */
  gpa?: string
  /** 排名，如「前 10%」（国企看重） */
  rank?: string
  courses?: string[]
}

/** 能力分类（ADR-0009：固定三分类，每类一段话描述）。 */
export type SkillCategory = '工程能力' | '科研能力' | '其他能力'

export interface ResumeSkillGroup {
  category: SkillCategory
  /** 该分类的一段话描述 */
  text: string
}

export interface ResumeProject {
  /** 项目稳定 ID（内容优化引用；可选，向后兼容，未补时 undefined） */
  id?: string
  name?: string
  startDate?: string
  endDate?: string
  /** 一段话描述（ADR-0009：删除 角色/要点/链接；内容优化后保留作为要点起点） */
  description?: string
  /** 结构化要点（≤4 条；简介占 1 条，难点/个人工作量/结果可合并，技术栈单独展示不计条数） */
  highlights?: string[]
  /** 技术栈（匹配度计算依据；单独展示，不计入要点条数） */
  techStack?: string[]
}

export interface ResumeExperience {
  company?: string
  title?: string
  startDate?: string
  endDate?: string
  highlights?: string[]
  techStack?: string[]
}

export interface ResumeResearch {
  /** 研究课题标题 */
  title?: string
  startDate?: string
  endDate?: string
  /** 研究内容（一段话） */
  description?: string
  /** 成果（单条文本，如论文/专利） */
  achievement?: string
}

/** 简历 JSON（与 resume.schema.json 对齐；meta.id / meta.updatedAt 由服务端管理，输入可缺省）。 */
export interface Resume {
  meta: ResumeMeta
  basics: ResumeBasics
  education: ResumeEducation[]
  skills?: ResumeSkillGroup[]
  projects?: ResumeProject[]
  experience?: ResumeExperience[]
  /** 科研经历（标题/时间选填/研究内容/成果） */
  research?: ResumeResearch[]
  /** 竞赛与荣誉（顶层字段：从教育经历拆出，A4 单行·连接） */
  honors?: string[]
  /** 自我评价（可留空，优化稿生成） */
  selfAssessment?: string
  /** 模块顺序（内容优化：#91；A4 预览与对比遵循实际顺序；缺省按默认顺序渲染） */
  sectionOrder?: string[]
}

/** 入库后的简历：meta.id / meta.updatedAt 必填（服务端写入）。 */
export type StoredResume = Omit<Resume, 'meta'> & {
  meta: ResumeMeta & { id: string; updatedAt: string }
}

/** 可排序的简历节（A4 预览 / 对比 / sectionOrder 值的集合，ADR-0003 单一 schema）。 */
export const RESUME_SECTION_KEYS = [
  'basics',
  'education',
  'experience',
  'projects',
  'research',
  'honors',
  'skills',
  'selfAssessment'
] as const

export type ResumeSectionKey = (typeof RESUME_SECTION_KEYS)[number]

/** 默认模块顺序：头部 → 教育 → 实习 → 项目 → 科研 → 荣誉 → 技能 → 自评（用户定稿顺序）。 */
export const DEFAULT_SECTION_ORDER: readonly ResumeSectionKey[] = [
  'basics',
  'education',
  'experience',
  'projects',
  'research',
  'honors',
  'skills',
  'selfAssessment'
]

/**
 * 解析 sectionOrder → 完整顺序：去重、忽略非法值，缺失的节按默认顺序补到末尾。
 * 缺省/空 → 默认顺序。供 A4 渲染、DOCX 导出、对比视图共同遵循（#91）。
 */
export function resolveSectionOrder(sectionOrder?: readonly string[]): ResumeSectionKey[] {
  if (sectionOrder === undefined || sectionOrder.length === 0) return [...DEFAULT_SECTION_ORDER]
  const seen = new Set<ResumeSectionKey>()
  const order: ResumeSectionKey[] = []
  for (const key of sectionOrder) {
    const section = key as ResumeSectionKey
    if (RESUME_SECTION_KEYS.includes(section) && !seen.has(section)) {
      seen.add(section)
      order.push(section)
    }
  }
  for (const key of DEFAULT_SECTION_ORDER) {
    if (!seen.has(key)) {
      seen.add(key)
      order.push(key)
    }
  }
  return order
}
