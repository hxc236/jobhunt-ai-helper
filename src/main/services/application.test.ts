import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { PositionError, PositionService } from './position'
import type { PositionInput } from '../../shared/types'

function makeService(): PositionService {
  return new PositionService(openDatabase(':memory:'))
}

const validInput: PositionInput = {
  company: '腾讯',
  company_type: '大厂',
  title: '前端开发工程师',
  channel: '官网',
  channel_url: 'https://careers.tencent.com',
  recruit_season: '2026秋招'
}

function seed(): { svc: PositionService; positionId: string } {
  const svc = makeService()
  const { id } = svc.create(validInput)
  return { svc, positionId: id }
}

/** 固定时钟：断言各状态时间戳写入与 applied_date 自动填充。 */
const T0 = '2026-08-01T00:00:00.000Z'
const T1 = '2026-08-02T00:00:00.000Z'
const T2 = '2026-08-03T00:00:00.000Z'
const T3 = '2026-08-04T00:00:00.000Z'

describe('PositionService 投递状态机（F-05/#21）', () => {
  describe('getApplication / 首次创建', () => {
    it('无投递记录 → null；setApplicationState 首次调用创建记录（channel 默认取职位卡渠道）', () => {
      const { svc, positionId } = seed()
      expect(svc.getApplication(positionId)).toBeNull()

      const app = svc.setApplicationState(positionId, { status: 'applied' }, () => T0)
      expect(app.position_id).toBe(positionId)
      expect(app.status).toBe('applied')
      expect(app.channel).toBe('官网') // 默认复制职位卡渠道
      expect(app.created_at).toBe(T0)
      expect(svc.getApplication(positionId)).toEqual(app)
    })

    it('首次创建可直接进入 withdrawn（planned→withdrawn 合法）', () => {
      const { svc, positionId } = seed()
      const app = svc.setApplicationState(positionId, { status: 'withdrawn' }, () => T0)
      expect(app.status).toBe('withdrawn')
      expect(app.withdrawn_at).toBe(T0)
    })

    it('首次创建不允许跳过中间态（planned→interviewing 非法）', () => {
      const { svc, positionId } = seed()
      expect(() => svc.setApplicationState(positionId, { status: 'interviewing' })).toThrowError(
        PositionError
      )
      expect(() => svc.setApplicationState(positionId, { status: 'interviewing' })).toThrowError(
        /非法流转/
      )
      expect(svc.getApplication(positionId)).toBeNull()
    })

    it('职位不存在 → not-found', () => {
      const svc = makeService()
      expect(() => svc.setApplicationState('no-such-position', { status: 'applied' })).toThrowError(
        /不存在/
      )
    })

    it('applied_date 必须为 YYYY-MM-DD，否则校验错误', () => {
      const { svc, positionId } = seed()
      expect(() =>
        svc.setApplicationState(positionId, { status: 'applied', appliedDate: '2026/08/01' })
      ).toThrowError(/投递日期/)
    })
  })

  describe('状态机全流转（合法路径）', () => {
    it('planned → applied → interviewing → offer 全链路，各状态时间戳落库', () => {
      const { svc, positionId } = seed()
      const planned = svc.setApplicationState(positionId, { status: 'planned' }, () => T0)
      expect(planned.planned_at).toBe(T0)

      const applied = svc.setApplicationState(positionId, { status: 'applied' }, () => T1)
      expect(applied.status).toBe('applied')
      expect(applied.planned_at).toBe(T0) // 历史时间戳保留
      expect(applied.applied_at).toBe(T1)
      expect(applied.applied_date).toBe('2026-08-02') // 进入 applied 自动填投递日期（now 的日期）

      const interviewing = svc.setApplicationState(positionId, { status: 'interviewing' }, () => T2)
      expect(interviewing.interviewing_at).toBe(T2)

      const offer = svc.setApplicationState(positionId, { status: 'offer' }, () => T3)
      expect(offer.status).toBe('offer')
      expect(offer.offer_at).toBe(T3)
      expect(offer.applied_at).toBe(T1)
    })

    it('各分支：applied→rejected、interviewing→withdrawn、offer→withdrawn、rejected→withdrawn', () => {
      const { svc, positionId } = seed()
      svc.setApplicationState(positionId, { status: 'applied' }, () => T0)
      const rejected = svc.setApplicationState(positionId, { status: 'rejected' }, () => T1)
      expect(rejected.rejected_at).toBe(T1)

      const withdrawn = svc.setApplicationState(positionId, { status: 'withdrawn' }, () => T2)
      expect(withdrawn.withdrawn_at).toBe(T2)
      expect(withdrawn.status).toBe('withdrawn')
    })

    it('同状态重复调用不视为流转：可编辑 channel/appliedDate，updated_at 刷新', () => {
      const { svc, positionId } = seed()
      svc.setApplicationState(positionId, { status: 'applied' }, () => T0)
      const edited = svc.setApplicationState(
        positionId,
        { status: 'applied', appliedDate: '2026-07-20', channel: '牛客' },
        () => T1
      )
      expect(edited.status).toBe('applied')
      expect(edited.applied_date).toBe('2026-07-20')
      expect(edited.channel).toBe('牛客')
      expect(edited.updated_at).toBe(T1)
    })

    it('channel 传 null/空串 → 清空；不传保持不变', () => {
      const { svc, positionId } = seed()
      svc.setApplicationState(positionId, { status: 'applied' }, () => T0)
      const cleared = svc.setApplicationState(positionId, { status: 'applied', channel: '' }, () => T1)
      expect(cleared.channel).toBeNull()
      const kept = svc.setApplicationState(positionId, { status: 'applied', appliedDate: '2026-08-01' }, () => T2)
      expect(kept.channel).toBeNull()
    })
  })

  describe('非法流转拒绝', () => {
    it.each([
      ['applied', 'planned'], // 回退
      ['interviewing', 'planned'],
      ['interviewing', 'applied'],
      ['offer', 'rejected'],
      ['offer', 'applied'],
      ['rejected', 'interviewing'],
      ['withdrawn', 'applied'], // withdrawn 为终态
      ['withdrawn', 'planned'],
      ['withdrawn', 'offer']
    ] as const)('%s → %s 抛 transition 错误且状态不变', (from, to) => {
      const { svc, positionId } = seed()
      // 经合法路径走到 from
      const path: Record<string, readonly string[]> = {
        applied: ['planned', 'applied'],
        interviewing: ['planned', 'applied', 'interviewing'],
        offer: ['planned', 'applied', 'interviewing', 'offer'],
        rejected: ['planned', 'applied', 'rejected'],
        withdrawn: ['planned', 'applied', 'withdrawn']
      }
      for (const s of path[from]) {
        svc.setApplicationState(positionId, { status: s as never }, () => T0)
      }

      expect(() => svc.setApplicationState(positionId, { status: to }, () => T1)).toThrowError(/非法流转/)
      expect(svc.getApplication(positionId)?.status).toBe(from)
      expect(svc.getApplication(positionId)?.updated_at).toBe(T0) // 失败不刷新
    })
  })

  describe('列表投递状态筛选联动（#21 验收）', () => {
    function seedThree(): { svc: PositionService; noRecordId: string; plannedId: string; appliedId: string } {
      const svc = makeService()
      const a = svc.create({ ...validInput, company: '腾讯' }) // 无投递记录
      const b = svc.create({ ...validInput, company: '华为', title: '软件工程师' })
      const c = svc.create({ ...validInput, company: '字节', title: '后端开发工程师' })
      svc.setApplicationState(b.id, { status: 'planned' }, () => T0)
      svc.setApplicationState(c.id, { status: 'applied' }, () => T0)
      return { svc, noRecordId: a.id, plannedId: b.id, appliedId: c.id }
    }

    it('行携带 application_status（无记录为 null）', () => {
      const { svc, noRecordId, plannedId, appliedId } = seedThree()
      const byId = Object.fromEntries(svc.list().map((p) => [p.id, p.application_status]))
      expect(byId[noRecordId]).toBeNull()
      expect(byId[plannedId]).toBe('planned')
      expect(byId[appliedId]).toBe('applied')
    })

    it('筛选 application_status=planned 命中 planned 记录与无记录职位（未投递）', () => {
      const { svc, noRecordId, plannedId } = seedThree()
      const ids = svc.list({ application_status: 'planned' }).map((p) => p.id).sort()
      expect(ids).toEqual([noRecordId, plannedId].sort())
    })

    it('筛选 application_status=applied 只命中有 applied 记录的职位', () => {
      const { svc, appliedId } = seedThree()
      expect(svc.list({ application_status: 'applied' }).map((p) => p.id)).toEqual([appliedId])
    })

    it('筛选 application_status=interviewing 无命中（无记录职位不算）', () => {
      const { svc } = seedThree()
      expect(svc.list({ application_status: 'interviewing' })).toEqual([])
    })

    it('与既有维度组合筛选（交集）', () => {
      const svc = makeService()
      const a = svc.create({ ...validInput, company: '腾讯' })
      const b = svc.create({ ...validInput, company: '华为', title: '软件工程师' })
      svc.setApplicationState(a.id, { status: 'applied' }, () => T0)
      svc.setApplicationState(b.id, { status: 'applied' }, () => T0)
      const rows = svc.list({ application_status: 'applied', company_type: '大厂' })
      expect(rows.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
    })
  })

  describe('与职位删除联动（#20 级联契约）', () => {
    it('删除职位后其投递记录一并删除（getApplication → null）', () => {
      const { svc, positionId } = seed()
      svc.setApplicationState(positionId, { status: 'applied' }, () => T0)
      expect(svc.getApplication(positionId)).not.toBeNull()

      svc.delete(positionId)
      expect(svc.getApplication(positionId)).toBeNull()
    })
  })
})
