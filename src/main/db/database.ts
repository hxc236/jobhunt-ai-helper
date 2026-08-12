import Database from 'better-sqlite3'
import { migrate, type Db } from './migrations'

/**
 * 打开 SQLite 连接并自动迁移。
 * - 默认 `:memory:`：测试注入内存库，零清理；
 * - 传入文件路径：生产路径（主进程 userData 下单文件库），启用 WAL；
 * - 幂等：已迁移过的库不会重复执行迁移（见 migrations.ts）。
 */
export function openDatabase(filePath: string = ':memory:'): Db {
  const db = new Database(filePath)
  if (filePath !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
