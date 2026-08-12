/**
 * 简历实体类型（shared）— resume.schema.json 的结构镜像，单一 schema 覆盖
 * 基准简历与优化简历（派生稿），派生关系记在 meta（ADR-0003）。
 * 运行时校验以 resume.schema.json 为准（主进程 ajv 校验），本文件仅供类型安全。
 */

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
  honors?: string[]
}

export interface ResumeSkillGroup {
  /** 分类：编程语言/框架/工具/其他 */
  category?: string
  items?: string[]
  proficiency?: '熟练' | '熟悉' | '了解'
}

export interface ResumeProject {
  name?: string
  role?: string
  startDate?: string
  endDate?: string
  description?: string
  /** 要点，动词开头、量化优先 */
  highlights?: string[]
  /** 技术栈（匹配度计算依据） */
  techStack?: string[]
  link?: string | null
}

export interface ResumeExperience {
  company?: string
  title?: string
  startDate?: string
  endDate?: string
  highlights?: string[]
  techStack?: string[]
}

export interface ResumeCertificate {
  name?: string
  issuer?: string
  date?: string
}

/** 简历 JSON（与 resume.schema.json 对齐；meta.id / meta.updatedAt 由服务端管理，输入可缺省）。 */
export interface Resume {
  meta: ResumeMeta
  basics: ResumeBasics
  education: ResumeEducation[]
  skills?: ResumeSkillGroup[]
  projects?: ResumeProject[]
  experience?: ResumeExperience[]
  certificates?: ResumeCertificate[]
  /** 自我评价（可留空，优化稿生成） */
  selfAssessment?: string
}

/** 入库后的简历：meta.id / meta.updatedAt 必填（服务端写入）。 */
export type StoredResume = Omit<Resume, 'meta'> & {
  meta: ResumeMeta & { id: string; updatedAt: string }
}
