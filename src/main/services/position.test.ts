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
    expect(listed[0]).toEqual(row)
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

describe('PositionService.list', () => {
  it('新库返回空列表；按创建时间倒序返回全部职位卡', () => {
    const svc = makeService()
    expect(svc.list()).toEqual([])

    const first = svc.create(validInput)
    const second = svc.create({ ...validInput, title: '后端开发工程师', recruit_season: '2025秋招' })
    expect(svc.list().map((p) => p.id)).toEqual([second.id, first.id])
  })
})
