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
  `,
  // v2: positions 表 —— 职位卡（issue #5 定稿 schema；手动录入 source='manual'）。
  // 去重：source_url 部分唯一索引优先（爬虫），dedupe_key（company|title|recruit_season）
  // 兜底（手动录入，source_url IS NULL 时生效）；两索引在应用层先查后插给出友好错误。
  `
  CREATE TABLE positions (
    id             TEXT PRIMARY KEY,          -- uuid
    company        TEXT NOT NULL,
    company_type   TEXT NOT NULL CHECK (company_type IN ('央企','国企','大厂','私企','外企','事业单位','其他')),
    title          TEXT NOT NULL,
    jd             TEXT NOT NULL DEFAULT '',
    city           TEXT,
    channel        TEXT,                      -- 投递渠道：官网/牛客/猎聘/邮箱/内推…
    channel_url    TEXT,
    source         TEXT NOT NULL CHECK (source IN ('manual','nowcoder','liepin')),
    source_url     TEXT,                      -- 来源页 URL（爬虫去重主键）
    dedupe_key     TEXT NOT NULL,             -- company|title|recruit_season（手动录入去重）
    recruit_season TEXT NOT NULL,             -- 如 '2026秋招'
    batch          TEXT CHECK (batch IN ('提前批','正式批','补录','未知')),
    start_date     TEXT,                      -- 网申开始 YYYY-MM-DD
    end_date       TEXT,                      -- 网申截止 YYYY-MM-DD
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    notes          TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE UNIQUE INDEX uq_positions_source_url ON positions(source_url) WHERE source_url IS NOT NULL;
  CREATE UNIQUE INDEX uq_positions_dedupe    ON positions(dedupe_key) WHERE source_url IS NULL;
  CREATE INDEX idx_positions_season ON positions(recruit_season, company_type);
  `,
  // v3: resumes 表（F-12 / issue #19）—— 简历 JSON 本体（resume.schema.json 单一 schema，
  // ADR-0003：基准简历与优化简历共用；派生关系记在 meta.baseResumeId/targetJobId）。
  // - json 列带 json_valid 约束：数据库层拒绝非 JSON 文本（服务层另有 schema 校验）；
  // - base_resume_id / target_job_id 为 meta 冗余列（索引，供派生分组/查询，如 F-13 列表分组）；
  // - 删除语义：派生稿是独立副本，无外键引用——删除基准不影响已存派生稿。
  `
  CREATE TABLE resumes (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL CHECK (json_valid(json)),
    base_resume_id TEXT,
    target_job_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_resumes_base_resume_id ON resumes(base_resume_id);
  CREATE INDEX idx_resumes_target_job_id ON resumes(target_job_id);
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
