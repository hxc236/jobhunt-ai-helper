import type Database from 'better-sqlite3'

export type Db = Database.Database

/**
 * 有序迁移数组：只追加、不改写历史条目。迁移 i 对应 user_version = i + 1。
 * 后续 ticket 的新表（positions/applications/topics/interviews/crawl_runs）在此追加。
 */
export const MIGRATIONS: readonly string[] = [
  // v1: settings 表 —— key-value 非敏感设置；value 存 JSON 文本。
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
  `
]

/**
 * 按 PRAGMA user_version 递增应用迁移：
 * - 从当前 user_version 开始逐个执行未应用的迁移，每条迁移与其 user_version 递增
 *   在同一事务内提交——迁移失败仅回滚该条，已应用的保留（重启不重跑）；
 * - 传入自定义数组便于测试迁移机制本身；生产路径固定用 MIGRATIONS。
 */
export function applyMigrations(db: Db, migrations: readonly string[]): void {
  const applied = db.pragma('user_version', { simple: true }) as number
  for (let i = applied; i < migrations.length; i++) {
    const sql = migrations[i]
    if (sql === undefined) {
      throw new Error(`迁移数组缺项：index ${i}`)
    }
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
}

/** 对给定连接应用本仓库全部迁移（幂等：已应用的跳过）。 */
export function migrate(db: Db): void {
  applyMigrations(db, MIGRATIONS)
}
