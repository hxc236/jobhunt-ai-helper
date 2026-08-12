import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { TopicService } from './topic'
import { PositionService } from './position'
import type { JdAnalysis } from '../../shared/types'

const JD = '要求：Java、Spring Boot、MySQL、分布式；本科及以上，计算机相关专业'

function seedJob(
  jd: string = JD,
  now: () => string = () => new Date().toISOString()
): { db: ReturnType<typeof openDatabase>; topics: TopicService; jobId: string } {
  const db = openDatabase(':memory:')
  const positions = new PositionService(db)
  const topics = new TopicService(db, positions, now)
  const job = positions.create({
    company: '腾讯',
    company_type: '大厂',
    title: '后端开发工程师',
    jd,
    recruit_season: '2026秋招'
  })
  // 写入 jd_analysis 缓存（模拟 #28 优化流程产出）
  const analysis: JdAnalysis = {
    skills: ['Java', 'Spring Boot', 'MySQL', 'Redis'],
    keywords: ['Java', '分布式'],
    requirements: ['本科及以上'],
    hardRequirements: ['计算机相关专业', '分布式经验'],
    parsedAt: '2026-08-01T00:00:00Z',
    jdFingerprint: 'fp'
  }
  db.prepare('UPDATE positions SET jd_analysis = ? WHERE id = ?').run(JSON.stringify(analysis), job.id)
  return { db, topics, jobId: job.id }
}

describe('TopicService.generateFromJob（F-19/#33）', () => {
  it('JD 分析来源生成：hardRequirements → 优先级 1，skills → 优先级 2；来源/职位关联正确', () => {
    const { topics, jobId } = seedJob()
    const result = topics.generateFromJob(jobId)

    expect(result.created).toHaveLength(6) // 2 hard + 4 mentioned
    const byPriority = Object.fromEntries(result.created.map((t) => [t.title, t]))
    expect(byPriority['计算机相关专业']).toMatchObject({ priority: 1, source: 'hard', job_id: jobId, status: 'todo' })
    expect(byPriority['分布式经验']).toMatchObject({ priority: 1, source: 'hard' })
    expect(byPriority['Java']).toMatchObject({ priority: 2, source: 'mentioned' })
    expect(byPriority['Redis']).toMatchObject({ priority: 2, source: 'mentioned' })
    expect(byPriority['MySQL']).toMatchObject({ priority: 2 })
    expect(byPriority['Spring Boot']).toMatchObject({ priority: 2 })
  })

  it('缺口 + 项目 techStack 来源：优先级 3/4（带 extras 时）', () => {
    const { topics, jobId } = seedJob()
    const result = topics.generateFromJob(jobId, {
      gaps: ['缺少高并发实践', '缺少分布式项目'],
      techStack: ['Java', 'Spring Boot', 'Redis', 'Kafka', 'Elasticsearch']
    })

    const titles = new Set(result.created.map((t) => t.title))
    expect(titles.has('缺少高并发实践')).toBe(true)
    expect(titles.has('缺少分布式项目')).toBe(true)
    expect(titles.has('Kafka')).toBe(true)
    expect(titles.has('Elasticsearch')).toBe(true)
    const gap = result.created.find((t) => t.title === '缺少高并发实践')
    const project = result.created.find((t) => t.title === 'Kafka')
    expect(gap?.priority).toBe(3)
    expect(gap?.source).toBe('gap')
    expect(project?.priority).toBe(4)
    expect(project?.source).toBe('project')
  })

  it('无缺口来源时降级生成：仅 JD 分析来源（不报错）', () => {
    const { topics, jobId } = seedJob()
    const result = topics.generateFromJob(jobId) // 无 extras
    expect(result.created.every((t) => t.source === 'hard' || t.source === 'mentioned')).toBe(true)
    expect(result.skipped).toBe(0)
  })

  it('去重：同职位重复生成 → 跳过已存在的 title（skipped 计数），不产生重复行', () => {
    const { topics, jobId } = seedJob()
    const first = topics.generateFromJob(jobId)
    const second = topics.generateFromJob(jobId)

    expect(second.created).toHaveLength(0)
    expect(second.skipped).toBe(first.created.length)
    expect(topics.list()).toHaveLength(first.created.length)
  })

  it('不同职位同 title 不互相去重（job_id 维度）', () => {
    const { topics, jobId } = seedJob()
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const other = positions.create({
      company: '华为', company_type: '大厂', title: '软件工程师', jd: JD, recruit_season: '2026秋招'
    })
    const analysis: JdAnalysis = {
      skills: ['Java'], keywords: [], requirements: [], hardRequirements: ['分布式经验'],
      parsedAt: 'x', jdFingerprint: 'fp2'
    }
    db.prepare('UPDATE positions SET jd_analysis = ? WHERE id = ?').run(JSON.stringify(analysis), other.id)
    const topics2 = new TopicService(db, positions)

    topics.generateFromJob(jobId)
    const result = topics2.generateFromJob(other.id)
    expect(result.created).toHaveLength(2) // 与职位1的条目不冲突
  })

  it('职位无 jd_analysis 缓存 → 降级空生成（created=0，不报错）', () => {
    const db = openDatabase(':memory:')
    const positions = new PositionService(db)
    const topics = new TopicService(db, positions)
    const job = positions.create({
      company: '腾讯', company_type: '大厂', title: '后端', jd: JD, recruit_season: '2026秋招'
    })
    const result = topics.generateFromJob(job.id)
    expect(result.created).toHaveLength(0)
  })

  it('职位不存在 → 报错', () => {
    const { topics } = seedJob()
    expect(() => topics.generateFromJob('no-such-job')).toThrowError(/职位不存在/)
  })
})

describe('TopicService 人工 CRUD 与三态（F-19/#33 验收）', () => {
  it('create（manual，优先级 5）→ list → update → setStatus → delete 全链路', () => {
    // 注入递增时钟：断言 updated_at 刷新（默认真实时间可能同毫秒）
    let tick = 0
    const { topics } = seedJob(JD, () => `2026-08-13T00:00:00.${String(tick++).padStart(3, '0')}Z`)
    const created = topics.create({ title: '学习 Kafka 深入原理', note: '配合项目实践', jobId: null })
    expect(created).toMatchObject({
      title: '学习 Kafka 深入原理',
      status: 'todo',
      priority: 5,
      source: 'manual',
      job_id: null
    })

    const updated = topics.update(created.id, { title: 'Kafka 原理与实践', note: '深入' })
    expect(updated.title).toBe('Kafka 原理与实践')
    expect(updated.note).toBe('深入')
    expect(updated.updated_at).not.toBe(created.updated_at)

    const learning = topics.setStatus(created.id, 'learning')
    expect(learning.status).toBe('learning')
    const learned = topics.setStatus(created.id, 'learned')
    expect(learned.status).toBe('learned')

    topics.delete(created.id)
    expect(topics.list().find((t) => t.id === created.id)).toBeUndefined()
  })

  it('非法状态/优先级校验；不存在 id → 报错', () => {
    const { topics } = seedJob()
    const created = topics.create({ title: 'x' })
    expect(() => topics.setStatus(created.id, 'done' as never)).toThrowError(/状态/)
    expect(() => topics.update('no-such', { title: 'y' })).toThrowError(/不存在/)
    expect(() => topics.delete('no-such')).toThrowError(/不存在/)
  })

  it('createInterviewSuggestion：source=interview 回填；同职位同标题去重返回 null', () => {
    const { topics, jobId } = seedJob()
    const created = topics.createInterviewSuggestion('分布式一致性', '参考：CAP 与 Raft', jobId)
    expect(created).toMatchObject({ title: '分布式一致性', source: 'interview', priority: 5, job_id: jobId })
    expect(created?.note).toBe('参考：CAP 与 Raft')

    expect(topics.createInterviewSuggestion('分布式一致性', '参考 x', jobId)).toBeNull() // 去重
    expect(topics.createInterviewSuggestion('  ', 'x', jobId)).toBeNull() // 空标题
  })

  it('list 支持按状态/职位筛选', () => {
    const { topics, jobId } = seedJob()
    topics.generateFromJob(jobId)
    topics.setStatus(topics.list()[0]!.id, 'learned')

    expect(topics.list({ status: 'learned' })).toHaveLength(1)
    expect(topics.list({ jobId })).toHaveLength(6)
    expect(topics.list({ status: 'todo' })).toHaveLength(5)
  })
})
