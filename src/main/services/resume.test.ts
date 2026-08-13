import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { ResumeValidationError } from './resume-schema'
import { PhotoStore } from './photo-store'
import { ResumeNotFoundError, ResumeService } from './resume'
import type { Resume } from '../../shared/types/resume'
import soeResume from './fixtures/resume-soe.json'
import techResume from './fixtures/resume-tech.json'

function makeService(): ResumeService {
  return new ResumeService(openDatabase(':memory:'))
}

/** 最小合法简历（schema 只要求 meta/basics.name/education[].school|degree|major）。 */
function baseResume(): Resume {
  return {
    meta: {},
    basics: { name: '张伟' },
    education: [{ school: '北京理工大学', degree: '本科', major: '计算机科学与技术' }]
  }
}

/** 构造故意非法载荷（绕过 TS 结构校验，运行时由 ajv 把关）。 */
function invalidResume(payload: unknown): Resume {
  return payload as Resume
}

describe('ResumeService', () => {
  describe('schema 校验', () => {
    const invalidCases: Array<[string, unknown]> = [
      ['顶层不是对象', [1, 2, 3]],
      ['缺 meta', { basics: { name: '张伟' }, education: [] }],
      ['缺 education', { meta: {}, basics: { name: '张伟' } }],
      ['basics 缺 name', { meta: {}, basics: {}, education: [] }],
      ['basics 不是对象', { meta: {}, basics: '张伟', education: [] }],
      ['education 不是数组', { meta: {}, basics: { name: '张伟' }, education: { school: 'x' } }],
      ['education 条目缺 major', { meta: {}, basics: { name: '张伟' }, education: [{ school: 'X大学', degree: '本科' }] }],
      ['education.endDate 为数字', { meta: {}, basics: { name: '张伟' }, education: [{ school: 'X大学', degree: '本科', major: '计算机', endDate: 2026 }] }],
      ['gender 非法枚举', { meta: {}, basics: { name: '张伟', gender: '其他' }, education: [] }],
      ['skills.proficiency 非法枚举', { meta: {}, basics: { name: '张伟' }, education: [], skills: [{ category: '语言', items: ['Java'], proficiency: '精通' }] }],
      ['meta.updatedAt 非 date-time', { meta: { updatedAt: '2026-08-12' }, basics: { name: '张伟' }, education: [] }]
    ]

    it.each(invalidCases)('create 拒绝非法 JSON：%s', (_label, input) => {
      const svc = makeService()
      expect(() => svc.create(input as Resume)).toThrow(ResumeValidationError)
      expect(svc.list()).toEqual([]) // 拒绝时不落库
    })

    it('校验问题带 JSON Pointer 定位（渲染层校验错误定位依据）', () => {
      const svc = makeService()
      try {
        svc.create(
          invalidResume({
            meta: {},
            basics: { name: '张伟' },
            education: [{ school: 'X大学', degree: '本科', major: '计算机', endDate: 2026 }]
          })
        )
        expect.unreachable('应当抛出 ResumeValidationError')
      } catch (error) {
        expect(error).toBeInstanceOf(ResumeValidationError)
        const issues = (error as ResumeValidationError).issues
        expect(issues.some((issue) => issue.instancePath === '/education/0/endDate')).toBe(true)
      }
    })

    it('education.endDate 允许 null（应届未毕业）——修复 prototype 的 type "string, null" 缺陷', () => {
      const svc = makeService()
      const created = svc.create({
        meta: {},
        basics: { name: '张伟' },
        education: [{ school: 'X大学', degree: '本科', major: '计算机', endDate: null }]
      })
      expect(created.meta.id).toMatch(/^res-/)
    })

    it('#7 定稿样例（技术向/国企向 fixture）通过校验并可入库', () => {
      const svc = makeService()
      svc.create(techResume as Resume)
      svc.create(soeResume as Resume)
      expect(svc.list()).toHaveLength(2)
    })

    it('v2 拒绝旧字段：技能 items/proficiency、项目 role/highlights/link（ADR-0009）', () => {
      const svc = makeService()
      const legacy = {
        meta: {},
        basics: { name: '张伟' },
        education: [{ school: 'X大学', degree: '本科', major: '计算机', honors: ['奖学金'] }],
        skills: [{ category: '编程语言', items: ['Java'], proficiency: '熟练' }],
        projects: [{ name: '平台', role: '后端', highlights: ['要点'], link: 'https://x' }]
      }
      try {
        svc.create(legacy as unknown as Resume)
        expect.unreachable('应当抛出 ResumeValidationError')
      } catch (error) {
        expect(error).toBeInstanceOf(ResumeValidationError)
        const issues = (error as ResumeValidationError).issues
        // additionalProperties:false 在对象级报错（/skills/0 而非 /skills/0/items）
        expect(issues.some((i) => i.instancePath === '/skills/0' && i.keyword === 'additionalProperties')).toBe(true)
        expect(issues.some((i) => i.instancePath === '/projects/0' && i.keyword === 'additionalProperties')).toBe(true)
        // 荣誉旧位置（education 条目内）同样被拒
        expect(issues.some((i) => i.instancePath === '/education/0' && i.keyword === 'additionalProperties')).toBe(true)
        // 非三分类枚举同时被拒
        expect(issues.some((i) => i.instancePath === '/skills/0/category' && i.keyword === 'enum')).toBe(true)
      }
      expect(svc.list()).toEqual([])
    })

    it('v2 技能分类枚举约束：非三分类拒绝；photo 可选字符串接受', () => {
      const svc = makeService()
      expect(() =>
        svc.create({
          meta: {},
          basics: { name: '张伟' },
          education: [],
          skills: [{ category: '语言', text: 'Java' }]
        } as unknown as Resume)
      ).toThrow(ResumeValidationError)
      const created = svc.create({
        meta: {},
        basics: { name: '张伟', photo: 'res-x.jpg' },
        education: [],
        skills: [{ category: '工程能力', text: 'Java 服务端开发' }]
      })
      expect(created.basics.photo).toBe('res-x.jpg')
    })

    it('v2 科研经历：合法 research 接受；多余字段/缺字段组合被拒', () => {
      const svc = makeService()
      const created = svc.create({
        meta: {},
        basics: { name: '张伟' },
        education: [],
        research: [
          {
            title: '基于 Transformer 的 NER 研究',
            startDate: '2025-03',
            endDate: '2025-09',
            description: '低资源 NER 迁移方法研究',
            achievement: 'EI 论文一篇'
          }
        ]
      })
      expect(created.research?.[0].achievement).toBe('EI 论文一篇')
      // 未定义字段（如 role）被 additionalProperties 拒绝
      expect(() =>
        svc.create({
          meta: {},
          basics: { name: '张伟' },
          education: [],
          research: [{ title: '课题', role: '组长' }]
        } as unknown as Resume)
      ).toThrow(ResumeValidationError)
      // 旧数据（无 research）依旧通过（可选字段）
      const legacy = svc.create({ meta: {}, basics: { name: '张伟' }, education: [] })
      expect(legacy.research).toBeUndefined()
    })
  })

  describe('create（多份基准简历）', () => {
    it('多份基准简历可共存，id 互异且由服务端生成', () => {
      const svc = makeService()
      const tech = svc.create(techResume as Resume)
      const soe = svc.create(soeResume as Resume)
      expect(tech.meta.id).not.toBe(soe.meta.id)
      expect(tech.meta.id).toMatch(/^res-/)
      expect(tech.meta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      const ids = svc.list().map((resume) => resume.meta.id)
      expect(ids.sort()).toEqual([tech.meta.id, soe.meta.id].sort())
    })

    it('输入的 meta.id / meta.updatedAt 被服务端覆盖（id 与时间戳由服务管理）', () => {
      const svc = makeService()
      const created = svc.create({
        meta: { id: 'res-client', updatedAt: '2020-01-01T00:00:00Z' },
        basics: { name: '张伟' },
        education: []
      })
      expect(created.meta.id).not.toBe('res-client')
      expect(created.meta.updatedAt).not.toBe('2020-01-01T00:00:00Z')
    })
  })

  describe('update', () => {
    it('修改字段、保持 id、刷新 updatedAt', () => {
      const svc = makeService()
      const created = svc.create(baseResume())
      const updated = svc.update(created.meta.id, {
        ...created,
        basics: { ...created.basics, name: '李四' },
        skills: [{ category: '工程能力', text: 'Java 服务端开发' }]
      })
      expect(updated.meta.id).toBe(created.meta.id)
      expect(updated.basics.name).toBe('李四')
      expect(updated.skills?.[0]?.text).toEqual('Java 服务端开发')
      expect(Date.parse(updated.meta.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.meta.updatedAt))
      expect(svc.get(created.meta.id)).toEqual(updated)
    })

    it('id 不存在 → ResumeNotFoundError', () => {
      const svc = makeService()
      expect(() => svc.update('res-missing', baseResume())).toThrow(ResumeNotFoundError)
    })

    it('非法 JSON → ResumeValidationError 且原数据不变', () => {
      const svc = makeService()
      const created = svc.create(baseResume())
      expect(() => svc.update(created.meta.id, invalidResume({ ...created, education: 'bad' }))).toThrow(
        ResumeValidationError
      )
      expect(svc.get(created.meta.id)).toEqual(created)
    })
  })

  describe('delete（删除语义）', () => {
    it('删除基准简历后，已存派生稿仍可读（独立副本，不受基准删除影响）', () => {
      const svc = makeService()
      const base = svc.create(baseResume()) // 基准简历：baseResumeId = null
      const derived = svc.create({
        meta: { title: '华为-软件开发-优化稿', baseResumeId: base.meta.id, targetJobId: 'job-1' },
        basics: { name: '张伟' },
        education: []
      })

      svc.delete(base.meta.id)

      // 基准不可读、不在列表
      expect(svc.get(base.meta.id)).toBeUndefined()
      // 派生稿仍可读，且 baseResumeId 标记保留
      const after = svc.get(derived.meta.id)
      expect(after).toEqual(derived)
      expect(after?.meta.baseResumeId).toBe(base.meta.id)
      expect(svc.list().map((resume) => resume.meta.id)).toEqual([derived.meta.id])
    })

    it('删除派生稿本身也可行', () => {
      const svc = makeService()
      const base = svc.create(baseResume())
      const derived = svc.create({
        meta: { baseResumeId: base.meta.id, targetJobId: 'job-1' },
        basics: { name: '张伟' },
        education: []
      })
      svc.delete(derived.meta.id)
      expect(svc.get(derived.meta.id)).toBeUndefined()
      expect(svc.get(base.meta.id)).toBeDefined() // 派生稿删除不影响基准
    })

    it('id 不存在 → ResumeNotFoundError', () => {
      const svc = makeService()
      expect(() => svc.delete('res-missing')).toThrow(ResumeNotFoundError)
    })
  })

  it('文件库持久化：重开连接后简历仍在（含技能/荣誉等全字段）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobhunt-resume-'))
    const file = join(dir, 's.db')
    try {
      const first = openDatabase(file)
      const created = new ResumeService(first).create({
        ...baseResume(),
        skills: [{ category: '工程能力', text: 'Java 服务端开发' }],
        honors: ['蓝桥杯省一等奖'],
        selfAssessment: '基础扎实'
      })
      first.close()

      const second = openDatabase(file)
      try {
        const reopened = new ResumeService(second)
        expect(reopened.get(created.meta.id)).toEqual(created)
        expect(reopened.list()).toHaveLength(1)
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('照片（ADR-0009）', () => {
    it('删除简历时照片文件随删；无照片不报错', () => {
      const dir = mkdtempSync(join(tmpdir(), 'resume-photo-'))
      try {
        const photos = new PhotoStore(dir)
        writeFileSync(join(dir, 'p.png'), 'png-bytes')
        const svc = new ResumeService(openDatabase(':memory:'), photos)
        const created = svc.create({
          ...baseResume(),
          basics: { ...baseResume().basics, photo: 'p.png' }
        })
        svc.delete(created.meta.id)
        expect(existsSync(join(dir, 'p.png'))).toBe(false)
        expect(svc.list()).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('renderFromResume / renderHtml：照片以 data URI 内嵌；缺照片/文件缺失不渲染照片位', () => {
      const dir = mkdtempSync(join(tmpdir(), 'resume-photo-'))
      try {
        const photos = new PhotoStore(dir)
        writeFileSync(join(dir, 'p.png'), 'png-bytes')
        const svc = new ResumeService(openDatabase(':memory:'), photos)
        const created = svc.create({
          ...baseResume(),
          basics: { ...baseResume().basics, photo: 'p.png' }
        })
        const html = svc.renderHtml(created.meta.id)
        expect(html).toContain('class="photo"')
        expect(html).toContain('data:image/png;base64,')

        expect(svc.renderFromResume(baseResume())).not.toContain('class="photo"')
        const missing = svc.renderFromResume({
          ...baseResume(),
          basics: { ...baseResume().basics, photo: 'missing.png' }
        })
        expect(missing).not.toContain('class="photo"')
        expect(missing).toContain('<h1>张伟</h1>')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
