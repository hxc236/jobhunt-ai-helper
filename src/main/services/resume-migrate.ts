import type { Db } from '../db/migrations'
import type { Resume, ResumeEducation, ResumeProject, ResumeSkillGroup } from '../../shared/types/resume'

/**
 * 旧模型 → v2 一次性数据迁移（ADR-0009 / wayfinder「简历模块可用」）。
 * - 技能：旧自由分类条目（items/proficiency）合并为「工程能力」一段话（保留分类名与条目信息）；
 * - 项目：裁剪 role/highlights/link，保留 name/startDate/endDate/description/techStack；
 * - 幂等：按形状检测（含旧字段才转换），重复执行无副作用；启动时调用一次（main/index.ts）。
 */

interface LegacySkillGroup {
  category?: string
  items?: string[]
  proficiency?: string
}

interface LegacyProject {
  name?: string
  role?: string
  startDate?: string
  endDate?: string
  description?: string
  highlights?: string[]
  techStack?: string[]
  link?: string | null
}

interface LegacyEducation {
  school?: string
  degree?: string
  major?: string
  startDate?: string
  endDate?: string | null
  gpa?: string
  rank?: string
  courses?: string[]
  honors?: string[]
}

type LegacyResume = Omit<Resume, 'skills' | 'projects' | 'education'> & {
  education?: LegacyEducation[]
  skills?: LegacySkillGroup[]
  projects?: LegacyProject[]
  certificates?: Array<{ name?: string; issuer?: string; date?: string }>
}

/** 形状检测：技能 items/proficiency、项目 role/highlights/link、certificates、教育条目带 honors → 旧结构。 */
export function isLegacyResume(value: unknown): value is LegacyResume {
  if (typeof value !== 'object' || value === null) return false
  const resume = value as Partial<LegacyResume>
  const legacySkill = (resume.skills ?? []).some(
    (s) => Array.isArray(s.items) || s.proficiency !== undefined
  )
  const legacyProject = (resume.projects ?? []).some(
    (p) => p.role !== undefined || Array.isArray(p.highlights) || p.link !== undefined
  )
  const legacyHonors = (resume.education ?? []).some((e) => Array.isArray(e.honors))
  return legacySkill || legacyProject || Array.isArray(resume.certificates) || legacyHonors
}

/** 旧结构 → v2：技能条目合并为「工程能力」一段话（格式：分类：条目、条目；…）；项目裁剪。 */
export function transformLegacyResume(legacy: LegacyResume): Resume {
  const skills: ResumeSkillGroup[] = []
  if (Array.isArray(legacy.skills) && legacy.skills.length > 0) {
    const text = legacy.skills
      .map((s) => {
        const category = s.category === undefined ? '' : s.category
        const items = (s.items ?? []).join('、')
        return items === '' ? '' : `${category}：${items}`
      })
      .filter((part) => part !== '')
      .join('；')
    if (text !== '') skills.push({ category: '工程能力', text })
  }

  const projects: ResumeProject[] = (legacy.projects ?? []).map((p) => ({
    name: p.name,
    startDate: p.startDate,
    endDate: p.endDate,
    description: p.description,
    techStack: p.techStack
  }))

  // 荣誉：教育条目 → 顶层聚合（从教育经历拆出），并从教育条目剥离
  const honors = (legacy.education ?? []).flatMap((e) => e.honors ?? [])
  const education = (legacy.education ?? []).map(
    ({ honors: _dropped, ...rest }) => rest as ResumeEducation
  )

  // 证书字段已从模型移除（用户定稿）——旧数据一并剥离
  const { certificates: _droppedCert, ...rest } = legacy
  return { ...rest, education, skills, projects, honors }
}

/** 扫描 resumes 表并转换旧结构行；返回转换行数（幂等：重复调用返回 0）。 */
export function migrateLegacyResumes(db: Db): number {
  const rows = db.prepare('SELECT id, json FROM resumes').all() as Array<{ id: string; json: string }>
  let migrated = 0
  for (const row of rows) {
    const parsed: unknown = JSON.parse(row.json)
    if (!isLegacyResume(parsed)) continue
    const next = transformLegacyResume(parsed)
    db.prepare('UPDATE resumes SET json = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      JSON.stringify(next),
      row.id
    )
    migrated++
  }
  return migrated
}
