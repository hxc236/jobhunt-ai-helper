import { describe, expect, it } from 'vitest'
import { buildHeaderMap, CSV_TEMPLATE_TEXT, detectCsvEncoding, parseCsv, parseCsvRowsToInputs } from './csv'

/**
 * CSV 解析纯函数层（issue #69 / spec #68）fixture 测试。
 * 对齐 boss.test.ts / screenshot-extract.test.ts 的 fixture 模式：
 * 只测外部行为（解析结果/错误列表），不测内部实现细节。
 */

describe('parseCsv 标准 CSV 解析（引号/转义/换行/逗号）', () => {
  it('逗号分隔基础行', () => {
    expect(parseCsv('company,title,city\n华为,前端,深圳')).toEqual([
      ['company', 'title', 'city'],
      ['华为', '前端', '深圳']
    ])
  })

  it('引号包裹字段（含逗号/空字段）', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
    expect(parseCsv('a,""')).toEqual([['a', '']])
  })

  it('"" 转义引号', () => {
    expect(parseCsv('"他说""你好"""')).toEqual([['他说"你好"']])
  })

  it('字段内换行（引号包裹的 JD 多行文本）', () => {
    expect(parseCsv('a,"line1\nline2",b')).toEqual([['a', 'line1\nline2', 'b']])
  })

  it('CRLF 行结束（Excel 导出）', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('空行跳过、末尾换行不产生多余行', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']])
    expect(parseCsv('a,b')).toEqual([['a', 'b']])
  })

  it('空文本 → 空数组', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('BOM 前缀剥离', () => {
    expect(parseCsv('\uFEFFcompany,title')).toEqual([['company', 'title']])
  })

  it('未闭合引号宽容处理（不抛错，余下内容作为字段）', () => {
    expect(parseCsv('"abc')).toEqual([['abc']])
  })
})

describe('detectCsvEncoding 编码检测（UTF-8 BOM / GBK 兜底）', () => {
  it('UTF-8 BOM（EF BB BF）→ utf8', () => {
    expect(detectCsvEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf8')
  })

  it('GBK 中文（公司=B9 AB CB BE）→ gbk', () => {
    expect(detectCsvEncoding(new Uint8Array([0xb9, 0xab, 0xcb, 0xbe]))).toBe('gbk')
  })

  it('纯 ASCII → gbk（GBK 兼容 ASCII，解码成功即判定；两种编码结果字节一致无歧义）', () => {
    expect(detectCsvEncoding(new TextEncoder().encode('a,b'))).toBe('gbk')
  })

  it('非法 GBK 序列（0xFF）→ 解码失败回退 utf8', () => {
    expect(detectCsvEncoding(new Uint8Array([0xff]))).toBe('utf8')
    expect(detectCsvEncoding(new Uint8Array([0xff, 0xfe]))).toBe('utf8')
  })
})

describe('buildHeaderMap 表头别名映射（英文/中文/大小写下划线归一）', () => {
  const TEMPLATE_HEADER = [
    'company', 'title', 'hire_type', 'recruit_season', 'city',
    'salary_min', 'salary_max', 'salary_text', 'channel', 'channel_url',
    'start_date', 'end_date', 'batch', 'jd', 'notes'
  ] as const

  it('模板英文列名全命中', () => {
    const map = buildHeaderMap([...TEMPLATE_HEADER])
    expect(TEMPLATE_HEADER.map((_, i) => map[i])).toEqual([...TEMPLATE_HEADER])
  })

  it('中文别名全命中（公司/岗位/招聘类型/秋招季/城市/薪资/渠道/日期/批次/描述/备注）', () => {
    const map = buildHeaderMap([
      '公司', '岗位', '招聘类型', '秋招季', '城市',
      '薪资下限', '薪资上限', '薪资文本', '投递渠道', '投递链接',
      '开始日期', '截止日期', '批次', '职位描述', '备注'
    ])
    expect(TEMPLATE_HEADER.map((_, i) => map[i])).toEqual([...TEMPLATE_HEADER])
  })

  it('大小写/下划线/空格归一（Company、Hire_Type、SALARY_MIN、Channel URL）', () => {
    const map = buildHeaderMap(['Company', 'Hire_Type', 'SALARY_MIN', 'Channel URL', 'jd'])
    expect(map[0]).toBe('company')
    expect(map[1]).toBe('hire_type')
    expect(map[2]).toBe('salary_min')
    expect(map[3]).toBe('channel_url')
    expect(map[4]).toBe('jd')
  })

  it('未知列 → null（不参与映射）', () => {
    const map = buildHeaderMap(['foo', 'bar'])
    expect(map[0]).toBeNull()
    expect(map[1]).toBeNull()
  })

  it('重复别名列（company 与 公司 同现）→ 取最左列', () => {
    const map = buildHeaderMap(['company', '公司'])
    expect(map[0]).toBe('company')
    expect(map[1]).toBeNull()
  })
})

describe('parseCsvRowsToInputs 表头映射 + 逐行转换', () => {
  const TEMPLATE = [
    'company', 'title', 'hire_type', 'recruit_season', 'city',
    'salary_min', 'salary_max', 'salary_text', 'channel', 'channel_url',
    'start_date', 'end_date', 'batch', 'jd', 'notes'
  ]

  it('模板全字段行 → PositionInput（trim/空值归一/数字转换/company_type 缺省其他）', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [
        TEMPLATE,
        ['华为', '前端工程师', '校招', '2027秋招', '深圳', '20', '40', '20-40K', '牛客', 'https://example.com', '2026-08-01', '2026-09-30', '提前批', 'JD全文', '备注']
      ],
      buildHeaderMap(TEMPLATE)
    )
    expect(errors).toEqual([])
    expect(inputs).toEqual([
      {
        company: '华为',
        company_type: '其他',
        title: '前端工程师',
        hire_type: '校招',
        recruit_season: '2027秋招',
        city: '深圳',
        salary_min: 20,
        salary_max: 40,
        salary_text: '20-40K',
        channel: '牛客',
        channel_url: 'https://example.com',
        start_date: '2026-08-01',
        end_date: '2026-09-30',
        batch: '提前批',
        jd: 'JD全文',
        notes: '备注'
      }
    ])
  })

  it('只填必填两列（公司/岗位）也能转换，其余字段留空', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [['公司', '岗位'], ['华为', '前端']],
      buildHeaderMap(['公司', '岗位'])
    )
    expect(errors).toEqual([])
    expect(inputs).toEqual([{ company: '华为', company_type: '其他', title: '前端' }])
  })

  it('中文表头 + 混合大小写列 → 归一映射且值正确', () => {
    const { inputs } = parseCsvRowsToInputs(
      [['公司', '岗位', 'City', '薪资下限'], ['华为', '前端', '深圳', '25']],
      buildHeaderMap(['公司', '岗位', 'City', '薪资下限'])
    )
    expect(inputs[0]).toEqual({
      company: '华为',
      company_type: '其他',
      title: '前端',
      city: '深圳',
      salary_min: 25
    })
  })

  it('坏行：列数多于表头 → 收集错误不中断整批', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [['company', 'title'], ['华为', '前端'], ['腾讯', '后端', '多余列'], ['字节', '算法']],
      buildHeaderMap(['company', 'title'])
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('列数不匹配')
    expect(inputs.map((i) => i.company)).toEqual(['华为', '字节'])
  })

  it('坏行：薪资非数字 → 收集错误跳过该行，其余行照常', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [['company', 'title', 'salary_min'], ['华为', '前端', '20'], ['腾讯', '后端', 'abc'], ['字节', '算法', '30']],
      buildHeaderMap(['company', 'title', 'salary_min'])
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('薪资下限')
    expect(inputs.map((i) => i.company)).toEqual(['华为', '字节'])
  })

  it('空行（全空白单元格）跳过不报错', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [['company', 'title'], ['华为', '前端'], [''], ['  ', '']],
      buildHeaderMap(['company', 'title'])
    )
    expect(errors).toEqual([])
    expect(inputs).toHaveLength(1)
  })

  it('列数少于表头 → 末尾补空（Excel 导出常见），不报错', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [['company', 'title', 'city'], ['华为', '前端']],
      buildHeaderMap(['company', 'title', 'city'])
    )
    expect(errors).toEqual([])
    expect(inputs[0]).toEqual({ company: '华为', company_type: '其他', title: '前端' })
  })

  it('表头未识别任何列 → 文件级错误、无输入', () => {
    const { inputs, errors } = parseCsvRowsToInputs(
      [['姓名', '电话'], ['张三', '123']],
      buildHeaderMap(['姓名', '电话'])
    )
    expect(inputs).toEqual([])
    expect(errors[0]).toContain('表头')
  })

  it('空文件 → 文件级错误', () => {
    const { inputs, errors } = parseCsvRowsToInputs([], {})
    expect(inputs).toEqual([])
    expect(errors[0]).toContain('为空')
  })
})

describe('CSV_TEMPLATE_TEXT 模板（#68/T3 模板下载）', () => {
  it('表头为全字段英文标准列名，示例行可解析为合法输入', () => {
    const rows = parseCsv(CSV_TEMPLATE_TEXT)
    expect(rows).toHaveLength(2)
    const headerMap = buildHeaderMap(rows[0])
    expect(rows[0].map((_, i) => headerMap[i])).toEqual([
      'company', 'title', 'hire_type', 'recruit_season', 'city',
      'salary_min', 'salary_max', 'salary_text', 'channel', 'channel_url',
      'start_date', 'end_date', 'batch', 'jd', 'notes'
    ])
    const { inputs, errors } = parseCsvRowsToInputs(rows, headerMap)
    expect(errors).toEqual([])
    expect(inputs[0]).toMatchObject({
      company: '华为',
      title: '前端开发工程师',
      hire_type: '校招',
      recruit_season: '2027秋招',
      city: '深圳',
      salary_min: 20,
      salary_max: 40
    })
  })
})
