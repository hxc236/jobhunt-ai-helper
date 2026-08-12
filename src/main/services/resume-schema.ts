import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import resumeSchema from '../../shared/schema/resume.schema.json'

/**
 * resume.schema.json 校验器（F-12 / issue #19）。
 * 单一 schema（ADR-0003）覆盖基准简历与优化简历；主进程在入库前强制校验
 * （拒绝非法 JSON、防 LLM 幻觉字段入库）。校验器纯函数化：服务层抛错、
 * 渲染层（F-13）可复用同源 issue 定位错误。
 */

/** 单条校验问题：instancePath 为 JSON Pointer（如 /education/0/endDate），供错误定位。 */
export interface ResumeSchemaIssue {
  /** JSON Pointer 路径（'' 表示根） */
  instancePath: string
  keyword: string
  message?: string
}

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)
const validateResumeJson = ajv.compile(resumeSchema)

/** 校验 JSON；通过返回 []，否则返回全部问题（含定位路径）。 */
export function collectResumeSchemaIssues(value: unknown): ResumeSchemaIssue[] {
  if (validateResumeJson(value)) return []
  return (validateResumeJson.errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message
  }))
}

/** 校验失败时抛出：message 摘要首个问题，issues 带全量定位（F-13 校验错误定位用）。 */
export class ResumeValidationError extends Error {
  readonly issues: readonly ResumeSchemaIssue[]

  constructor(issues: readonly ResumeSchemaIssue[]) {
    const first = issues[0]
    const detail =
      first === undefined ? '未知错误' : `${first.instancePath === '' ? '/' : first.instancePath} ${first.message ?? first.keyword}`
    super(`简历 JSON 不符合 resume.schema.json（共 ${issues.length} 处）：${detail}`)
    this.name = 'ResumeValidationError'
    this.issues = issues
  }
}

/** 校验通过返回 void；不通过抛 ResumeValidationError。 */
export function assertValidResume(value: unknown): void {
  const issues = collectResumeSchemaIssues(value)
  if (issues.length > 0) throw new ResumeValidationError(issues)
}
