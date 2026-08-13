import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/database'
import { FakeAgentProvider } from './fake-agent-provider'
import { AgentService } from './agent'
import { OptimizeError, OptimizeService } from './optimize'
import { PhotoStore } from './photo-store'
import type { JdAnalysis } from '../../shared/types'
import { PositionService } from './position'
import { ResumeService } from './resume'
import type { Resume } from '../../shared/types/resume'

const JD = `
岗位：后端开发工程师（校招）
要求：Java、Spring Boot、MySQL、Redis、分布式
本科及以上学历，计算机相关专业
`

const baseResume: Resume = {
  meta: { title: '基准简历' },
  basics: { name: '张伟', phone: '13800001234', email: 'z@example.com' },
  education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
  skills: [{ category: '工程能力', text: 'Java、Python 服务端开发' }],
  projects: [{ name: '二手交易平台', techStack: ['Java', 'Spring Boot'] }]
}

const JD_ANALYSIS_JSON = {
  skills: ['Java', 'Spring Boot', 'MySQL', 'Redis'],
  keywords: ['Java', 'Spring Boot', 'MySQL', 'Redis', '分布式'],
  requirements: ['本科及以上'],
  hardRequirements: ['计算机相关专业']
}

const GAPS_JSON = { gaps: ['缺少分布式项目经验', '缺少高并发实践'] }

const OPTIMIZED_JSON = {
  resume: {
    meta: { title: '优化稿' },
    basics: { name: '张伟', phone: '13800001234', email: 'z@example.com' },
    education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }],
    skills: [
      { category: '工程能力', text: 'Java、Python 服务端开发' },
      { category: '科研能力', text: 'Spring Boot 框架应用' }
    ],
    projects: [{ name: '二手交易平台', techStack: ['Java', 'Spring Boot'] }]
  },
  changes: [{ section: 'projects', before: '…', after: '…', reason: '突出与 JD 相关的技术栈' }]
}

interface Harness {
  provider: FakeAgentProvider
  optimize: OptimizeService
  jobId: string
  resumeId: string
  db: ReturnType<typeof openDatabase>
  prompts: () => string[]
}

/** 脚本化 fake：按轮次标记返回 JSON；可注入非法首轮输出测试修正。 */
function makeHarness(options: {
  badFirstResume?: boolean
  badJdJson?: boolean
} = {}): Harness {
  const db = openDatabase(':memory:')
  const positions = new PositionService(db)
  const resumes = new ResumeService(db)
  const prompts: string[] = []
  const provider = new FakeAgentProvider({
    onPrompt: (prompt) => {
      prompts.push(prompt) // 会话 dispose 后仍可断言（session 会从 provider.sessions 移除）
      if (prompt.includes('[优化流程 1/3')) {
        return options.badJdJson ? '不是 JSON' : JSON.stringify(JD_ANALYSIS_JSON)
      }
      if (prompt.includes('[优化流程 2/3')) return JSON.stringify(GAPS_JSON)
      if (prompt.includes('[优化流程 3/3')) {
        return options.badFirstResume
          ? JSON.stringify({ resume: { meta: {}, basics: {} }, changes: [] }) // 缺 education → schema 非法
          : JSON.stringify(OPTIMIZED_JSON)
      }
      if (prompt.includes('[修正：上次输出未通过简历 schema 校验]')) {
        return JSON.stringify(OPTIMIZED_JSON) // 修正轮返回合法输出
      }
      return 'echo'
    }
  })
  const optimize = new OptimizeService(db, positions, resumes, new AgentService(provider))
  const job = positions.create({
    company: '腾讯',
    company_type: '大厂',
    title: '后端开发工程师',
    jd: JD,
    recruit_season: '2026秋招'
  })
  const resume = resumes.create(baseResume)
  return {
    db,
    provider,
    optimize,
    jobId: job.id,
    resumeId: resume.meta.id as string,
    prompts: () => [...prompts]
  }
}

describe('OptimizeService 三轮编排（F-07/#28）', () => {
  it('fake provider 下三轮流程：JD 解析 → 缺口评估 → 生成优化稿+changes，strict 约束写入生成 prompt', async () => {
    const h = makeHarness()
    const result = await h.optimize.run(h.jobId, h.resumeId, 'strict')

    expect(h.prompts()).toHaveLength(3)
    expect(h.prompts()[0]).toContain('[优化流程 1/3')
    expect(h.prompts()[1]).toContain('[优化流程 2/3')
    expect(h.prompts()[2]).toContain('[优化流程 3/3')

    // strict 约束写入 prompt（验收）
    expect(h.prompts()[2]).toMatch(/strict/)
    expect(h.prompts()[2]).toMatch(/不得虚构/)

    expect(result.jdAnalysis.skills).toEqual(JD_ANALYSIS_JSON.skills)
    expect(result.gaps).toEqual(GAPS_JSON.gaps)
    expect(result.optimizedResume.basics.name).toBe('张伟')
    expect(result.optimizedResume.education).toHaveLength(1)
    expect(result.changes).toHaveLength(1)
    expect(result.mode).toBe('strict')
  })

  it('balanced 模式：生成 prompt 使用 balanced 约束文案', async () => {
    const h = makeHarness()
    await h.optimize.run(h.jobId, h.resumeId, 'balanced')
    const genPrompt = h.prompts()[2]
    expect(genPrompt).toMatch(/balanced/)
    expect(genPrompt).toMatch(/适度润色/)
  })

  it('输出过 resume schema 校验（合法输出入库前经 assertValidResume）', async () => {
    const h = makeHarness()
    const result = await h.optimize.run(h.jobId, h.resumeId)
    // 结果 resume 可被 ResumeService 直接入库（schema 校验通过）
    const stored = new ResumeService(h.db).create(result.optimizedResume)
    expect(stored.meta.id).toBeTruthy()
  })

  it('生成轮首次输出非法 → 自动修正一轮后成功（修正 prompt 带校验问题定位）', async () => {
    const h = makeHarness({ badFirstResume: true })
    const result = await h.optimize.run(h.jobId, h.resumeId)

    expect(h.prompts()).toHaveLength(4)
    expect(h.prompts()[3]).toContain('[修正：上次输出未通过简历 schema 校验]')
    expect(result.optimizedResume.basics.name).toBe('张伟')
  })

  it('修正后仍非法 → 抛 ResumeValidationError（不产出未过校验的稿）', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const resumes = new ResumeService(db)
    const provider = new FakeAgentProvider({
      onPrompt: (prompt) => {
        if (prompt.includes('[优化流程 1/3')) return JSON.stringify(JD_ANALYSIS_JSON)
        if (prompt.includes('[优化流程 2/3')) return JSON.stringify(GAPS_JSON)
        return JSON.stringify({ resume: { meta: {}, basics: {} }, changes: [] }) // 始终非法
      }
    })
    const optimize = new OptimizeService(db, positions, resumes, new AgentService(provider))
    const job = positions.create({
      company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
    })
    const resume = resumes.create(baseResume)

    await expect(optimize.run(job.id, resume.meta.id as string)).rejects.toThrowError(
      /不符合 resume.schema.json/
    )
  })
})

describe('OptimizeService jd_analysis 缓存（F-07/#28）', () => {
  it('JD 未变 → 第二次运行跳过 JD 解析轮（缓存命中）；缓存写入 positions.jd_analysis', async () => {
    const h = makeHarness()
    await h.optimize.run(h.jobId, h.resumeId)
    const firstCount = h.prompts().length
    expect(firstCount).toBe(3)

    const row = h.db.prepare('SELECT jd_analysis FROM positions WHERE id = ?').get(h.jobId) as {
      jd_analysis: string | null
    }
    expect(row.jd_analysis).toBeTruthy()
    const cached = JSON.parse(row.jd_analysis as string) as JdAnalysis
    expect(cached.skills).toEqual(JD_ANALYSIS_JSON.skills)
    expect(cached.jdFingerprint).toBeTruthy()

    await h.optimize.run(h.jobId, h.resumeId)
    expect(h.prompts()).toHaveLength(firstCount + 2) // 仅缺口评估 + 生成
  })

  it('JD 变更 → 缓存失效重算（再次三轮；jd_analysis 刷新）', async () => {
    const h = makeHarness()
    await h.optimize.run(h.jobId, h.resumeId)
    const firstCount = h.prompts().length

    // 更新 JD（#20 update 服务）
    h.db.prepare('UPDATE positions SET jd = ? WHERE id = ?').run(JD + '\n新增：Golang 加分', h.jobId)

    await h.optimize.run(h.jobId, h.resumeId)
    expect(h.prompts()).toHaveLength(firstCount + 3) // 缓存失效 → 完整三轮
  })

  it('JD 解析返回非法 JSON → OptimizeError(bad-json) 且不写缓存', async () => {
    const h = makeHarness({ badJdJson: true })
    await expect(h.optimize.run(h.jobId, h.resumeId)).rejects.toThrowError(OptimizeError)
    await expect(h.optimize.run(h.jobId, h.resumeId)).rejects.toThrowError(/JSON|未找到/)
    const row = h.db.prepare('SELECT jd_analysis FROM positions WHERE id = ?').get(h.jobId) as {
      jd_analysis: string | null
    }
    expect(row.jd_analysis).toBeNull()
  })
})

describe('OptimizeService 边界', () => {
  it('JD 为空 → OptimizeError(no-jd)', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const resumes = new ResumeService(db)
    const optimize = new OptimizeService(db, positions, resumes, new AgentService(new FakeAgentProvider()))
    const job = positions.create({
      company: '腾讯', company_type: '大厂', title: '后端', jd: '', recruit_season: '2026秋招'
    })
    const resume = resumes.create(baseResume)

    await expect(optimize.run(job.id, resume.meta.id as string)).rejects.toThrowError(/JD 为空/)
  })

  it('简历不存在 → 报错；职位不存在 → PositionError not-found', async () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const resumes = new ResumeService(db)
    const optimize = new OptimizeService(db, positions, resumes, new AgentService(new FakeAgentProvider()))
    const job = positions.create({
      company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
    })

    await expect(optimize.run(job.id, 'no-such-resume')).rejects.toThrowError(/简历不存在/)
    await expect(optimize.run('no-such-job', 'x')).rejects.toThrowError(/职位不存在/)
  })

  it('照片继承（ADR-0009）：基准照片复制为优化稿副本；源缺失则不携带', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimize-photo-'))
    try {
      writeFileSync(join(dir, 'base.png'), 'png-bytes')
      const photos = new PhotoStore(dir)
      const db = openDatabase(':memory:')
      const positions = new PositionService(db)
      const resumes = new ResumeService(db, photos)
      const provider = new FakeAgentProvider({
        onPrompt: (prompt) => {
          if (prompt.includes('[优化流程 1/3')) return JSON.stringify(JD_ANALYSIS_JSON)
          if (prompt.includes('[优化流程 2/3')) return JSON.stringify(GAPS_JSON)
          if (prompt.includes('[优化流程 3/3')) return JSON.stringify(OPTIMIZED_JSON)
          return 'echo'
        }
      })
      const optimize = new OptimizeService(db, positions, resumes, new AgentService(provider), { photos })
      const job = positions.create({
        company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
      })
      const resume = resumes.create({ ...baseResume, basics: { ...baseResume.basics, photo: 'base.png' } })

      const result = await optimize.run(job.id, resume.meta.id as string)
      const inherited = result.optimizedResume.basics?.photo
      expect(inherited).toBeDefined()
      expect(inherited).not.toBe('base.png') // 独立副本，不引用基准文件名
      expect(existsSync(join(dir, inherited as string))).toBe(true)
      expect(existsSync(join(dir, 'base.png'))).toBe(true) // 基准照片保留

      // 基准照片文件缺失 → 优化稿不携带照片，不阻塞生成
      const resume2 = resumes.create({ ...baseResume, basics: { ...baseResume.basics, photo: 'missing.png' } })
      const result2 = await optimize.run(job.id, resume2.meta.id as string)
      expect(result2.optimizedResume.basics?.photo).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
