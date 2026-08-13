import { copyFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'

/**
 * 简历照片存储（ADR-0009）：照片复制到应用照片目录（userData/resume-photos），
 * 简历 JSON 只存文件名（basics.photo）——防原图被删/移动失效。
 * - 文件名 = 随机 uuid + 扩展名（不绑定简历 id：优化稿继承时复制为新名即可）；
 * - 同步 fs（与 better-sqlite3 同约定，本地单用户桌面应用）；
 * - 目录可注入（测试用临时目录）。
 */

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

export class PhotoStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoStoreError'
  }
}

function mimeOf(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return `image/${ext.slice(1)}`
}

export class PhotoStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /** 导入：源文件复制到照片目录，返回文件名（不支持的格式抛 PhotoStoreError）。 */
  import(srcPath: string): string {
    const ext = extname(srcPath).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      throw new PhotoStoreError(`不支持的图片格式：${ext === '' ? '（无扩展名）' : ext}（支持 jpg/png/webp）`)
    }
    const name = `${randomUUID()}${ext}`
    copyFileSync(srcPath, join(this.dir, name))
    return name
  }

  /** 删除照片文件（best effort：文件不存在不报错；fileName 缺省无操作）。 */
  remove(fileName: string | undefined): void {
    if (fileName === undefined || fileName === '') return
    try {
      unlinkSync(join(this.dir, fileName))
    } catch {
      // 文件已不存在（或目录被清）——删除语义不因照片残留而失败
    }
  }

  /** 继承：复制已有照片为新名（优化稿派生用）；源文件缺失抛 PhotoStoreError。 */
  inherit(fileName: string): string {
    const ext = extname(fileName).toLowerCase()
    const name = `${randomUUID()}${ext}`
    try {
      copyFileSync(join(this.dir, fileName), join(this.dir, name))
    } catch {
      throw new PhotoStoreError(`照片文件不存在：${fileName}`)
    }
    return name
  }

  /** 照片 → base64 data URI（A4 HTML 内嵌用；文件缺失返回 undefined）。 */
  dataUri(fileName: string | undefined): string | undefined {
    if (fileName === undefined || fileName === '') return undefined
    try {
      const buf = readFileSync(join(this.dir, fileName))
      return `data:${mimeOf(fileName)};base64,${buf.toString('base64')}`
    } catch {
      return undefined
    }
  }
}
