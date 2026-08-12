import type { Db } from '../db/migrations'

const GET = 'SELECT value FROM settings WHERE key = ?'
const UPSERT = `
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`
const ALL = 'SELECT key, value FROM settings'

/**
 * settings 表访问层：非敏感设置的 key-value 存取（value 以 JSON 文本落库）。
 * 模型提供商/API key 等敏感配置走 auth.json（EF-04，ModelRuntime），不入本表。
 */
export class SettingsService {
  constructor(private readonly db: Db) {}

  /** 读取设置；未设置（或值损坏）返回 undefined。 */
  get(key: string): unknown {
    const row = this.db.prepare(GET).get(key) as { value: string } | undefined
    return row === undefined ? undefined : parseValue(row.value)
  }

  /** 写入/更新设置（upsert）。value 必须可 JSON 序列化；undefined 拒绝。 */
  set(key: string, value: unknown): void {
    if (value === undefined) {
      throw new TypeError('settings value 不能为 undefined（JSON 不可序列化）')
    }
    this.db.prepare(UPSERT).run(key, JSON.stringify(value))
  }

  /** 返回全部设置的键值快照。 */
  getAll(): Record<string, unknown> {
    const rows = this.db.prepare(ALL).all() as Array<{ key: string; value: string }>
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      out[row.key] = parseValue(row.value)
    }
    return out
  }
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // 损坏的 JSON 按未设置处理（防御性读，不崩应用）
    return undefined
  }
}
