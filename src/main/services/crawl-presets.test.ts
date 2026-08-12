import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { CrawlPresetService } from './crawl-presets'

describe('CrawlPresetService 常用采集（issue #57）', () => {
  it('保存/列表/删除：条件 JSON 往返', () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlPresetService(db)

    const created = svc.create('上海前端', { hire_type: '社招', keyword: '前端', city: '101020100', salary: '405' })
    expect(created.id).toBeGreaterThan(0)
    expect(created.name).toBe('上海前端')
    expect(created.conditions).toEqual({
      hire_type: '社招',
      keyword: '前端',
      city: '101020100',
      salary: '405'
    })

    expect(svc.list()).toHaveLength(1)
    svc.delete(created.id)
    expect(svc.list()).toHaveLength(0)
    svc.delete(created.id) // 重复删除静默
  })

  it('名称空白 / 条件为空 → 拒绝', () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlPresetService(db)
    expect(() => svc.create('  ', { keyword: 'x' })).toThrowError(/名称不能为空/)
    expect(() => svc.create(' 空条件 ', {})).toThrowError(/条件不能为空/)
  })

  it('名称首尾空白去除；列表倒序', () => {
    const db = openDatabase(':memory:')
    const svc = new CrawlPresetService(db)
    svc.create(' 第一个 ', { keyword: 'a' })
    svc.create('第二个', { keyword: 'b' })
    const list = svc.list()
    expect(list[0]?.name).toBe('第二个')
    expect(list[1]?.name).toBe('第一个')
  })
})
