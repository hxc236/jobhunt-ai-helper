import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations, MIGRATIONS, migrate, type Db } from './migrations'

function userVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

function openTempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jobhunt-migrations-')), 'test.db')
}

const tempDirs = new Set<string>()
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('applyMigrations', () => {
  it('按 user_version 递增应用全部迁移，并在新库上把 user_version 置为迁移总数', () => {
    const db = new Database(':memory:')
    migrate(db)
    expect(userVersion(db)).toBe(MIGRATIONS.length)
    // v1 迁移建了 settings 表：写入/读取验证可用
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('a', '1')
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('a')).toEqual({ value: '1' })
    db.close()
  })

  it('迁移按顺序执行：后一条可引用前一条建的表', () => {
    const db = new Database(':memory:')
    applyMigrations(db, [
      'CREATE TABLE first (id INTEGER PRIMARY KEY)',
      'CREATE TABLE second (id INTEGER PRIMARY KEY REFERENCES first(id))'
    ])
    expect(userVersion(db)).toBe(2)
    db.prepare('INSERT INTO first (id) VALUES (1)').run()
    db.prepare('INSERT INTO second (id) VALUES (1)').run()
    db.close()
  })

  it('某条迁移失败时仅回滚该条，已应用的迁移与 user_version 保留', () => {
    const db = new Database(':memory:')
    expect(() =>
      applyMigrations(db, ['CREATE TABLE ok (id INTEGER PRIMARY KEY)', 'THIS IS NOT SQL'])
    ).toThrow()
    expect(userVersion(db)).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok'").get()).toBeTruthy()
    db.close()
  })

  it('user_version 已是最新时不再执行任何迁移（重启不重跑）', () => {
    const file = openTempFile()
    tempDirs.add(join(file, '..'))

    const db = new Database(file)
    migrate(db)
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('persisted', '1')
    db.close()

    // 重开同一文件：迁移不重跑，user_version 不变，数据仍在
    const reopened = new Database(file)
    migrate(reopened)
    expect(userVersion(reopened)).toBe(MIGRATIONS.length)
    expect(reopened.prepare('SELECT value FROM settings WHERE key = ?').get('persisted')).toEqual({
      value: '1'
    })
    reopened.close()
  })
})
