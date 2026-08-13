import type { Resume } from '@shared/types/resume'
import type { ResumeDraft } from '@shared/types'

/**
 * 上传草稿确认（F-16/#31）：解析草稿（F-14/#26 产出）→ 结构化简历 的转换纯函数。
 * - 草稿字段 → Resume：姓名/电话/邮箱/性别/生日/教育（学校/学历/专业/起止）/技能（单组）；
 * - 缺字段保持 undefined（提交时由服务端 resume.schema.json 校验兜底提示）；
 * - 确认前不调用任何入库接口（acceptance：确认前库中无数据）。
 */

/** 草稿 → 基准简历（meta.title 可指定；教育取第一条；技能单组「专业技能」）。 */
export function draftToResume(draft: ResumeDraft, title: string): Resume {
  const education = draft.fields.education
  const resume: Resume = {
    meta: { title: title.trim() === '' ? undefined : title.trim(), baseResumeId: null, targetJobId: null },
    basics: {
      name: draft.fields.name ?? '',
      phone: draft.fields.phone,
      email: draft.fields.email,
      gender: draft.fields.gender as Resume['basics']['gender'],
      birthday: draft.fields.birthday
    },
    education:
      education.length > 0
        ? [
            {
              school: education[0]!.school ?? '',
              degree: education[0]!.degree ?? '',
              major: education[0]!.major ?? '',
              startDate: education[0]!.period?.slice(0, 7),
              endDate: education[0]!.period?.includes('至今')
                ? null
                : education[0]!.period?.slice(-7)
            }
          ]
        : [],
    skills:
      draft.fields.skills.length > 0
        ? [{ category: '工程能力', text: draft.fields.skills.join('；') }]
        : []
  }
  return resume
}

/** 草稿缺失字段的中文提示（预览 UI 展示）。 */
export function draftWarnings(draft: ResumeDraft): string[] {
  const warnings: string[] = []
  if (draft.scanned) warnings.push('扫描件：未提取到文本，无法自动解析——建议手动新建基准简历')
  const label: Record<string, string> = {
    name: '姓名',
    phone: '电话',
    email: '邮箱',
    education: '教育经历'
  }
  for (const field of draft.missingFields) {
    warnings.push(`未识别到${label[field] ?? field}，请手动补全`)
  }
  if (draft.confidence < 0.75 && !draft.scanned) {
    warnings.push(`解析置信度较低（${Math.round(draft.confidence * 100)}%），请逐节核对`)
  }
  return warnings
}
