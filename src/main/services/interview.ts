import { randomUUID } from 'node:crypto'
import type { Db } from '../db/migrations'
import type { AgentService, AgentSession } from './agent'
import type { PositionService } from './position'
import type { ResumeService } from './resume'
import type { TopicService } from './topic'
import type { JdAnalysis } from '../../shared/types'

/**
 * 模拟面试编排（F-23/#37）。
 * - start(jobId, style)：注入 jd_analysis / 目标职位优化稿 / learned 清单 → 开场白；
 * - answer：技术面阶段推进（硬性要求 → 项目深挖 → learned 检验），每轮由 agent 返回
 *   {difficulty, question}——动态难度（deep 深挖 / standard / basic 降级）写入下一轮 prompt；
 *   阶段耗尽 → 反问阶段（可多轮）→ 用户主动 end 收尾；
 * - interrupt：abort 当前生成 + steer 插队提示；
 * - transcript：逐轮追加落库（interviews 表），end 后 status=ended（#39 复盘数据源）。
 */

export type InterviewStyle = 'real' | 'coach' | 'strict'
export type InterviewDifficulty = 'deep' | 'standard' | 'basic'

export interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  ts: string
}

export interface InterviewRecord {
  id: string
  job_id: string | null
  style: InterviewStyle
  transcript: TranscriptEntry[]
  status: 'in_progress' | 'ended'
  review: unknown
  created_at: string
  updated_at: string
}

export interface InterviewSessionInfo {
  sessionId: string
  interviewId: string
  opening: string
}

export class InterviewError extends Error {
  constructor(
    readonly code: 'session-not-found',
    message: string
  ) {
    super(message)
    this.name = 'InterviewError'
  }
}

interface SessionState {
  session: AgentSession
  interviewId: string
  style: InterviewStyle
  jobId: string
  /** 技术面阶段游标。 */
  phase: 'opening' | 'technical' | 'questions' | 'closing'
  stage: 'hard' | 'project' | 'learned'
  stageIndex: number
  stages: { hard: string[]; project: string[]; learned: string[] }
  questionRounds: number
  /** pending difficulty from last answer (deep 深挖 / basic 降级). */
  pendingDifficulty: InterviewDifficulty
}

const STYLE_PROMPTS: Record<InterviewStyle, string> = {
  real: '风格（real）：扮演真实面试官，追问细节、验证真实性，态度中立。',
  coach: '风格（coach）：扮演教练式面试官，多鼓励、给提示、引导思考。',
  strict: '风格（strict）：扮演严格面试官，挑错、施压、要求精确。'
}

export class InterviewService {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly db: Db,
    private readonly positions: PositionService,
    private readonly resumes: ResumeService,
    private readonly topics: TopicService,
    private readonly agent: AgentService
  ) {}

  async start(jobId: string, style: InterviewStyle): Promise<InterviewSessionInfo> {
    const position = this.positions.get(jobId) // not-found
    const jdAnalysis = this.readJdAnalysis(jobId)
    const optimized = this.resumes
      .list()
      .find((r) => r.meta.targetJobId === jobId) // 目标职位优化稿（#34 确认入库后）
    const learned = this.topics
      .list({ status: 'learned' })
      .filter((t) => t.job_id === jobId)
      .map((t) => t.title)

    const session = await this.agent.createSession('interview')
    const interviewId = `iv-${randomUUID()}`
    const now = new Date().toISOString()
    this.db
      .prepare('INSERT INTO interviews (id, job_id, style, transcript, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(interviewId, jobId, style, '[]', 'in_progress', now, now)

    const stages = {
      hard: jdAnalysis?.hardRequirements ?? [],
      project: (optimized?.projects ?? []).map((p) => `${p.name ?? ''}（${(p.techStack ?? []).join('/')}）`),
      learned
    }
    const state: SessionState = {
      session,
      interviewId,
      style,
      jobId,
      phase: 'opening',
      stage: 'hard',
      stageIndex: 0,
      stages,
      questionRounds: 0,
      pendingDifficulty: 'standard'
    }
    this.sessions.set(`iv-${session.id}`, state)

    const prompt = [
      '[面试开场] 你是校招技术面试官，开始面试。',
      STYLE_PROMPTS[style],
      `职位：${position.company} · ${position.title}`,
      `JD 分析：${JSON.stringify(jdAnalysis ?? {})}`,
      `优化简历：${JSON.stringify(optimized ?? {})}`,
      `候选人已掌握：${learned.join('、') || '（无）'}`,
      '请用一段话开场并请候选人做自我介绍。'
    ].join('\n')
    const opening = await session.prompt(prompt)
    this.appendTranscript(state, 'assistant', opening)
    return { sessionId: `iv-${session.id}`, interviewId, opening }
  }

  /** 发送回答 → 返回面试官下一轮回复。 */
  async answer(sessionId: string, text: string): Promise<string> {
    const state = this.requireSession(sessionId)
    this.appendTranscript(state, 'user', text)

    if (state.phase === 'questions') {
      state.questionRounds++
      if (state.questionRounds >= 2) {
        state.phase = 'closing'
        const prompt = [
          '[收尾] 候选人反问已结束。请致谢并告知面试流程结束，等待复盘。',
          STYLE_PROMPTS[state.style]
        ].join('\n')
        const reply = await state.session.prompt(prompt)
        this.appendTranscript(state, 'assistant', reply)
        return reply
      }
      const reply = await state.session.prompt(
        `[反问阶段] 候选人的问题：「${text}」。请作答，然后再次询问是否还有其他问题。`
      )
      this.appendTranscript(state, 'assistant', reply)
      return reply
    }

    if (state.phase === 'closing') {
      const reply = await state.session.prompt(`[收尾] 候选人补充：「${text}」。请简短回应。`)
      this.appendTranscript(state, 'assistant', reply)
      return reply
    }

    // 技术面：取下一阶段条目（硬性要求 → 项目深挖 → learned 检验）
    const item = this.nextStageItem(state)
    if (item === null) {
      state.phase = 'questions'
      const reply = await state.session.prompt(
        `[反问阶段] 技术问题已问完。请基于候选人的回答做简短小结，然后询问「你有什么想问我的吗？」`
      )
      this.appendTranscript(state, 'assistant', reply)
      return reply
    }

    const stageLabel = { hard: '硬性要求', project: '项目深挖', learned: 'learned 检验' }[state.stage]
    const difficultyLabel = {
      deep: 'deep：上一轮答得好，深挖细节',
      standard: 'standard：正常难度',
      basic: 'basic：上一轮答得不好，降级到基础概念'
    }[state.pendingDifficulty]
    const prompt = [
      `[技术面-${stageLabel}] 针对「${item}」继续提问。`,
      STYLE_PROMPTS[state.style],
      `本轮难度：${difficultyLabel}`,
      '输出 JSON：{"difficulty": "deep|standard|basic", "question": "问题文本"}',
      `上一轮回答：「${text.slice(0, 200)}」`,
      '根据回答质量决定难度：答得好 deep 深挖、一般 standard、明显不会 basic 降级到基础问题。'
    ].join('\n')
    const reply = await state.session.prompt(prompt)
    const { difficulty, question } = parseQuestion(reply)
    // 动态难度：本轮评判结果驱动下一轮提示（deep 深挖 / basic 降级）
    state.pendingDifficulty = difficulty
    state.stageIndex++
    this.appendTranscript(state, 'assistant', question ?? reply)
    return question ?? reply
  }

  /** 打断当前生成并插队（abort + steer）。 */
  /** 补充说明：当前生成完全结束后排队投递（面试补充）。 */
  async followUp(sessionId: string, text: string): Promise<void> {
    const state = this.requireSession(sessionId)
    await state.session.followUp(text)
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId)
    await state.session.abort()
    await state.session.steer('请直接给出下一问（或简短重答上一问），不要重复已说内容。')
  }

  /** 结束面试：收尾确认 + transcript 终态落库。 */
  async end(sessionId: string): Promise<InterviewRecord> {
    const state = this.requireSession(sessionId)
    if (state.phase !== 'closing' && state.phase !== 'questions') {
      const reply = await state.session.prompt(
        `[收尾] 面试即将结束（候选人主动结束）。请致谢并总结。`
      )
      this.appendTranscript(state, 'assistant', reply)
    }
    state.phase = 'closing'
    const now = new Date().toISOString()
    this.db
      .prepare("UPDATE interviews SET status = 'ended', updated_at = ? WHERE id = ?")
      .run(now, state.interviewId)
    const record = this.getInterview(state.interviewId) as InterviewRecord
    state.session.dispose()
    this.sessions.delete(sessionId)
    return record
  }

  /** 单次面试记录（transcript/status；#39 复盘写入 review）。 */
  getInterview(id: string): InterviewRecord | null {
    const row = this.db.prepare('SELECT * FROM interviews WHERE id = ?').get(id) as
      | (Omit<InterviewRecord, 'transcript'> & { transcript: string })
      | undefined
    if (row === undefined) return null
    return {
      ...row,
      transcript: JSON.parse(row.transcript) as TranscriptEntry[]
    }
  }

  /** 已完成面试历史（#41 复盘视图数据源）。 */
  history(): InterviewRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM interviews WHERE status = 'ended' ORDER BY created_at DESC")
      .all() as Array<Omit<InterviewRecord, 'transcript'> & { transcript: string }>
    return rows.map((row) => ({
      ...row,
      transcript: JSON.parse(row.transcript) as TranscriptEntry[]
    }))
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId)
    if (state === undefined) throw new InterviewError('session-not-found', `面试会话不存在：${sessionId}`)
    return state
  }

  /** 取下一技术面条目（阶段耗尽自动推进到下一阶段；全部耗尽 → null）。 */
  private nextStageItem(state: SessionState): string | null {
    const stages: Array<{ key: 'hard' | 'project' | 'learned' }> = [
      { key: 'hard' },
      { key: 'project' },
      { key: 'learned' }
    ]
    while (true) {
      const items = state.stages[state.stage]
      if (state.stageIndex < items.length) {
        return items[state.stageIndex] ?? null
      }
      const idx = stages.findIndex((s) => s.key === state.stage)
      const next = stages[idx + 1]
      if (next === undefined) return null
      state.stage = next.key
      state.stageIndex = 0
    }
  }


  private appendTranscript(state: SessionState, role: 'user' | 'assistant', text: string): void {
    const record = this.getInterview(state.interviewId)
    const transcript = record?.transcript ?? []
    transcript.push({ role, text, ts: new Date().toISOString() })
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE interviews SET transcript = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(transcript), now, state.interviewId)
  }

  private readJdAnalysis(jobId: string): JdAnalysis | null {
    const row = this.db.prepare('SELECT jd_analysis FROM positions WHERE id = ?').get(jobId) as
      | { jd_analysis: string | null }
      | undefined
    if (row === undefined || row.jd_analysis === null) return null
    try {
      return JSON.parse(row.jd_analysis) as JdAnalysis
    } catch {
      return null
    }
  }
}

/** 解析追问输出：JSON {difficulty, question}；非 JSON → 全文作为问题（standard）。 */
function parseQuestion(reply: string): { difficulty: InterviewDifficulty; question: string | null } {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)
  const candidate = fence !== null ? fence[1] : reply
  const start = candidate.indexOf('{')
  if (start !== -1) {
    try {
      const parsed = JSON.parse(candidate.slice(start, candidate.lastIndexOf('}') + 1)) as {
        difficulty?: string
        question?: string
      }
      const difficulty = (['deep', 'standard', 'basic'] as const).includes(
        parsed.difficulty as InterviewDifficulty
      )
        ? (parsed.difficulty as InterviewDifficulty)
        : 'standard'
      return { difficulty, question: parsed.question ?? null }
    } catch {
      // 非 JSON：全文当问题
    }
  }
  return { difficulty: 'standard', question: reply }
}
