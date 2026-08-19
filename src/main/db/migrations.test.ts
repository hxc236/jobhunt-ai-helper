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

  it('既有 v1 库（仅 settings）升级到最新版本：旧数据保留、新表可用', () => {
    const file = openTempFile()
    tempDirs.add(join(file, '..'))

    // 模拟旧版本库：只应用第一条迁移（v1 settings），写入数据后关闭
    const old = new Database(file)
    applyMigrations(old, MIGRATIONS.slice(0, 1))
    old.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('k', 'v1')
    old.close()

    // 重开并全量迁移：user_version 到最新，旧数据保留
    const upgraded = new Database(file)
    migrate(upgraded)
    expect(userVersion(upgraded)).toBe(MIGRATIONS.length)
    expect(upgraded.prepare('SELECT value FROM settings WHERE key = ?').get('k')).toEqual({ value: 'v1' })

    // 新表（resumes，v3）可用，且 json_valid 约束拒绝非 JSON 文本
    upgraded
      .prepare('INSERT INTO resumes (id, json) VALUES (?, ?)')
      .run('r1', '{"meta":{},"basics":{"name":"张伟"},"education":[]}')
    expect(() => upgraded.prepare('INSERT INTO resumes (id, json) VALUES (?, ?)').run('r2', 'not json')).toThrow()
    upgraded.close()
  })

  describe('v9：招聘类型/薪资/BOSS 源/去重键/常用采集（issue #52）', () => {
    const INSERT_MINIMAL =
      "INSERT INTO positions (id, company, company_type, title, source, dedupe_key, recruit_season, created_at, updated_at) VALUES (?, ?, '其他', ?, ?, ?, ?, 'now', 'now')"

    it('新库迁移后：source 允许 boss、hire_type 默认校招且 CHECK 生效、薪资列可空可写、crawl_presets 可用', () => {
      const db = new Database(':memory:')
      migrate(db)

      // source 'boss' 通过新 CHECK；薪资列可空
      db.prepare(INSERT_MINIMAL).run('p1', '某公司', '前端', 'boss', '某公司|前端|校招|', '')
      const row = db.prepare('SELECT * FROM positions WHERE id = ?').get('p1') as Record<string, unknown>
      expect(row.source).toBe('boss')
      expect(row.hire_type).toBe('校招') // 未传 → 默认校招
      expect(row.salary_min).toBeNull()
      expect(row.salary_max).toBeNull()
      expect(row.salary_text).toBeNull()

      // 薪资列可写
      db.prepare('UPDATE positions SET salary_min = ?, salary_max = ?, salary_text = ? WHERE id = ?').run(20, 40, '20-40K·14薪', 'p1')
      const updated = db.prepare('SELECT salary_min, salary_max, salary_text FROM positions WHERE id = ?').get('p1') as Record<string, unknown>
      expect(updated).toEqual({ salary_min: 20, salary_max: 40, salary_text: '20-40K·14薪' })

      // hire_type CHECK：社招/实习合法，非法值拒绝
      db.prepare(INSERT_MINIMAL).run('p2', '乙公司', '后端', 'boss', '乙公司|后端|社招|', '')
      db.prepare(
        "INSERT INTO positions (id, company, company_type, title, source, dedupe_key, recruit_season, hire_type, created_at, updated_at) VALUES ('p3', '丙公司', '其他', '运维', 'manual', '丙公司|运维|实习|', '', '实习', 'now', 'now')"
      ).run()
      expect(() =>
        db
          .prepare(
            "INSERT INTO positions (id, company, company_type, title, source, dedupe_key, recruit_season, hire_type, created_at, updated_at) VALUES ('p4', '丁公司', '其他', '测试', 'manual', 'x', '', '临时工', 'now', 'now')"
          )
          .run()
      ).toThrow()

      // crawl_presets：可插入（json_valid 校验）、查询与删除
      db.prepare('INSERT INTO crawl_presets (name, conditions_json, created_at, updated_at) VALUES (?, ?, ?, ?)').run('上海前端', '{"keyword":"前端","city":"101020100"}', 'now', 'now')
      expect(db.prepare('SELECT name FROM crawl_presets').get()).toEqual({ name: '上海前端' })
      db.prepare('DELETE FROM crawl_presets WHERE name = ?').run('上海前端')
      expect(db.prepare('SELECT count(*) AS n FROM crawl_presets').get()).toEqual({ n: 0 })
      expect(() => db.prepare('INSERT INTO crawl_presets (name, conditions_json, created_at, updated_at) VALUES (?, ?, ?, ?)').run('坏数据', 'not json', 'now', 'now')).toThrow()

      // crawl_runs 重建：source 允许 'boss'
      db.prepare(
        "INSERT INTO crawl_runs (source, mode, status, url_count, created_at) VALUES ('boss', 'full', 'success', 1, 'now')"
      ).run()
      db.close()
    })

    it('v10：crawl_runs 有 conditions_json（结构化条件留痕）；v9 旧行升级后为 NULL', () => {
      const file = openTempFile()
      tempDirs.add(join(file, '..'))

      // 模拟 v9 库（前 9 条迁移），写入一条旧留痕
      const old = new Database(file)
      applyMigrations(old, MIGRATIONS.slice(0, 9))
      old
        .prepare(
          "INSERT INTO crawl_runs (source, mode, status, url_count, created_at) VALUES ('nowcoder', 'full', 'success', 1, 'now')"
        )
        .run()
      old.close()

      const upgraded = new Database(file)
      migrate(upgraded)
      expect(userVersion(upgraded)).toBe(MIGRATIONS.length)
      const row = upgraded.prepare('SELECT conditions_json FROM crawl_runs').get() as Record<string, unknown>
      expect(row.conditions_json).toBeNull() // 旧行无条件快照

      upgraded
        .prepare(
          "INSERT INTO crawl_runs (source, mode, conditions_json, status, url_count, created_at) VALUES ('boss', 'full', '{\"hire_type\":\"社招\",\"keyword\":\"前端\",\"city\":\"101020100\"}', 'success', 1, 'now')"
        )
        .run()
      const inserted = upgraded.prepare('SELECT conditions_json FROM crawl_runs WHERE source = ?').get('boss') as Record<string, unknown>
      expect(inserted.conditions_json).toBe('{"hire_type":"社招","keyword":"前端","city":"101020100"}')
      upgraded.close()
    })

    it('既有 v8 库升级：职位与投递记录保留（表重建不级联删除）、dedupe_key 按校招重建', () => {
      const file = openTempFile()
      tempDirs.add(join(file, '..'))

      // 模拟 v8 库：职位（旧 dedupe_key 组成）+ 投递记录
      const old = new Database(file)
      applyMigrations(old, MIGRATIONS.slice(0, 8))
      old
        .prepare(
          "INSERT INTO positions (id, company, company_type, title, jd, source, dedupe_key, recruit_season, status, created_at, updated_at) VALUES ('p1', '腾讯', '大厂', '前端开发工程师', 'jd', 'manual', '腾讯|前端开发工程师|2026秋招', '2026秋招', 'active', 'now', 'now')"
        )
        .run()
      old
        .prepare(
          "INSERT INTO applications (id, position_id, status, created_at, updated_at) VALUES ('a1', 'p1', 'planned', 'now', 'now')"
        )
        .run()
      old.close()

      // 升级：数据保留、投递记录不被级联删除、dedupe_key 按校招重建
      const upgraded = new Database(file)
      migrate(upgraded)
      expect(userVersion(upgraded)).toBe(MIGRATIONS.length)
      const row = upgraded.prepare('SELECT * FROM positions WHERE id = ?').get('p1') as Record<string, unknown>
      expect(row).toMatchObject({ company: '腾讯', recruit_season: '2026秋招', hire_type: '校招' })
      expect(row.dedupe_key).toBe('腾讯|前端开发工程师|校招|2026秋招')
      expect(upgraded.prepare('SELECT count(*) AS n FROM applications').get()).toEqual({ n: 1 })
      upgraded.close()
    })
  })

  describe('v11：内容优化任务表 content_optimize_tasks（#90/T02）', () => {
    const INSERT_TASK = `INSERT INTO content_optimize_tasks
      (id, resume_id, status, diagnosis_json, answers_json, rewrite_json, progress, error, no_changes, resume_to, created_at, updated_at)
      VALUES (?, ?, ?, 'null', 'null', 'null', '', '', 0, NULL, 'now', 'now')`

    it('新库迁移后：表可用、状态 CHECK 覆盖全部 8 个合法值、非法状态与非法 JSON 拒绝', () => {
      const db = new Database(':memory:')
      migrate(db)

      // 全部 8 个合法状态可写入
      const statuses = [
        'created', 'diagnosing', 'awaiting_answers', 'rewriting',
        'ready_for_review', 'confirmed', 'failed', 'cancelled'
      ]
      statuses.forEach((status, index) => {
        db.prepare(INSERT_TASK).run(`t${index}`, 'r1', status)
      })
      const rows = db.prepare('SELECT status FROM content_optimize_tasks ORDER BY id').all() as Array<{ status: string }>
      expect(rows.map((r) => r.status)).toEqual(statuses)

      // 非法状态被 CHECK 拒绝
      expect(() => db.prepare(INSERT_TASK).run('bad', 'r1', 'bogus')).toThrow()
      // JSON 列约束：非 JSON 文本拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO content_optimize_tasks (id, resume_id, status, diagnosis_json, answers_json, rewrite_json, progress, error, no_changes, resume_to, created_at, updated_at)
             VALUES ('bad2', 'r1', 'created', 'not json', 'null', 'null', '', '', 0, NULL, 'now', 'now')`
          )
          .run()
      ).toThrow()

      // 既有 v10 库升级：表可新建，旧数据不受影响
      const file = openTempFile()
      tempDirs.add(join(file, '..'))
      const old = new Database(file)
      applyMigrations(old, MIGRATIONS.slice(0, 10))
      old.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('k', 'v10')
      old.close()
      const upgraded = new Database(file)
      migrate(upgraded)
      expect(userVersion(upgraded)).toBe(MIGRATIONS.length)
      expect(upgraded.prepare('SELECT value FROM settings WHERE key = ?').get('k')).toEqual({ value: 'v10' })
      upgraded.prepare(INSERT_TASK).run('t-v11', 'r1', 'created')
      expect(upgraded.prepare('SELECT id FROM content_optimize_tasks').get()).toEqual({ id: 't-v11' })
      upgraded.close()
    })
  })
})
