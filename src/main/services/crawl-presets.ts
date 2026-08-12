import type { CrawlConditions, CrawlPreset } from '../../shared/types'
import type { Db } from '../db/migrations'

/** 常用采集服务（issue #57）：crawl_presets 表 CRUD（名称 + 条件 JSON）。 */
export class CrawlPresetService {
  constructor(private readonly db: Db) {}

  /** 常用采集列表（按创建时间倒序）。 */
  list(): CrawlPreset[] {
    const rows = this.db
      .prepare('SELECT * FROM crawl_presets ORDER BY id DESC')
      .all() as Array<{
      id: number
      name: string
      conditions_json: string
      created_at: string
      updated_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      conditions: JSON.parse(row.conditions_json) as CrawlConditions,
      created_at: row.created_at,
      updated_at: row.updated_at
    }))
  }

  /** 保存常用采集（名称必填非空；条件为空时拒绝）。 */
  create(name: string, conditions: CrawlConditions): CrawlPreset {
    const trimmed = name.trim()
    if (trimmed === '') {
      throw new TypeError('常用采集名称不能为空')
    }
    if (Object.keys(conditions).length === 0) {
      throw new TypeError('采集条件不能为空')
    }
    const now = new Date().toISOString()
    const result = this.db
      .prepare('INSERT INTO crawl_presets (name, conditions_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(trimmed, JSON.stringify(conditions), now, now)
    return this.get(Number(result.lastInsertRowid))
  }

  /** 删除常用采集（不存在静默忽略）。 */
  delete(id: number): void {
    this.db.prepare('DELETE FROM crawl_presets WHERE id = ?').run(id)
  }

  private get(id: number): CrawlPreset {
    const row = this.db.prepare('SELECT * FROM crawl_presets WHERE id = ?').get(id) as
      | { id: number; name: string; conditions_json: string; created_at: string; updated_at: string }
      | undefined
    if (row === undefined) {
      throw new TypeError(`常用采集不存在：${id}`)
    }
    return {
      id: row.id,
      name: row.name,
      conditions: JSON.parse(row.conditions_json) as CrawlConditions,
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  }
}
