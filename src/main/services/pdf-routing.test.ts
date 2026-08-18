import { describe, expect, it } from 'vitest'
import { normalizeExtractedText, reflowTwoColumn } from './pdf-routing'

/**
 * #82 纯函数测试：安全归一（只改形式不改事实）+ 双栏坐标重排。
 * 验收关键：姓名/电话/邮箱/学校/日期内容/数字不被静默猜改（易错字符回归）。
 */

describe('normalizeExtractedText 安全归一（#82）', () => {
  it('全角空格/全半角标点/连续空白归一（仅形式）', () => {
    const input = '张伟　电话：138-0000-1234　　邮箱：zhangwei@example.com\n\n\n技能：Java，Spring Boot；TypeScript'
    const out = normalizeExtractedText(input)
    expect(out).not.toContain('\u3000') // 全角空格已归一
    expect(out).toContain('电话:138-0000-1234')
    expect(out).toContain('邮箱:zhangwei@example.com')
    expect(out).toContain('Java,Spring Boot;TypeScript')
    expect(out).not.toContain('\n\n\n') // 连续换行折叠
    expect(out).not.toContain('  ') // 连续空格折叠
  })

  it('日期分隔符形式归一（带年月日标记，不补零）', () => {
    expect(normalizeExtractedText('2022年9月入学')).toBe('2022-9入学')
    expect(normalizeExtractedText('2022年09月06日')).toBe('2022-09-06')
  })

  it('不静默改事实：电话 0/O、1/l/I、邮箱、姓名、小数不被修改', () => {
    // 易错字符：OCR 原文保持原样（归一只动空白/标点）
    const input = '电话：1O8-0O00-1234　邮箱：zhangwei@examp1e.com　GPA：3.7/4.0　排名前1O%'
    const out = normalizeExtractedText(input)
    expect(out).toContain('1O8-0O00-1234') // 字母 O 不被猜改
    expect(out).toContain('zhangwei@examp1e.com') // 1 不被猜改为 l
    expect(out).toContain('3.7/4.0') // GPA 小数不动
    expect(out).toContain('1O%')
    // 裸日期分隔符形式（无年月日标记）可能是小数/编号：2022.9 万 不得改为 2022-9 万
    expect(normalizeExtractedText('月薪 2022.9 万')).toContain('2022.9')
  })

  it('姓名与学校不被改动', () => {
    const out = normalizeExtractedText('姓名：张伟，学校：北京理工大学')
    expect(out).toContain('张伟')
    expect(out).toContain('北京理工大学')
  })
})

describe('reflowTwoColumn 双栏坐标重排（#82）', () => {
  it('左右双栏按「左栏 → 右栏、栏内按行」恢复阅读顺序', () => {
    const items = [
      // 左栏（x≈40）
      { str: '姓名', x: 40, y: 100 }, { str: '张伟', x: 40, y: 130 },
      { str: '电话', x: 40, y: 160 }, { str: '138-0000-1234', x: 40, y: 190 },
      // 右栏（x≈500）
      { str: '教育', x: 500, y: 100 }, { str: '北京理工大学', x: 500, y: 130 },
      { str: '学历', x: 500, y: 160 }, { str: '本科', x: 500, y: 190 }
    ]
    const out = reflowTwoColumn(items)
    const leftIdx = out.indexOf('姓名')
    const rightIdx = out.indexOf('教育')
    expect(leftIdx).toBeGreaterThan(-1)
    expect(rightIdx).toBeGreaterThan(leftIdx) // 左栏优先
    // 栏内按行：电话行在 姓名 行之后
    expect(out.indexOf('电话')).toBeGreaterThan(out.indexOf('姓名'))
  })

  it('单栏输入按行输出（不破坏已有顺序）', () => {
    const items = [
      { str: '第一行', x: 100, y: 100 },
      { str: '第二行', x: 100, y: 140 },
      { str: '第三行', x: 100, y: 180 }
    ]
    const out = reflowTwoColumn(items)
    expect(out).toBe('第一行\n第二行\n第三行')
  })
})
