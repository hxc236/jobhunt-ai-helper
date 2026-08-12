import { randomUUID } from 'node:crypto'
import type { Db } from '../db/migrations'
import type {
  CrawlCandidate,
  CrawlConditions,
  CrawlImportResult,
  CrawlMode,
  CrawlPreview,
  CrawlPreviewItem,
  CrawlRun,
  CrawlRunOptions,
  CrawlRunResult,
  HireType,
  PositionSource
} from '../../shared/types'

/**
 * 解析上下文：执行框架透传本次运行的模式与条件（#23 牛客 filter 按公司名过滤；
 * issue #55 结构化采集条件扩展：hire_type/keyword/city 由运行选项透传，BOSS 解析器消费）。
 */
export interface CrawlParseContext {
  mode: CrawlMode
  filter: string | undefined
  /** 招聘类型（BOSS 采集条件；缺省校招）。 */
  hire_type?: HireType
  /** 岗位关键词（BOSS 搜索 query）。 */
  keyword?: string
  /** 城市码（BOSS city 参数，如 101020100=上海）。 */
  city?: string
}

/**
 * 采集解析器（F-08/#22 框架；#23 牛客 / #24 猎聘 逐个实现注册）。
 * 解析/映射为纯函数（spec Testing Decisions：解析与抓取分离，可测；
 * 真实 BrowserWindow 抓取不做自动化测试，手动冒烟）。
 */
export interface CrawlParser {
  readonly source: PositionSource
  /** 起始列表页 URL（分页经 nextListUrl 逐个追加；mode/filter 透传，spec #13-16）。 */
  buildUrls(mode: CrawlMode, filter: string | undefined): string[]
  /** 列表页 HTML → 候选行（纯函数；detailUrl 存在时框架抓详情补全）。 */
  parseList(html: string, context: CrawlParseContext): CrawlCandidate[]
  /** 从当前列表页 HTML 提取下一页 URL（翻页参数；null = 无更多页；context 供拼页 URL）。 */
  nextListUrl?(html: string, context: CrawlParseContext): string | null
  /** 详情页 HTML → 补全候选字段（JD 全文等；可选）。 */
  parseDetail?(html: string, candidate: CrawlCandidate): CrawlCandidate
}

/**
 * 抓取器抽象（ADR-0006：隐藏 BrowserWindow + executeJavaScript，零额外依赖）。
 * 可替换（fake 供测试 / BrowserWindowFetcher 真实实现）；框架负责节流/重试。
 */
export interface CrawlFetcher {
  /** 抓取 URL → HTML 文本；失败抛错（由框架重试）。 */
  fetch(url: string): Promise<string>
  /** 释放资源（真实实现销毁窗口等）。 */
  dispose?(): Promise<void> | void
}

/** 采集服务错误：code 供渲染层区分提示。 */
export class CrawlError extends Error {
  constructor(
    readonly code: 'parser-not-found' | 'run-not-found',
    message: string
  ) {
    super(message)
    this.name = 'CrawlError'
  }
}

export interface CrawlServiceOptions {
  /** 请求间隔毫秒（spec #13-21：≥2s；默认 2000；issue #55 起由 cooldownMs 取代）。 */
  throttleMs?: number
  /** 抓取冷却间隔毫秒（issue #55 频率纪律：BOSS 建议 30-60s；缺省回退 throttleMs）。 */
  cooldownMs?: number
  /** 失败重试次数（spec #13-21：2 次；默认 2）。 */
  retries?: number
  /** 重试退避基数（指数 backoffMs * 2^attempt；默认 500）。 */
  backoffMs?: number
  /** 单次采集候选上限（spec #13-22：100 条截断；默认 100）。 */
  maxItems?: number
  /** 睡眠注入（测试 seam；默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>
  /** 进度回调（URL 级；IPC 层接事件推送 crawl:progress）。 */
  onProgress?: (progress: { runId: number; done: number; total: number }) => void
}

/** crawl_runs 行（DB 形态：truncated 为 0/1，errors 存 JSON 列）。 */
type CrawlRunRow = Omit<CrawlRun, 'truncated' | 'errors' | 'conditions'> & {
  truncated: number
  errors_json: string
  candidates_json: string
  conditions_json: string | null
}

/**
 * 采集执行框架（F-08/#22）：
 * - 解析器按 source 注册（#23/#24 逐个接入），执行：buildUrls → 逐页 fetch（节流+重试）→ parseList
 *   →（候选带 detailUrl 时）抓详情 parseDetail 补全；
 * - 上限截断：候选达 maxItems 停止抓取，truncated 标记；
 * - 留痕：每次执行写 crawl_runs（来源/模式/筛选/数量/状态/错误/候选快照，spec #13-23）。
 */
export class CrawlService {
  private readonly parsers = new Map<PositionSource, CrawlParser>()
  private readonly cooldownMs: number
  private readonly retries: number
  private readonly backoffMs: number
  private readonly maxItems: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onProgress: CrawlServiceOptions['onProgress']

  constructor(
    private readonly db: Db,
    private readonly fetcher: CrawlFetcher,
    options: CrawlServiceOptions = {}
  ) {
    this.cooldownMs = options.cooldownMs ?? options.throttleMs ?? 2000
    this.retries = options.retries ?? 2
    this.backoffMs = options.backoffMs ?? 500
    this.maxItems = options.maxItems ?? 100
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.onProgress = options.onProgress
  }

  /** 注册解析器（#23/#24 接入点；同 source 重复注册覆盖）。 */
  registerParser(parser: CrawlParser): void {
    this.parsers.set(parser.source, parser)
  }

  /**
   * 执行一次采集：冷却（cooldownMs 请求间隔）、重试（retries 次指数退避）、
   * 上限（maxItems 条截断）。留痕写入 crawl_runs 并返回（含候选快照供预览）。
   */
  async run(source: PositionSource, options: CrawlRunOptions): Promise<CrawlRunResult> {
    const parser = this.parsers.get(source)
    if (parser === undefined) {
      throw new CrawlError('parser-not-found', `解析器未注册：${source}（#23/#24 实现后可用）`)
    }

    const urls = parser.buildUrls(options.mode, options.filter)
    const filter = options.filter?.trim() || null
    const conditions: CrawlConditions = {
      hire_type: options.hire_type,
      keyword: options.keyword?.trim() || undefined,
      city: options.city?.trim() || undefined
    }
    const conditionsJson =
      conditions.hire_type === undefined && conditions.keyword === undefined && conditions.city === undefined
        ? null
        : JSON.stringify(conditions)
    const cooldownMs = options.cooldownMs ?? this.cooldownMs
    const runId = this.insertRun(source, options.mode, filter, urls.length, conditionsJson)

    const candidates: CrawlCandidate[] = []
    const errors: string[] = []
    let fetchedCount = 0
    let truncated = false

    try {
      // 队列式执行：起始 URL + 解析器 nextListUrl 追加翻页；冷却/上限作用于每次抓取；
      // seen 集合保证同 URL 不二次导航（每窗口单导航纪律，防翻页循环）
      const queue: string[] = [...urls]
      const seen = new Set<string>(urls)
      let firstFetch = true
      const parseContext: CrawlParseContext = {
        mode: options.mode,
        filter: options.filter,
        hire_type: options.hire_type,
        keyword: conditions.keyword,
        city: conditions.city
      }
      while (queue.length > 0) {
        if (candidates.length >= this.maxItems) {
          truncated = true
          break
        }
        if (!firstFetch) await this.sleep(cooldownMs)
        firstFetch = false

        const url = queue.shift() as string
        const html = await this.fetchWithRetry(url, errors)
        if (html === null) continue // 重试耗尽：错误已入 errors
        fetchedCount++

        for (const raw of parser.parseList(html, parseContext)) {
          if (candidates.length >= this.maxItems) {
            truncated = true
            break
          }
          let candidate = raw
          if (candidate.detailUrl !== undefined && parser.parseDetail !== undefined) {
            await this.sleep(cooldownMs)
            const detailHtml = await this.fetchWithRetry(candidate.detailUrl, errors)
            if (detailHtml !== null) {
              candidate = parser.parseDetail(detailHtml, candidate)
            }
          }
          candidates.push(candidate)
        }

        // 翻页：解析器从当前页提取下一页 URL（已抓/已在队列的 URL 跳过）
        if (parser.nextListUrl !== undefined) {
          const next = parser.nextListUrl(html, parseContext)
          if (next !== null && !seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }

        // 进度：done=已抓页数，total=已抓+待抓（翻页过程中动态增长）
        this.onProgress?.({ runId, done: fetchedCount, total: fetchedCount + queue.length })
      }
    } catch (err) {
      // 意外错误（如解析器抛错）：留痕标记 failed 后上抛，渲染层可见
      const message = err instanceof Error ? err.message : String(err)
      this.finishRun(runId, 'failed', fetchedCount, candidates, truncated, [
        ...errors,
        `意外错误：${message}`
      ])
      throw err
    }

    const status = fetchedCount === 0 ? 'failed' : errors.length > 0 || truncated ? 'partial' : 'success'
    this.finishRun(runId, status, fetchedCount, candidates, truncated, errors)
    const run = this.getRun(runId) as CrawlRun
    return { run, candidates }
  }

  /** 采集留痕列表（#29 预览页可追溯历史运行；按创建时间倒序）。 */
  runs(): CrawlRun[] {
    const rows = this.db.prepare('SELECT * FROM crawl_runs ORDER BY id DESC').all() as CrawlRunRow[]
    return rows.map((row) => this.mapRun(row))
  }

  /** 单次留痕（含候选快照；#29 确认入库的数据源）。 */
  getRun(id: number): CrawlRun | null {
    const row = this.db.prepare('SELECT * FROM crawl_runs WHERE id = ?').get(id) as CrawlRunRow | undefined
    return row === undefined ? null : this.mapRun(row)
  }

  /** 抓取 URL + 重试（retries 次指数退避）；耗尽返回 null（错误入 errors）。 */
  private async fetchWithRetry(url: string, errors: string[]): Promise<string | null> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.fetcher.fetch(url)
      } catch (err) {
        lastError = err
        if (attempt < this.retries) {
          await this.sleep(this.backoffMs * 2 ** attempt)
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    errors.push(`${url}: ${message}`)
    return null
  }

  private insertRun(
    source: PositionSource,
    mode: CrawlMode,
    filter: string | null,
    urlCount: number,
    conditionsJson: string | null
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO crawl_runs (source, mode, filter, conditions_json, status, url_count, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`
      )
      .run(source, mode, filter, conditionsJson, urlCount, new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  private finishRun(
    runId: number,
    status: CrawlRun['status'],
    fetchedCount: number,
    candidates: CrawlCandidate[],
    truncated: boolean,
    errors: string[]
  ): void {
    this.db
      .prepare(
        `UPDATE crawl_runs SET
          status = ?, fetched_count = ?, candidate_count = ?,
          truncated = ?, candidates_json = ?, errors_json = ?
         WHERE id = ?`
      )
      .run(
        status,
        fetchedCount,
        candidates.length,
        truncated ? 1 : 0,
        JSON.stringify(candidates),
        JSON.stringify(errors),
        runId
      )
  }

  private mapRun(row: CrawlRunRow): CrawlRun {
    return {
      id: row.id,
      source: row.source,
      mode: row.mode,
      filter: row.filter,
      conditions: row.conditions_json === null ? null : (JSON.parse(row.conditions_json) as CrawlConditions),
      status: row.status,
      url_count: row.url_count,
      fetched_count: row.fetched_count,
      candidate_count: row.candidate_count,
      truncated: row.truncated !== 0,
      errors: JSON.parse(row.errors_json) as string[],
      created_at: row.created_at
    }
  }

  /** 留痕候选快照（#29 预览确认的数据源；候选存 candidates_json）。 */
  getCandidates(runId: number): CrawlCandidate[] {
    const row = this.db.prepare('SELECT candidates_json FROM crawl_runs WHERE id = ?').get(runId) as
      | { candidates_json: string }
      | undefined
    return row === undefined ? [] : (JSON.parse(row.candidates_json) as CrawlCandidate[])
  }

  /**
   * 采集预览（F-11/#29）：候选逐条预测入库动作（source_url 命中 → update；
   * dedupe_key company|title|recruit_season 兜底命中 → update；否则 new）+ 缺字段标记
   * （title/end_date 为空 = 缺字段，UI 标「待核实/待补全」）。
   */
  preview(runId: number): CrawlPreview {
    const run = this.getRun(runId)
    if (run === null) throw new CrawlError('run-not-found', `采集记录不存在：${runId}`)

    const items: CrawlPreviewItem[] = this.getCandidates(runId).map((candidate) => {
      const action = this.findExisting(candidate) === undefined ? 'new' : 'update'
      return { candidate, action, missingFields: missingFieldsOf(candidate) }
    })
    return {
      run,
      items,
      stats: {
        inserted: items.filter((i) => i.action === 'new').length,
        updated: items.filter((i) => i.action === 'update').length,
        missing: items.filter((i) => i.missingFields.length > 0).length
      }
    }
  }

  /**
   * 确认导入（F-11/#29）：对勾选候选（source_url 列表）做 upsert——
   * source_url 优先、dedupe_key（company|title|recruit_season）兜底，命中更新而非新建
   * （spec #13-18/19：重复采集刷新 JD/网申窗口；手动与采集同职位合并更新）；
   * 不自动关闭消失岗位（spec：upsert 不自动关闭）。
   */
  confirmImport(runId: number, selectedSourceUrls: string[]): CrawlImportResult {
    const run = this.getRun(runId)
    if (run === null) throw new CrawlError('run-not-found', `采集记录不存在：${runId}`)
    const selected = new Set(selectedSourceUrls)

    let inserted = 0
    let updated = 0
    const upsert = this.db.transaction(() => {
      for (const candidate of this.getCandidates(runId)) {
        if (!selected.has(candidate.source_url)) continue
        const existing = this.findExisting(candidate)
        if (existing === undefined) {
          this.insertCandidate(candidate, run.source)
          inserted++
        } else {
          this.updateCandidate(existing.id, candidate, run.source)
          updated++
        }
      }
    })
    upsert()
    return { inserted, updated }
  }

  /** 查已有职位：source_url 优先，dedupe_key 兜底。 */
  private findExisting(candidate: CrawlCandidate): { id: string } | undefined {
    const byUrl = this.db
      .prepare('SELECT id FROM positions WHERE source_url = ?')
      .get(candidate.source_url) as { id: string } | undefined
    if (byUrl !== undefined) return byUrl
    return this.db.prepare('SELECT id FROM positions WHERE dedupe_key = ?').get(dedupeKeyOf(candidate)) as
      | { id: string }
      | undefined
  }

  private insertCandidate(candidate: CrawlCandidate, source: PositionSource): void {
    const now = new Date().toISOString()
    const hireType = candidate.hire_type ?? '校招'
    this.db
      .prepare(
        `INSERT INTO positions (
          id, company, company_type, title, jd, city, channel, channel_url,
          source, source_url, dedupe_key, recruit_season, batch,
          start_date, end_date, hire_type, salary_min, salary_max, salary_text,
          status, notes, created_at, updated_at
        ) VALUES (
          @id, @company, '其他', @title, @jd, @city, @channel, @channel_url,
          @source, @source_url, @dedupe_key, @recruit_season, @batch,
          @start_date, @end_date, @hire_type, @salary_min, @salary_max, @salary_text,
          'active', '', @now, @now
        )`
      )
      .run({
        id: randomUUID(),
        company: candidate.company,
        title: candidate.title,
        jd: candidate.jd,
        city: candidate.city,
        channel: candidate.channel,
        channel_url: candidate.channel_url,
        source,
        source_url: candidate.source_url,
        dedupe_key: dedupeKeyOf(candidate),
        recruit_season: candidate.recruit_season ?? (hireType === '校招' ? '未知' : ''),
        batch: candidate.batch,
        start_date: candidate.start_date,
        end_date: candidate.end_date,
        hire_type: hireType,
        salary_min: candidate.salary_min ?? null,
        salary_max: candidate.salary_max ?? null,
        salary_text: candidate.salary_text ?? null,
        now
      })
  }

  private updateCandidate(id: string, candidate: CrawlCandidate, source: PositionSource): void {
    const hireType = candidate.hire_type ?? '校招'
    this.db
      .prepare(
        `UPDATE positions SET
          company=@company, title=@title, jd=@jd, city=@city, channel=@channel,
          channel_url=@channel_url, source=@source, source_url=@source_url,
          dedupe_key=@dedupe_key, recruit_season=@recruit_season, batch=@batch,
          start_date=@start_date, end_date=@end_date,
          hire_type=@hire_type, salary_min=@salary_min, salary_max=@salary_max, salary_text=@salary_text,
          updated_at=@now
         WHERE id=@id`
      )
      .run({
        id,
        company: candidate.company,
        title: candidate.title,
        jd: candidate.jd,
        city: candidate.city,
        channel: candidate.channel,
        channel_url: candidate.channel_url,
        source,
        source_url: candidate.source_url,
        dedupe_key: dedupeKeyOf(candidate),
        recruit_season: candidate.recruit_season ?? (hireType === '校招' ? '未知' : ''),
        batch: candidate.batch,
        start_date: candidate.start_date,
        end_date: candidate.end_date,
        hire_type: hireType,
        salary_min: candidate.salary_min ?? null,
        salary_max: candidate.salary_max ?? null,
        salary_text: candidate.salary_text ?? null,
        now: new Date().toISOString()
      })
  }
}


/**
 * 候选缺字段判定（issue #53）：title 为空恒缺；end_date 仅校招缺
 * （社招/实习无网申窗口，end_date 视为「长期有效」，UI 显示长期而非待补全）。
 */
function missingFieldsOf(candidate: CrawlCandidate): string[] {
  const missing: string[] = []
  if (candidate.title.trim() === '') missing.push('title')
  const hireType = candidate.hire_type ?? '校招'
  if (hireType === '校招' && (candidate.end_date === null || candidate.end_date.trim() === '')) {
    missing.push('end_date')
  }
  return missing
}

/**
 * 候选去重键（issue #52）：company|title|hire_type|recruit_season。
 * 缺省招聘类型按校招；社招/实习 recruit_season 为空串（与手动录入一致）。
 */
function dedupeKeyOf(candidate: CrawlCandidate): string {
  const hireType = candidate.hire_type ?? '校招'
  return `${candidate.company}|${candidate.title}|${hireType}|${candidate.recruit_season ?? ''}`
}
