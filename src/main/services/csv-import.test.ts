import { describe, expect, it } from 'vitest'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/database'
import { PositionService } from './position'
import { CsvImportService } from './csv-import'
import type { HireType, PositionInput } from '../../shared/types'

/**
 * CSV 导入服务层（issue #70 / spec #68）测试。
 * 对齐 position.test.ts（openDatabase(':memory:')）与 crawl.test.ts（preview/confirmImport 模式）：
 * 只测外部行为——预览标记与导入统计，不测实现细节。
 */

function makeServices(): { positions: PositionService; csv: CsvImportService } {
  const positions = new PositionService(openDatabase(':memory:'))
  return { positions, csv: new CsvImportService(positions) }
}

/** 合法校招输入（T1 解析层产出的典型行；company_type 缺省'其他'）。 */
const base: PositionInput = {
  company: '华为',
  company_type: '其他',
  title: '前端工程师',
  hire_type: '校招',
  recruit_season: '2027秋招'
}

describe('CsvImportService.preview（逐行复用 create 校验规则，不漂移）', () => {
  it('缺字段标记：公司/岗位必填、校招必填秋招季', () => {
    const { csv } = makeServices()
    const items = csv.preview([
      { company: '', company_type: '其他', title: '前端' }, // 缺公司
      { ...base, title: '' }, // 缺岗位
      { ...base, recruit_season: '' }, // 校招缺秋招季
      { ...base, hire_type: '社招' } // 社招无秋招季要求
    ])
    expect(items[0].missingFields).toEqual(['company', 'recruit_season']) // 缺公司；无 hire_type 默认校招 → 秋招季也缺
    expect(items[0].error).toContain('公司必填')
    expect(items[1].missingFields).toEqual(['title'])
    expect(items[1].error).toContain('岗位必填')
    expect(items[2].missingFields).toEqual(['recruit_season'])
    expect(items[2].error).toContain('秋招季必填')
    expect(items[3].missingFields).toEqual([])
    expect(items[3].error).toBeNull()
  })

  it('校验错误与 create 一致：枚举/日期/薪资区间', () => {
    const { csv } = makeServices()
    const items = csv.preview([
      { ...base, hire_type: '临时工' as HireType }, // 非法招聘类型
      { ...base, batch: '春季批' as PositionInput['batch'] }, // 非法批次
      { ...base, start_date: '2026-13-01' }, // 非法日期
      { ...base, salary_min: 50, salary_max: 30 }, // 下限高于上限
      { ...base, salary_min: 0 } // 非正整数
    ])
    expect(items[0].error).toContain('招聘类型只能是')
    expect(items[1].error).toContain('批次只能是')
    expect(items[2].error).toContain('YYYY-MM-DD')
    expect(items[3].error).toContain('下限不能高于上限')
    expect(items[4].error).toContain('薪资下限必须为正整数')
    expect(items[4].missingFields).toEqual([])
  })

  it('exists 标记：去重键 company|title|hire_type|recruit_season 命中已有职位', () => {
    const { positions, csv } = makeServices()
    positions.create({ ...base, company: '腾讯' }) // 键：腾讯|前端工程师|校招|2027秋招
    const items = csv.preview([
      { ...base, company: '腾讯' }, // 键命中
      base, // 键不同（华为）
      { ...base, company: '腾讯', hire_type: '社招' }, // 社招键（season 空串）不同
      { ...base, company: '腾讯', recruit_season: '2026秋招' } // 届数不同
    ])
    expect(items[0].exists).toBe(true)
    expect(items[1].exists).toBe(false)
    expect(items[2].exists).toBe(false)
    expect(items[3].exists).toBe(false)
  })
})

describe('CsvImportService.importSelected（insert / update / 跳过 三路径）', () => {
  it('新行 → 插入：source=manual、status=active、去重键正确', () => {
    const { positions, csv } = makeServices()
    const result = csv.importSelected([{ input: base, update: false }])
    expect(result).toEqual({ inserted: 1, updated: 0, failed: [] })
    const rows = positions.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      company: '华为',
      title: '前端工程师',
      source: 'manual',
      status: 'active',
      hire_type: '校招'
    })
    expect(rows[0].dedupe_key).toBe('华为|前端工程师|校招|2027秋招')
  })

  it('社招行：无秋招季通过校验（与手动录入一致），去重键 season 空串', () => {
    const { positions, csv } = makeServices()
    const result = csv.importSelected([
      { input: { company: '某公司', company_type: '其他', title: '后端工程师', hire_type: '社招' }, update: false }
    ])
    expect(result).toEqual({ inserted: 1, updated: 0, failed: [] })
    expect(positions.list()[0].dedupe_key).toBe('某公司|后端工程师|社招|')
  })

  it('exists 且选更新 → 更新已有职位（提供的字段覆盖，未提供的保持原值），不产生新行', () => {
    const { positions, csv } = makeServices()
    const created = positions.create({ ...base, jd: '原JD', city: '上海', notes: '原备注' })
    const result = csv.importSelected([
      { input: { ...base, jd: '新JD', city: '深圳' }, update: true } // 未提供 notes
    ])
    expect(result).toEqual({ inserted: 0, updated: 1, failed: [] })
    const row = positions.get(created.id)
    expect(row.jd).toBe('新JD')
    expect(row.city).toBe('深圳')
    expect(row.notes).toBe('原备注') // patch 语义：未提供字段保持原值
    expect(positions.list()).toHaveLength(1)
  })

  it('exists 且未选更新 → 跳过：不更新不新建（防误覆盖手动数据）', () => {
    const { positions, csv } = makeServices()
    const created = positions.create(base)
    const result = csv.importSelected([{ input: { ...base, jd: '新JD' }, update: false }])
    expect(result).toEqual({ inserted: 0, updated: 0, failed: [] })
    expect(positions.get(created.id).jd).toBe('')
    expect(positions.list()).toHaveLength(1)
  })

  it('校验失败行跳过不中断，failed 带原因且顺序与请求一致', () => {
    const { csv } = makeServices()
    const result = csv.importSelected([
      { input: { ...base, salary_min: 50, salary_max: 30 }, update: false }, // 校验失败
      { input: base, update: false }, // 插入
      { input: { ...base, title: '' }, update: false } // 校验失败
    ])
    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]).toContain('下限不能高于上限')
    expect(result.failed[1]).toContain('岗位必填')
  })

  it('批量统计：insert/update/failed 混合正确', () => {
    const { positions, csv } = makeServices()
    positions.create(base) // 已有：华为|前端工程师|校招|2027秋招
    const result = csv.importSelected([
      { input: { ...base, jd: '更新JD' }, update: true }, // exists → 更新
      { input: { ...base, company: '字节' }, update: false }, // 新行 → 插入
      { input: { ...base, salary_min: 0 }, update: false }, // 校验失败
      { input: { ...base, company: '腾讯' }, update: true } // 新行（update 标志对非 exists 行无影响）→ 插入
    ])
    expect(result).toEqual({ inserted: 2, updated: 1, failed: ['第 3 条数据行：薪资下限必须为正整数（K/月）'] })
    expect(positions.list()).toHaveLength(3)
  })

  it('预览与导入的 exists 判定一致（导入前再查一次，防预览过期）', () => {
    const { positions, csv } = makeServices()
    const previewItems = csv.preview([{ ...base, company: '腾讯' }])
    expect(previewItems[0].exists).toBe(false)
    positions.create({ ...base, company: '腾讯' }) // 预览后、导入前出现重复
    const result = csv.importSelected([{ input: { ...base, company: '腾讯', jd: '新JD' }, update: false }])
    expect(result).toEqual({ inserted: 0, updated: 0, failed: [] }) // 已存在且未选更新 → 跳过
    expect(positions.list()).toHaveLength(1)
  })
})

describe('CsvImportService.previewFile（#68/T3：文件 → 编码检测/解码 → 解析 → 预览）', () => {
  it('GBK 编码文件（Excel 中文版导出形态）→ 正确解码并预览', async () => {
    const { csv } = makeServices()
    // 「华为,前端工程师,2027秋招」GBK 字节（TextDecoder('gbk') 回读验证）
    const gbkDataRow = Uint8Array.from([
      0xbb, 0xaa, 0xce, 0xaa, 0x2c, 0xc7, 0xb0, 0xb6, 0xcb, 0xb9, 0xa4, 0xb3, 0xcc, 0xca, 0xa6, 0x2c, 0x32, 0x30, 0x32, 0x37, 0xc7, 0xef, 0xd5, 0xd0, 0x0d, 0x0a
    ])
    const filePath = join(tmpdir(), `jobhunt-csv-gbk-${Date.now()}.csv`)
    try {
      // 表头为 ASCII（GBK 字节 = ASCII 字节）
      await writeFile(filePath, Buffer.concat([Buffer.from('company,title,recruit_season\r\n'), gbkDataRow]))
      const result = await csv.previewFile(filePath)
      expect(result.encoding).toBe('gbk')
      expect(result.errors).toEqual([])
      expect(result.items).toHaveLength(1)
      expect(result.items[0].input).toEqual({
        company: '华为',
        company_type: '其他',
        title: '前端工程师',
        recruit_season: '2027秋招'
      })
      expect(result.items[0].missingFields).toEqual([])
      expect(result.items[0].error).toBeNull()
      expect(result.items[0].exists).toBe(false)
    } finally {
      await unlink(filePath).catch(() => undefined)
    }
  })

  it('UTF-8 含 BOM 文件 → 编码识别 utf8，BOM 不进入首字段', async () => {
    const { csv } = makeServices()
    const filePath = join(tmpdir(), `jobhunt-csv-utf8-${Date.now()}.csv`)
    try {
      await writeFile(filePath, '\uFEFFcompany,title\n华为,前端\n', 'utf8')
      const result = await csv.previewFile(filePath)
      expect(result.encoding).toBe('utf8')
      expect(result.items[0].input.company).toBe('华为')
      expect(result.items[0].input.title).toBe('前端')
    } finally {
      await unlink(filePath).catch(() => undefined)
    }
  })

  it('文件不存在 → 错误上抛（渲染层可见提示）', async () => {
    const { csv } = makeServices()
    await expect(csv.previewFile(join(tmpdir(), 'no-such-file-xyz.csv'))).rejects.toThrow()
  })
})
