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
  `,
  // v4: applications 表（F-05 / issue #21）—— 投递状态机记录，与 positions 1:1
  // （position_id UNIQUE）；各 *_at 列为状态进入时刻（复盘数据来源，ADR-0005）；
  // applied_date 为实际投递日期（用户可编辑，进入 applied 自动填当天）；
  // ON DELETE CASCADE 兜底：删职位卡连带删投递记录（服务层另有显式删除，见 F-03/#20）。
  `
  CREATE TABLE applications (
    id            TEXT PRIMARY KEY,
    position_id   TEXT NOT NULL UNIQUE REFERENCES positions(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('planned','applied','interviewing','offer','rejected','withdrawn')),
    channel       TEXT,
    applied_date  TEXT,
    planned_at    TEXT,
    applied_at    TEXT,
    interviewing_at TEXT,
    offer_at      TEXT,
    rejected_at   TEXT,
    withdrawn_at  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX idx_applications_status ON applications(status);
  `,
  // v5: positions 增 jd_analysis 列（F-07/#28）—— JD 分析缓存（skills/keywords/requirements/
  // hardRequirements/parsedAt/jdFingerprint JSON）；JD 变更（指纹不一致）失效重算。
  `ALTER TABLE positions ADD COLUMN jd_analysis TEXT`,
  // v6: crawl_runs 表（F-08 / issue #22）—— 采集留痕（spec #13-23）。
  // - candidates_json：候选快照（预览确认入库的数据源，#29 消费）；
  // - errors_json：失败 URL 列表（含原因）；truncated：达上限截断标志；
  // - status：running（执行中）→ success/partial/failed（留痕终态）。
  `
  CREATE TABLE crawl_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL CHECK (source IN ('nowcoder','liepin')),
    mode            TEXT NOT NULL CHECK (mode IN ('filter','full')),
    filter          TEXT,
    status          TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
    url_count       INTEGER NOT NULL,
    fetched_count   INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    truncated       INTEGER NOT NULL DEFAULT 0,
    candidates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates_json)),
    errors_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(errors_json)),
    created_at      TEXT NOT NULL
  );
  CREATE INDEX idx_crawl_runs_created ON crawl_runs(created_at DESC);
  `,
  // v7: topics 表（F-19 / issue #33）—— 学习清单条目。
  // - 优先级 1-5：hard（硬性要求）1 / mentioned（JD 提及技能）2 / gap（简历缺口）3 /
  //   project（项目 techStack）4 / manual（人工添加）5（interview 为复盘回填来源，#39）；
  // - 三态 status：todo / learning / learned；去重：同 job 下 title 唯一（应用层先查后插）。
  `
  CREATE TABLE topics (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','learning','learned')),
    priority   INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
    source     TEXT NOT NULL CHECK (source IN ('hard','mentioned','gap','project','manual','interview')),
    job_id     TEXT,
    note       TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_topics_status ON topics(status);
  CREATE INDEX idx_topics_job ON topics(job_id);
  `,
  // v8: interviews 表（F-23/#37）—— 模拟面试记录。
  // - transcript：JSON 数组 [{role: 'user'|'assistant', text, ts}]（逐轮追加）；
  // - review：复盘 JSON（#39 生成后写入）；style：real/coach/strict。
  `
  CREATE TABLE interviews (
    id         TEXT PRIMARY KEY,
    job_id     TEXT,
    style      TEXT NOT NULL CHECK (style IN ('real','coach','strict')),
    transcript TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transcript)),
    status     TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','ended')),
    review     TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_interviews_created ON interviews(created_at DESC);
  `,
  // v9: positions 支持招聘类型/薪资/BOSS 源 + crawl_presets 表（issue #52）。
  // SQLite 无法改 CHECK 约束，重建 positions：source 新 CHECK 含 'boss'；
  // 新增 hire_type（默认校招，CHECK 三值）与薪资列（可空）；
  // dedupe_key 新组成 company|title|hire_type|recruit_season，存量行按校招重建
  // （社招/实习 recruit_season 为空串）。重建在 foreign_keys=OFF 下执行
  // （applyMigrations 临时关闭），避免 DROP 父表时隐式级联删除 applications。
  `
  CREATE TABLE positions_new (
    id             TEXT PRIMARY KEY,
    company        TEXT NOT NULL,
    company_type   TEXT NOT NULL CHECK (company_type IN ('央企','国企','大厂','私企','外企','事业单位','其他')),
    title          TEXT NOT NULL,
    jd             TEXT NOT NULL DEFAULT '',
    city           TEXT,
    channel        TEXT,
    channel_url    TEXT,
    source         TEXT NOT NULL CHECK (source IN ('manual','nowcoder','liepin','boss')),
    source_url     TEXT,
    dedupe_key     TEXT NOT NULL,
    recruit_season TEXT NOT NULL,
    batch          TEXT CHECK (batch IN ('提前批','正式批','补录','未知')),
    start_date     TEXT,
    end_date       TEXT,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    notes          TEXT DEFAULT '',
    hire_type      TEXT NOT NULL DEFAULT '校招' CHECK (hire_type IN ('校招','社招','实习')),
    salary_min     INTEGER,
    salary_max     INTEGER,
    salary_text    TEXT,
    jd_analysis    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  INSERT INTO positions_new (
    id, company, company_type, title, jd, city, channel, channel_url,
    source, source_url, dedupe_key, recruit_season, batch, start_date, end_date,
    status, notes, hire_type, salary_min, salary_max, salary_text, jd_analysis, created_at, updated_at
  )
  SELECT
    id, company, company_type, title, jd, city, channel, channel_url,
    source, source_url, company || '|' || title || '|校招|' || recruit_season,
    recruit_season, batch, start_date, end_date,
    status, notes, '校招', NULL, NULL, NULL, jd_analysis, created_at, updated_at
  FROM positions;
  DROP TABLE positions;
  ALTER TABLE positions_new RENAME TO positions;
  CREATE UNIQUE INDEX uq_positions_source_url ON positions(source_url) WHERE source_url IS NOT NULL;
  CREATE UNIQUE INDEX uq_positions_dedupe    ON positions(dedupe_key) WHERE source_url IS NULL;
  CREATE INDEX idx_positions_season ON positions(recruit_season, company_type);
  CREATE TABLE crawl_presets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  -- crawl_runs 重建：source CHECK 增加 'boss'（采集留痕记录 BOSS 运行）。
  CREATE TABLE crawl_runs_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL CHECK (source IN ('nowcoder','liepin','boss')),
    mode            TEXT NOT NULL CHECK (mode IN ('filter','full')),
    filter          TEXT,
    status          TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
    url_count       INTEGER NOT NULL,
    fetched_count   INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    truncated       INTEGER NOT NULL DEFAULT 0,
    candidates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates_json)),
    errors_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(errors_json)),
    created_at      TEXT NOT NULL
  );
  INSERT INTO crawl_runs_new SELECT * FROM crawl_runs;
  DROP TABLE crawl_runs;
  ALTER TABLE crawl_runs_new RENAME TO crawl_runs;
  CREATE INDEX idx_crawl_runs_created ON crawl_runs(created_at DESC);
  `,
  // v10: crawl_runs 增 conditions_json（issue #55 结构化采集条件留痕快照；
  // hire_type/keyword/city；旧行 NULL）。
  `ALTER TABLE crawl_runs ADD COLUMN conditions_json TEXT`,
  // v11: content_optimize_tasks 表（#90 业务① / T02）—— 内容优化异步任务独立存储。
  // - 与 resumes 无外键（删除基准简历不级联删任务；任务保留历史供续接/复盘）；
  // - status 状态机：created → diagnosing → awaiting_answers → rewriting →
  //   ready_for_review → confirmed；failed 可重试、cancelled 可续接或作废；
  // - diagnosis/answers/rewrite 为 JSON 列（任务记录不进简历 JSON，见 ADR-0003 边界）；
  // - no_changes：空诊断路径（全部「保持」→ 无需修改，不创建新版本）。
  `
  CREATE TABLE content_optimize_tasks (
    id TEXT PRIMARY KEY,
    resume_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created','diagnosing','awaiting_answers','rewriting','ready_for_review','confirmed','failed','cancelled')),
    diagnosis_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(diagnosis_json)),
    answers_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(answers_json)),
    rewrite_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(rewrite_json)),
    progress TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    no_changes INTEGER NOT NULL DEFAULT 0,
    resume_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_content_optimize_tasks_resume ON content_optimize_tasks(resume_id);
  `,
  // v12: content_optimize_tasks 增 T06 确认决策列（#90/T06 确认、对比与整合）。
  // - decisions_json：按项目整体接受/拒绝改写（键=项目 id；缺省全部接受）；
  // - inferred_confirmed_json：已显式勾选「确认纳入最终版」的推断-待确认改动 id 列表（US17 门禁）；
  // - summary_json：整合汇总（标点/排序自动修复、删除确认/保留原文警告、「仍有未解决项目」；确认后保留展示）。
  // 旧行：三列默认 'null'（JSON null），语义 = 未设置决策/无勾选/无汇总。
  `ALTER TABLE content_optimize_tasks ADD COLUMN decisions_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(decisions_json))`,
  `ALTER TABLE content_optimize_tasks ADD COLUMN inferred_confirmed_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(inferred_confirmed_json))`,
  `ALTER TABLE content_optimize_tasks ADD COLUMN summary_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(summary_json))`
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
    // 表重建类迁移需临时关闭外键：DROP 父表（positions）会触发隐式级联删除
    // 子行（applications）；PRAGMA foreign_keys 在事务内是 no-op，故在事务外切换。
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(sql)
        db.pragma(`user_version = ${i + 1}`)
      })()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }
}

/** 对给定连接应用本仓库全部迁移（幂等：已应用的跳过）。 */
export function migrate(db: Db): void {
  applyMigrations(db, MIGRATIONS)
}
