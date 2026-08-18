import { randomUUID } from 'node:crypto'
import type { Db } from '../db/migrations'
import type { Resume, ResumeImportProvenance, StoredResume } from '../../shared/types/resume'
import { PhotoStoreError, type PhotoStore } from './photo-store'
import { assertValidResume } from './resume-schema'
import { renderResumeHtml } from './resume-render'

const LIST = 'SELECT json FROM resumes ORDER BY created_at, id'
const GET = 'SELECT json FROM resumes WHERE id = ?'
const INSERT = `
  INSERT INTO resumes (id, json, base_resume_id, target_job_id, updated_at)
  VALUES (@id, @json, @baseResumeId, @targetJobId, @updatedAt)
`
const UPDATE = `
  UPDATE resumes
  SET json = @json, base_resume_id = @baseResumeId, target_job_id = @targetJobId, updated_at = @updatedAt
  WHERE id = @id
`
const DELETE = 'DELETE FROM resumes WHERE id = ?'

/** 目标简历不存在（get/update/delete 时）。 */
export class ResumeNotFoundError extends Error {
  constructor(id: string) {
    super(`简历不存在：${id}`)
    this.name = 'ResumeNotFoundError'
  }
}

interface ResumeRowParams {
  id: string
  json: string
  baseResumeId: string | null
  targetJobId: string | null
  updatedAt: string
}

/** 冗余列与 json 本体同源：以 meta 为准（服务是唯一写入口，避免双源漂移）。 */
function toRowParams(stored: StoredResume): ResumeRowParams {
  return {
    id: stored.meta.id,
    json: JSON.stringify(stored),
    baseResumeId: stored.meta.baseResumeId ?? null,
    targetJobId: stored.meta.targetJobId ?? null,
    updatedAt: stored.meta.updatedAt
  }
}

function parseStored(json: string): StoredResume {
  // json 列有 json_valid CHECK 约束，库内必然是合法 JSON；schema 校验由服务层保证
  return JSON.parse(json) as StoredResume
}

/**
 * resumes 表访问层（F-12 / issue #19）。
 * - 入库前强制 resume.schema.json 校验（拒绝非法 JSON，防幻觉字段入库）；
 * - 服务端管理 meta.id / meta.updatedAt：create 生成 id，update 保持行 id 并刷新 updatedAt；
 * - 多份基准简历可建/改/删；删除语义：派生稿是独立副本——删除基准不影响已存派生稿
 *   （无外键约束，meta.baseResumeId 仅为派生关系标记）。
 */
export class ResumeService {
  constructor(
    private readonly db: Db,
    /** 照片存储（ADR-0009；不注入则照片相关操作无副作用，测试默认态） */
    private readonly photos?: PhotoStore
  ) {}

  /** 全部简历（含基准简历与派生稿），按创建时间升序。 */
  list(): StoredResume[] {
    const rows = this.db.prepare(LIST).all() as Array<{ json: string }>
    return rows.map((row) => parseStored(row.json))
  }

  /** 读取单份简历；不存在返回 undefined。 */
  get(id: string): StoredResume | undefined {
    const row = this.db.prepare(GET).get(id) as { json: string } | undefined
    return row === undefined ? undefined : parseStored(row.json)
  }

  /**
   * 新建简历（基准简历或派生稿均可）：schema 校验通过后入库。
   * meta.id / meta.updatedAt 由服务端生成（输入中的同名值被覆盖）。
   */
  create(input: Resume): StoredResume {
    assertValidResume(input)
    const stored: StoredResume = {
      ...input,
      meta: { ...input.meta, id: `res-${randomUUID()}`, updatedAt: new Date().toISOString() }
    }
    return this.insert(stored)
  }

  /**
   * 导入确认（#75）：总是创建新的基准简历——强制 baseResumeId / targetJobId 为空
   * （不覆盖、不按姓名合并、不去重），并写入简要导入溯源（不含源文件/全文/诊断）。
   */
  createImported(input: Resume, provenance: ResumeImportProvenance): StoredResume {
    assertValidResume(input)
    const stored: StoredResume = {
      ...input,
      meta: {
        ...input.meta,
        id: `res-${randomUUID()}`,
        updatedAt: new Date().toISOString(),
        baseResumeId: null,
        targetJobId: null,
        importedFrom: provenance
      }
    }
    return this.insert(stored)
  }

  /** 入库（schema 已由调用方校验）。 */
  private insert(stored: StoredResume): StoredResume {
    this.db.prepare(INSERT).run(toRowParams(stored))
    return stored
  }

  /**
   * 更新简历：schema 校验通过且 id 存在时落库。
   * id / created_at 不变；meta.updatedAt 刷新；meta.id 以行 id 为准（输入中的被忽略）。
   */
  update(id: string, input: Resume): StoredResume {
    assertValidResume(input)
    const stored: StoredResume = {
      ...input,
      meta: { ...input.meta, id, updatedAt: new Date().toISOString() }
    }
    const result = this.db.prepare(UPDATE).run(toRowParams(stored))
    if (result.changes === 0) throw new ResumeNotFoundError(id)
    return stored
  }

  /** 删除简历（基准或派生稿均可）。派生稿是独立副本，不受基准删除影响。照片文件随删。 */
  delete(id: string): void {
    const row = this.db.prepare(GET).get(id) as { json: string } | undefined
    if (row === undefined) throw new ResumeNotFoundError(id)
    const resume = parseStored(row.json)
    if (this.photos !== undefined) this.photos.remove(resume.basics?.photo)
    this.db.prepare(DELETE).run(id)
  }

  /** 照片导入（IPC）：复制到照片目录，返回文件名。 */
  importPhoto(srcPath: string): string {
    if (this.photos === undefined) throw new PhotoStoreError('照片存储未配置')
    return this.photos.import(srcPath)
  }

  /** 照片移除（IPC）：best effort 清理旧文件。 */
  removePhoto(fileName: string): void {
    this.photos?.remove(fileName)
  }

  /** 照片 data URI（表单缩略图）：文件缺失返回 undefined。 */
  photoDataUri(fileName: string): string | undefined {
    return this.photos?.dataUri(fileName)
  }

  /**
   * A4 渲染（F-15/#30）：简历 → 完整 HTML 文档（A4 模板 + 打印样式），
   * 渲染层 iframe srcdoc 预览、主进程 printToPDF 导出共用（纯函数，无 IO）。
   * 照片以 data URI 内嵌（iframe srcdoc / printToPDF 无法引用 file:// 路径）。
   */
  renderHtml(id: string): string {
    const resume = this.get(id)
    if (resume === undefined) throw new ResumeNotFoundError(id)
    return this.renderFromResume(resume)
  }

  /** 任意简历对象 → A4 HTML（未保存表单预览用；照片同样内嵌 data URI）。 */
  renderFromResume(resume: Resume): string {
    const photoDataUri = this.photos?.dataUri(resume.basics?.photo)
    return renderResumeHtml(resume, photoDataUri)
  }
}
