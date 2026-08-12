import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { PositionError, PositionService, daysUntil } from './position'
import type { PositionInput } from '../../shared/types'

function makeService(): PositionService {
  return new PositionService(openDatabase(':memory:'))
}

const validInput: PositionInput = {
  company: '腾讯',
  company_type: '大厂',
  title: '前端开发工程师',
  jd: '负责 xxx',
  city: '深圳',
  channel: '官网',
  channel_url: 'https://careers.tencent.com',
  recruit_season: '2026秋招',
  batch: '正式批',
  start_date: '2026-07-01',
  end_date: '2026-10-15',
  notes: '备注'
}

describe('PositionService.create', () => {
  it('合法输入创建职位卡：全字段落库，source=manual、status=active、dedupe_key 生成正确', () => {
    const svc = makeService()
    const row = svc.create(validInput)

    expect(row.id).toBeTruthy()
    expect(row.source).toBe('manual')
    expect(row.status).toBe('active')
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBe(row.created_at)
    // dedupe_key = company|title|recruit_season（#5 语义键；字段首尾空白已去除）
    expect(row.dedupe_key).toBe('腾讯|前端开发工程师|2026秋招')

    const listed = svc.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject(row)
    // F-02：列表行附带倒计时（end_date 存在 → 数字）
    expect(listed[0].days_left).toBeTypeOf('number')
  })

  it('可选字段缺省：jd/notes 空串，其余为 null', () => {
    const svc = makeService()
    const row = svc.create({
      company: ' 华为 ',
      company_type: '大厂',
      title: ' 软件工程师 ',
      recruit_season: '2026秋招'
    })

    expect(row.company).toBe('华为') // 首尾空白去除
    expect(row.title).toBe('软件工程师')
    expect(row.jd).toBe('')
    expect(row.notes).toBe('')
    expect(row.city).toBeNull()
    expect(row.channel).toBeNull()
    expect(row.channel_url).toBeNull()
    expect(row.batch).toBeNull()
    expect(row.start_date).toBeNull()
    expect(row.end_date).toBeNull()
  })

  it('缺必填（公司/岗位）抛校验错误，提示字段名', () => {
    const svc = makeService()
    expect(() => svc.create({ ...validInput, company: '  ' })).toThrowError(/公司必填/)
    expect(() => svc.create({ ...validInput, title: '' })).toThrowError(/岗位必填/)
    expect(svc.list()).toHaveLength(0)
  })

  it('秋招季必填（dedupe_key 组成部分）', () => {
    const svc = makeService()
    expect(() => svc.create({ ...validInput, recruit_season: '  ' })).toThrowError(/秋招季必填/)
  })

  it('企业性质只能是枚举值，其余抛校验错误', () => {
    const svc = makeService()
    expect(() =>
      svc.create({ ...validInput, company_type: '国企' as never })
    ).not.toThrow() // 枚举内的值（含非 input 字面量类型）可用
    expect(() =>
      svc.create({ ...validInput, company_type: '上市公司' as never })
    ).toThrowError(/企业性质只能是/)
  })

  it('批次只能是枚举值，其余抛校验错误', () => {
    const svc = makeService()
    expect(() => svc.create({ ...validInput, batch: '秋招' as never })).toThrowError(/批次只能是/)
  })

  it('网申日期必须是 YYYY-MM-DD 格式（含 2026-02-31 这类非法日期）', () => {
    const svc = makeService()
    expect(() => svc.create({ ...validInput, start_date: '2026/07/01' })).toThrowError(/日期/)
    expect(() => svc.create({ ...validInput, end_date: '2026-02-31' })).toThrowError(/日期/)
    expect(() => svc.create({ ...validInput, start_date: '2026-07-01' })).not.toThrow()
  })

  it('重复职位（公司+岗位+秋招季相同）抛 duplicate 错误，不落库', () => {
    const svc = makeService()
    svc.create(validInput)
    expect(() => svc.create(validInput)).toThrowError(PositionError)
    expect(() => svc.create({ ...validInput, jd: '刷新后的 JD' })).toThrowError(/已存在相同职位/)
    expect(svc.list()).toHaveLength(1)
  })

  it('公司+岗位相同但秋招季不同 → 不判重，可正常创建', () => {
    const svc = makeService()
    svc.create(validInput)
    expect(() => svc.create({ ...validInput, recruit_season: '2025秋招' })).not.toThrow()
    expect(svc.list()).toHaveLength(2)
  })
})

describe('PositionService.get（F-03/#20）', () => {
  it('按 id 返回完整职位卡（含 JD 全文）', () => {
    const svc = makeService()
    const created = svc.create(validInput)

    const got = svc.get(created.id)
    // 行对象含 jd_analysis 缓存列（#28 起，服务层透传 null）
    expect(got).toEqual({ ...created, jd_analysis: null })
  })

  it('id 不存在 → PositionError not-found（渲染层引导回列表）', () => {
    const svc = makeService()
    expect(() => svc.get('no-such-id')).toThrowError(PositionError)
    expect(() => svc.get('no-such-id')).toThrowError(/不存在/)
  })
})

describe('PositionService.update（F-03/#20）', () => {
  function seed(): { svc: PositionService; id: string } {
    const svc = makeService()
    const { id } = svc.create(validInput)
    return { svc, id }
  }

  it('修改任意字段生效（JD 更新/截止修正/备注），updated_at 刷新、id 不变', () => {
    const { svc, id } = seed()
    const before = svc.get(id)

    const updated = svc.update(
      id,
      {
        jd: '刷新后的 JD 全文',
        end_date: '2026-11-30',
        notes: '已内推'
      },
      () => '2026-08-13T00:00:00.000Z' // 注入时钟：断言 updated_at 刷新（服务默认用真实时间）
    )

    expect(updated.id).toBe(id)
    expect(updated.jd).toBe('刷新后的 JD 全文')
    expect(updated.end_date).toBe('2026-11-30')
    expect(updated.notes).toBe('已内推')
    expect(updated.updated_at).toBe('2026-08-13T00:00:00.000Z')
    expect(updated.updated_at).not.toBe(before.updated_at)
    // 未传字段保持不变
    expect(updated.company).toBe('腾讯')
    expect(updated.company_type).toBe('大厂')
    expect(updated.channel_url).toBe('https://careers.tencent.com')
    // 服务返回与库中一致
    expect(svc.get(id)).toEqual(updated)
  })

  it('空串/null 清空可选字段为 null（city/channel/channel_url/start_date/end_date/batch）', () => {
    const { svc, id } = seed()
    const updated = svc.update(id, {
      city: '',
      channel: '',
      channel_url: null,
      start_date: '',
      end_date: null,
      batch: ''
    })
    expect(updated.city).toBeNull()
    expect(updated.channel).toBeNull()
    expect(updated.channel_url).toBeNull()
    expect(updated.start_date).toBeNull()
    expect(updated.end_date).toBeNull()
    expect(updated.batch).toBeNull()
  })

  it('公司/岗位/秋招季改为空白 → 校验错误', () => {
    const { svc, id } = seed()
    expect(() => svc.update(id, { company: '  ' })).toThrowError(/公司必填/)
    expect(() => svc.update(id, { title: '' })).toThrowError(/岗位必填/)
    expect(() => svc.update(id, { recruit_season: '' })).toThrowError(/秋招季必填/)
  })

  it('非法枚举/非法日期/非法状态 → 校验错误', () => {
    const { svc, id } = seed()
    expect(() => svc.update(id, { company_type: '上市公司' as never })).toThrowError(/企业性质只能是/)
    expect(() => svc.update(id, { batch: '秋招' as never })).toThrowError(/批次只能是/)
    expect(() => svc.update(id, { end_date: '2026-02-31' })).toThrowError(/日期/)
    expect(() => svc.update(id, { status: 'archived' as never })).toThrowError(/状态只能是/)
  })

  it('改公司/岗位/秋招季 → dedupe_key 重算；与另一条重复 → duplicate 错误', () => {
    const svc = makeService()
    const a = svc.create(validInput) // 腾讯|前端开发工程师|2026秋招
    // 两个碰撞目标：同季不同岗位 / 同岗位不同季
    svc.create({ ...validInput, title: '后端开发工程师' }) // 腾讯|后端开发工程师|2026秋招
    svc.create({ ...validInput, recruit_season: '2025秋招' }) // 腾讯|前端开发工程师|2025秋招

    expect(() => svc.update(a.id, { title: '后端开发工程师' })).toThrowError(/已存在相同职位/)
    expect(() => svc.update(a.id, { recruit_season: '2025秋招' })).toThrowError(/已存在相同职位/)
    expect(svc.list()).toHaveLength(3) // 失败不落库
  })

  it('改公司后 dedupe_key 更新为新的 company|title|recruit_season；仅改非键字段不触发 duplicate', () => {
    const svc = makeService()
    const a = svc.create(validInput)
    svc.create({ ...validInput, title: '后端开发工程师' })

    const updated = svc.update(a.id, { company: '腾讯云' })
    expect(updated.dedupe_key).toBe('腾讯云|前端开发工程师|2026秋招')
    expect(() => svc.update(a.id, { jd: 'x' })).not.toThrow()
  })

  it('状态可编辑（active ↔ closed，列表状态筛选用）', () => {
    const { svc, id } = seed()
    expect(svc.update(id, { status: 'closed' }).status).toBe('closed')
    expect(svc.list({ status: 'closed' }).map((p) => p.id)).toEqual([id])
  })

  it('id 不存在 → not-found', () => {
    const svc = makeService()
    expect(() => svc.update('no-such-id', { jd: 'x' })).toThrowError(/不存在/)
  })
})

describe('PositionService.delete（F-03/#20）', () => {
  it('删除后列表与 get 均不可见；其他职位不受影响；重复删除 → not-found', () => {
    const svc = makeService()
    const { id } = svc.create(validInput)
    const other = svc.create({ ...validInput, title: '后端开发工程师' })

    expect(svc.list()).toHaveLength(2)
    svc.delete(id)

    expect(svc.list().map((p) => p.id)).toEqual([other.id])
    expect(() => svc.get(id)).toThrowError(/不存在/)
    expect(() => svc.delete(id)).toThrowError(/不存在/)
  })

  it('投递记录级联删除：applications 表存在时该职位的记录一并删除，其他职位记录保留', () => {
    const db = openDatabase(':memory:')
    const svc = new PositionService(db)
    const { id } = svc.create(validInput)
    const other = svc.create({ ...validInput, title: '后端开发工程师' })
    // 经服务创建投递记录（applications 表由 #21 迁移建表）
    svc.setApplicationState(id, { status: 'applied' }, () => '2026-08-01T00:00:00.000Z')
    svc.setApplicationState(id, { status: 'interviewing' }, () => '2026-08-02T00:00:00.000Z')
    svc.setApplicationState(other.id, { status: 'applied' }, () => '2026-08-01T00:00:00.000Z')

    svc.delete(id)

    expect(svc.getApplication(id)).toBeNull()
    expect(svc.getApplication(other.id)).not.toBeNull() // 其他职位的投递记录保留
  })

  it('applications 表尚未建（#21 之前）时删除照常可用', () => {
    const svc = makeService()
    const { id } = svc.create(validInput)
    expect(() => svc.delete(id)).not.toThrow()
    expect(svc.list()).toHaveLength(0)
  })
})

describe('PositionService.list', () => {
  it('新库返回空列表；按创建时间倒序返回全部职位卡', () => {
    const svc = makeService()
    expect(svc.list()).toEqual([])

    const first = svc.create(validInput)
    const second = svc.create({ ...validInput, title: '后端开发工程师', recruit_season: '2025秋招' })
    expect(svc.list().map((p) => p.id)).toEqual([second.id, first.id])
  })
})

describe('PositionService.list 四维筛选与倒计时（F-02/#18）', () => {
  /** 4 条职位卡：企业性质/批次/状态/秋招季各维度分布不同，供组合筛选与倒计时断言。 */
  function seed(): { svc: PositionService } {
    const db = openDatabase(':memory:')
    const svc = new PositionService(db)
    svc.create({
      company: '腾讯', company_type: '大厂', title: '前端开发工程师',
      recruit_season: '2026秋招', batch: '正式批', end_date: '2026-10-15'
    })
    svc.create({
      company: '国家电网', company_type: '央企', title: '电气工程师',
      recruit_season: '2026秋招', batch: '提前批' // 无 end_date → 待核实
    })
    svc.create({
      company: '华为', company_type: '大厂', title: '软件工程师',
      recruit_season: '2025秋招', batch: '补录'
    })
    svc.create({
      company: '字节跳动', company_type: '私企', title: '前端开发工程师',
      recruit_season: '2025秋招', batch: '正式批', end_date: '2025-10-30'
    })
    // 状态维度：F-04 前无 update 服务，直接改库造一条 closed
    db.prepare("UPDATE positions SET status = 'closed' WHERE company = '华为'").run()
    return { svc }
  }

  it('无筛选返回全部（按创建时间倒序）', () => {
    const { svc } = seed()
    expect(svc.list().map((p) => p.company)).toEqual(['字节跳动', '华为', '国家电网', '腾讯'])
  })

  it('按企业性质筛选', () => {
    const { svc } = seed()
    expect(svc.list({ company_type: '大厂' }).map((p) => p.company)).toEqual(['华为', '腾讯'])
    expect(svc.list({ company_type: '事业单位' })).toEqual([])
  })

  it('按批次筛选', () => {
    const { svc } = seed()
    expect(svc.list({ batch: '正式批' }).map((p) => p.company)).toEqual(['字节跳动', '腾讯'])
    expect(svc.list({ batch: '补录' }).map((p) => p.company)).toEqual(['华为'])
  })

  it('按状态筛选（active=进行中 / closed=已关闭）', () => {
    const { svc } = seed()
    expect(svc.list({ status: 'closed' }).map((p) => p.company)).toEqual(['华为'])
    expect(svc.list({ status: 'active' }).map((p) => p.company)).toEqual(['字节跳动', '国家电网', '腾讯'])
  })

  it('按秋招季筛选', () => {
    const { svc } = seed()
    expect(svc.list({ recruit_season: '2026秋招' }).map((p) => p.company)).toEqual(['国家电网', '腾讯'])
    expect(svc.list({ recruit_season: '2024秋招' })).toEqual([])
  })

  it('四维组合筛选同时生效（交集）', () => {
    const { svc } = seed()
    const result = svc.list({
      company_type: '大厂',
      batch: '正式批',
      status: 'active',
      recruit_season: '2026秋招'
    })
    expect(result.map((p) => p.company)).toEqual(['腾讯'])
  })

  it('days_left：有 end_date 按日历天计算，无 end_date 为 null（UI 显「待核实」）', () => {
    const { svc } = seed()
    const today = new Date(2026, 9, 1) // 2026-10-01
    const rows = svc.list({}, today)
    const byCompany = Object.fromEntries(rows.map((r) => [r.company, r.days_left]))
    expect(byCompany['腾讯']).toBe(14) // ≤14 天 → 红色徽标阈值
    expect(byCompany['字节跳动']).toBeLessThan(0) // 已过截止
    expect(byCompany['国家电网']).toBeNull()
    expect(byCompany['华为']).toBeNull()
  })
})

describe('daysUntil 倒计时计算（F-02/#18）', () => {
  it('截止当天=0，明天=1，昨天=-1（已截止）', () => {
    const today = new Date(2026, 9, 15)
    expect(daysUntil('2026-10-15', today)).toBe(0)
    expect(daysUntil('2026-10-16', today)).toBe(1)
    expect(daysUntil('2026-10-14', today)).toBe(-1)
  })

  it('14 天阈值边界：14 属临近（红）、15 正常（UI 判定依据）', () => {
    const today = new Date(2026, 9, 1)
    expect(daysUntil('2026-10-15', today)).toBe(14)
    expect(daysUntil('2026-10-16', today)).toBe(15)
  })

  it('跨月计算正确（9-30 距 10-15 = 15 天）', () => {
    const today = new Date(2026, 8, 30)
    expect(daysUntil('2026-10-15', today)).toBe(15)
  })
})
