import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PhotoStore, PhotoStoreError } from './photo-store'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('PhotoStore（ADR-0009 照片存储）', () => {
  let dir: string
  let store: PhotoStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'photo-store-'))
    store = new PhotoStore(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('import：复制到照片目录并返回随机文件名（保留扩展名）；源文件内容一致', () => {
    const src = join(dir, 'src.png')
    writeFileSync(src, PNG)
    const name = store.import(src)
    expect(name).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(readFileSync(join(dir, name))).toEqual(PNG)
  })

  it('import：不支持格式拒绝（不落文件）', () => {
    const src = join(dir, 'resume.docx')
    writeFileSync(src, 'not an image')
    expect(() => store.import(src)).toThrow(PhotoStoreError)
    expect(existsSync(join(dir, 'resume.docx'))).toBe(true) // 源文件不动
  })

  it('remove：删除指定文件；文件不存在不报错；undefined 无操作', () => {
    const src = join(dir, 'a.jpg')
    writeFileSync(src, 'x')
    const name = store.import(src)
    store.remove(name)
    expect(existsSync(join(dir, name))).toBe(false)
    expect(() => store.remove('missing.png')).not.toThrow()
    expect(() => store.remove(undefined)).not.toThrow()
  })

  it('inherit：复制为新文件名；源缺失抛错', () => {
    writeFileSync(join(dir, 'base.png'), PNG)
    const name = store.inherit('base.png')
    expect(name).not.toBe('base.png')
    expect(readFileSync(join(dir, name))).toEqual(PNG)
    expect(() => store.inherit('missing.png')).toThrow(PhotoStoreError)
  })

  it('dataUri：返回正确 mime 的 base64 data URI；缺失返回 undefined', () => {
    writeFileSync(join(dir, 'p.png'), PNG)
    expect(store.dataUri('p.png')).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(store.dataUri('missing.png')).toBeUndefined()
    expect(store.dataUri(undefined)).toBeUndefined()
  })
})
