import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { csvSelections } from './csv-import-form'
import type { CsvImportPreviewResult } from '@shared/types'

/**
 * csvSelections（issue #72 回归）：Vue 响应式代理不可被 structured clone 序列化，
 * 确认请求必须剥离 Proxy 后再发送。用 reactive() 模拟 ref 深响应式包装后的真实输入。
 */
const preview: CsvImportPreviewResult = {
  encoding: 'utf8',
  errors: [],
  items: [
    {
      input: { company: '华为', company_type: '其他', title: '前端工程师', hire_type: '校招', recruit_season: '2027秋招' },
      missingFields: [],
      exists: false,
      error: null
    },
    {
      input: { company: '腾讯', company_type: '其他', title: '后端工程师', hire_type: '校招', recruit_season: '2027秋招' },
      missingFields: [],
      exists: true,
      error: null
    },
    {
      input: { company: '字节', company_type: '其他', title: '算法工程师' },
      missingFields: ['recruit_season'],
      exists: false,
      error: '秋招季必填（去重键组成部分）'
    }
  ]
}

describe('csvSelections（#72 回归：剥离 Vue 响应式代理，产出可 IPC 序列化的纯对象）', () => {
  it('输入为 reactive 代理时，结果可被 structuredClone 序列化且值正确', () => {
    // ref 深响应式 ≈ reactive 包装；reactive(JSON.parse(JSON.stringify(...))) 确保是代理而非原对象
    const proxied = reactive(JSON.parse(JSON.stringify(preview)) as CsvImportPreviewResult)
    expect(proxied).not.toBe(preview)

    const items = csvSelections(proxied, new Set([1, 0]), new Set([1])) // 乱序勾选 → 按行号排序

    // 若泄漏 Proxy，structuredClone 会抛 DataCloneError（与 Electron IPC 同源错误）
    expect(() => structuredClone(items)).not.toThrow()
    expect(items).toEqual([
      { input: preview.items[0].input, update: false },
      { input: preview.items[1].input, update: true } // exists 行且选中「更新」
    ])
  })

  it('exists 行未勾选更新 → update=false（跳过路径）', () => {
    const proxied = reactive(JSON.parse(JSON.stringify(preview)) as CsvImportPreviewResult)
    const items = csvSelections(proxied, new Set([1]), new Set())
    expect(items).toEqual([{ input: preview.items[1].input, update: false }])
  })

  it('未勾选行不进入请求；校验失败行可被排除在外', () => {
    const proxied = reactive(JSON.parse(JSON.stringify(preview)) as CsvImportPreviewResult)
    const items = csvSelections(proxied, new Set([0, 2]), new Set())
    expect(items.map((s) => s.input.title)).toEqual(['前端工程师', '算法工程师'])
  })
})
