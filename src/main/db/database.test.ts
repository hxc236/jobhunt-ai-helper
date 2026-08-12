import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { openDatabase } from './database'

const tempDirs = new Set<string>()
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('openDatabase', () => {
  it(':memory: 可注入——测试用内存库自动完成迁移且可用', () => {
    const db = openDatabase(':memory:')
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('k', '"v"')
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('k')).toEqual({ value: '"v"' })
    db.close()
  })

  it('默认参数即 :memory:', () => {
    const db = openDatabase()
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    db.close()
  })

  it('文件库：关闭重开后数据与 user_version 保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobhunt-db-'))
    tempDirs.add(dir)
    const file = join(dir, 'app.db')

    const first = openDatabase(file)
    first.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', '"dark"')
    first.close()

    const second = openDatabase(file)
    expect(second.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(second.prepare('SELECT value FROM settings WHERE key = ?').get('theme')).toEqual({
      value: '"dark"'
    })
    second.close()
  })
})
