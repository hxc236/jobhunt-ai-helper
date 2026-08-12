import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { SettingsService } from './settings'

function makeService(): SettingsService {
  return new SettingsService(openDatabase(':memory:'))
}

describe('SettingsService', () => {
  it('get/set 往返：支持 JSON 可序列化的各类值', () => {
    const svc = makeService()
    const cases: Array<[string, unknown]> = [
      ['str', 'hello'],
      ['num', 42],
      ['bool', true],
      ['null', null],
      ['obj', { theme: 'dark', nested: [1, 2] }],
      ['arr', ['a', 'b']]
    ]
    for (const [key, value] of cases) {
      svc.set(key, value)
      expect(svc.get(key)).toEqual(value)
    }
  })

  it('未设置的 key 返回 undefined', () => {
    expect(makeService().get('missing')).toBeUndefined()
  })

  it('set 同 key 为更新而非新增（upsert）', () => {
    const svc = makeService()
    svc.set('k', 1)
    svc.set('k', { v: 2 })
    expect(svc.get('k')).toEqual({ v: 2 })
    expect(svc.getAll()).toEqual({ k: { v: 2 } })
  })

  it('set undefined 抛 TypeError（JSON 不可序列化）', () => {
    const svc = makeService()
    expect(() => svc.set('bad', undefined)).toThrow(TypeError)
    expect(svc.get('bad')).toBeUndefined()
  })

  it('getAll 返回全部键值', () => {
    const svc = makeService()
    svc.set('a', 1)
    svc.set('b', 'x')
    expect(svc.getAll()).toEqual({ a: 1, b: 'x' })
  })

  it('表中损坏的 JSON 值按未设置处理（get 返回 undefined，不崩溃）', () => {
    const db = openDatabase(':memory:')
    const svc = new SettingsService(db)
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('corrupt', '{not json')
    expect(svc.get('corrupt')).toBeUndefined()
    expect(svc.getAll()).toEqual({})
  })

  it('同一文件库的两次打开共享数据（持久化）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobhunt-settings-'))
    const file = join(dir, 's.db')
    try {
      const first = openDatabase(file)
      try {
        new SettingsService(first).set('k', 'v1')
      } finally {
        first.close()
      }
      const second = openDatabase(file)
      try {
        expect(new SettingsService(second).get('k')).toBe('v1')
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
