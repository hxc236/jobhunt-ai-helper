import type { Resume, ResumeEducation, ResumeProject, ResumeSkillGroup } from '@shared/types/resume'

/**
 * 简历编辑器表单态（F-13/#25）：与 Resume 同构，但文本类字段用空串表示未填、
 * 多值数组（城市/课程/荣誉/要点/技术栈等）在表单里以「每行一条」的文本承载（xxxText），
 * 提交时经 formToResume 归一为 Resume（trim、空串→undefined、行拆数组、过滤空行）。
 * 纯函数模块：不依赖 Vue，可单测（spec Testing Decisions：行为语义断言）。
 */

export interface ResumeForm {
  meta: { title: string; baseResumeId: string | null; targetJobId: string | null }
  basics: {
    name: string
    phone: string
    email: string
    /** 现居城市 */
    location: string
    /** YYYY-MM */
    birthday: string
    gender: '' | '男' | '女'
    /** 政治面貌（国企必填项） */
    politicalStatus: string
    /** 生源地（国企常用） */
    hometown: string
    jobIntention: { position: string; cityText: string; salary: string }
    /** GitHub / 博客 / 作品链接（增删行） */
    links: Array<{ label: string; url: string }>
  }
  education: Array<{
    school: string
    degree: string
    major: string
    startDate: string
    endDate: string
    gpa: string
    rank: string
    coursesText: string
    honorsText: string
  }>
  skills: Array<{ category: string; itemsText: string; proficiency: '' | '熟练' | '熟悉' | '了解' }>
  projects: Array<{
    name: string
    role: string
    startDate: string
    endDate: string
    description: string
    highlightsText: string
    techStackText: string
    link: string
  }>
  experience: Array<{
    company: string
    title: string
    startDate: string
    endDate: string
    highlightsText: string
    techStackText: string
  }>
  certificates: Array<{ name: string; issuer: string; date: string }>
  selfAssessment: string
}

/** 新建基准简历的初始表单态。 */
export function emptyResumeForm(): ResumeForm {
  return {
    meta: { title: '', baseResumeId: null, targetJobId: null },
    basics: {
      name: '',
      phone: '',
      email: '',
      location: '',
      birthday: '',
      gender: '',
      politicalStatus: '',
      hometown: '',
      jobIntention: { position: '', cityText: '', salary: '' },
      links: []
    },
    education: [],
    skills: [],
    projects: [],
    experience: [],
    certificates: [],
    selfAssessment: ''
  }
}

/** Resume → 表单态（undefined → 空串；数组 → 每行一条文本）。 */
export function resumeToForm(resume: Resume): ResumeForm {
  const form = emptyResumeForm()
  form.meta = {
    title: resume.meta?.title ?? '',
    baseResumeId: resume.meta?.baseResumeId ?? null,
    targetJobId: resume.meta?.targetJobId ?? null
  }
  const b = resume.basics ?? {}
  form.basics = {
    name: b.name ?? '',
    phone: b.phone ?? '',
    email: b.email ?? '',
    location: b.location ?? '',
    birthday: b.birthday ?? '',
    gender: b.gender ?? '',
    politicalStatus: b.politicalStatus ?? '',
    hometown: b.hometown ?? '',
    jobIntention: {
      position: b.jobIntention?.position ?? '',
      cityText: (b.jobIntention?.city ?? []).join('\n'),
      salary: b.jobIntention?.salary ?? ''
    },
    links: (b.links ?? []).map((l) => ({ label: l.label ?? '', url: l.url ?? '' }))
  }
  form.education = (resume.education ?? []).map((e) => ({
    school: e.school ?? '',
    degree: e.degree ?? '',
    major: e.major ?? '',
    startDate: e.startDate ?? '',
    endDate: e.endDate ?? '',
    gpa: e.gpa ?? '',
    rank: e.rank ?? '',
    coursesText: (e.courses ?? []).join('\n'),
    honorsText: (e.honors ?? []).join('\n')
  }))
  form.skills = (resume.skills ?? []).map((s) => ({
    category: s.category ?? '',
    itemsText: (s.items ?? []).join('\n'),
    proficiency: s.proficiency ?? ''
  }))
  form.projects = (resume.projects ?? []).map((p) => ({
    name: p.name ?? '',
    role: p.role ?? '',
    startDate: p.startDate ?? '',
    endDate: p.endDate ?? '',
    description: p.description ?? '',
    highlightsText: (p.highlights ?? []).join('\n'),
    techStackText: (p.techStack ?? []).join('\n'),
    link: p.link ?? ''
  }))
  form.experience = (resume.experience ?? []).map((x) => ({
    company: x.company ?? '',
    title: x.title ?? '',
    startDate: x.startDate ?? '',
    endDate: x.endDate ?? '',
    highlightsText: (x.highlights ?? []).join('\n'),
    techStackText: (x.techStack ?? []).join('\n')
  }))
  form.certificates = (resume.certificates ?? []).map((c) => ({
    name: c.name ?? '',
    issuer: c.issuer ?? '',
    date: c.date ?? ''
  }))
  form.selfAssessment = resume.selfAssessment ?? ''
  return form
}

/** 表单态 → Resume（trim；空串 → undefined；xxxText 行拆数组并过滤空行；空行对象丢弃）。 */
export function formToResume(form: ResumeForm): Resume {
  const b = form.basics
  const links = b.links
    .map((l) => ({ label: clean(l.label), url: clean(l.url) }))
    .filter((l) => l.label !== undefined || l.url !== undefined)

  const education: ResumeEducation[] = form.education
    .map((e) => ({
      school: e.school.trim(),
      degree: e.degree.trim(),
      major: e.major.trim(),
      startDate: clean(e.startDate),
      // schema：endDate 允许 string|null（应届未毕业）；空串 → null
      endDate: e.endDate.trim() === '' ? null : e.endDate.trim(),
      gpa: clean(e.gpa),
      rank: clean(e.rank),
      courses: splitLines(e.coursesText),
      honors: splitLines(e.honorsText)
    }))
    .filter(isNonEmptyEntry)

  const skills: ResumeSkillGroup[] = form.skills
    .map((s) => ({
      category: clean(s.category),
      items: splitLines(s.itemsText),
      proficiency: s.proficiency === '' ? undefined : s.proficiency
    }))
    .filter((s) => s.category !== undefined || s.items.length > 0)

  const projects: ResumeProject[] = form.projects
    .map((p) => ({
      name: clean(p.name),
      role: clean(p.role),
      startDate: clean(p.startDate),
      endDate: clean(p.endDate),
      description: clean(p.description),
      highlights: splitLines(p.highlightsText),
      techStack: splitLines(p.techStackText),
      link: p.link.trim() === '' ? null : p.link.trim()
    }))
    .filter(isNonEmptyEntry)

  const experience = form.experience
    .map((x) => ({
      company: clean(x.company),
      title: clean(x.title),
      startDate: clean(x.startDate),
      endDate: clean(x.endDate),
      highlights: splitLines(x.highlightsText),
      techStack: splitLines(x.techStackText)
    }))
    .filter(isNonEmptyEntry)

  const certificates = form.certificates
    .map((c) => ({ name: clean(c.name), issuer: clean(c.issuer), date: clean(c.date) }))
    .filter(isNonEmptyEntry)

  const resume: Resume = {
    meta: {
      title: clean(form.meta.title),
      baseResumeId: form.meta.baseResumeId,
      targetJobId: form.meta.targetJobId
    },
    basics: {
      name: b.name.trim(),
      phone: clean(b.phone),
      email: clean(b.email),
      location: clean(b.location),
      birthday: clean(b.birthday),
      gender: b.gender === '' ? undefined : b.gender,
      politicalStatus: clean(b.politicalStatus),
      hometown: clean(b.hometown),
      jobIntention: {
        position: clean(b.jobIntention.position),
        city: splitLines(b.jobIntention.cityText),
        salary: clean(b.jobIntention.salary)
      },
      links
    },
    education,
    skills,
    projects,
    experience,
    certificates,
    selfAssessment: clean(form.selfAssessment)
  }
  return resume
}

/** trim；空串 → undefined。 */
function clean(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 多值文本「每行一条」→ 数组（trim + 过滤空行；城市类字段同时兼容逗号分隔）。 */
function splitLines(text: string): string[] {
  return text
    .split(/[\n,，、]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 整行全空的条目（如用户新增未填的教育行）在提交时丢弃。 */
function isNonEmptyEntry(entry: Record<string, unknown>): boolean {
  return Object.values(entry).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== null && value !== ''
  })
}

/** 校验错误定位：JSON Pointer → 分节中文提示（渲染层展示「保存时校验错误定位」）。 */
const SECTION_LABELS: Record<string, string> = {
  basics: '基本信息',
  education: '教育经历',
  skills: '技能',
  projects: '项目经历',
  experience: '实习经历',
  certificates: '证书',
  selfAssessment: '自我评价'
}

const FIELD_LABELS: Record<string, string> = {
  name: '姓名',
  phone: '电话',
  email: '邮箱',
  location: '现居城市',
  birthday: '生日',
  gender: '性别',
  politicalStatus: '政治面貌',
  hometown: '生源地',
  position: '求职意向岗位',
  city: '期望城市',
  salary: '期望薪资',
  jobIntention: '求职意向',
  links: '链接',
  label: '链接名称',
  url: '链接地址',
  school: '学校',
  degree: '学历',
  major: '专业',
  startDate: '开始时间',
  endDate: '结束时间',
  gpa: '绩点',
  rank: '排名',
  courses: '相关课程',
  honors: '荣誉',
  category: '分类',
  items: '技能项',
  proficiency: '熟练度',
  role: '角色',
  description: '描述',
  highlights: '要点',
  techStack: '技术栈',
  link: '链接',
  company: '公司',
  title: '名称',
  issuer: '颁发机构',
  date: '日期'
}

/**
 * '/education/0/endDate' → '教育经历 第1条 · 结束时间'
 * '/basics/name' → '基本信息 · 姓名'
 * '/basics/jobIntention/position' → '基本信息 · 求职意向 · 求职意向岗位'
 */
export function issueSection(instancePath: string): string {
  const parts = instancePath.split('/').filter((p) => p !== '')
  if (parts.length === 0) return '简历整体'
  const [section, ...rest] = parts
  const label = SECTION_LABELS[section] ?? section
  const segments: string[] = []
  for (const part of rest) {
    if (/^\d+$/.test(part)) {
      segments.push(`第${Number(part) + 1}条`)
    } else if (part === 'jobIntention' || part === 'links') {
      segments.push(FIELD_LABELS[part] ?? part)
    } else {
      segments.push(FIELD_LABELS[part] ?? part)
    }
  }
  return segments.length === 0 ? label : `${label} · ${segments.join(' · ')}`
}
