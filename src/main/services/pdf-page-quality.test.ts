import { describe, expect, it } from 'vitest'
import { analyzePageQuality, SOFT_OCR_THRESHOLD } from './pdf-page-quality'

/**
 * #79 页面质量判断 seam 测试：硬异常示例、每种软异常分项、分值边界（39/40）、
 * 以及「内容很少但确实是正常尾页」的反例（防止所有稀疏页面被误 OCR）。
 */

function result(text: string, hasVisualContent: boolean, items?: Array<{ str: string; x: number; y: number }>) {
  return analyzePageQuality({ text, hasVisualContent, items })
}

describe('analyzePageQuality 硬异常（任一命中 → OCR）', () => {
  it('有视觉内容但无文本层 → no-text-with-visual → ocr', () => {
    const r = result('', true)
    expect(r.hard).toContain('no-text-with-visual')
    expect(r.decision).toBe('ocr')
  })

  it('替换字符（U+FFFD）或 NUL → replacement-or-nul → ocr', () => {
    expect(result('张伟\uFFFD电话 138-0000-1234', true).hard).toContain('replacement-or-nul')
    expect(result('张伟\u0000电话', true).hard).toContain('replacement-or-nul')
  })

  it('控制字符/私用区字符占比 ≥ 5% → control-or-private-ratio → ocr', () => {
    // 20 字符中 2 个私用区字符 = 10% ≥ 5%
    const text = '正常内容正常内容正常内容\uE000\uF8FF'
    const r = result(text, true)
    expect(r.hard).toContain('control-or-private-ratio')
    expect(r.decision).toBe('ocr')
    // 低于 5% 不触发（26 字符中 1 个 ≈ 3.8%）
    expect(result('正常内容正常内容正常内容正常内容正常内容\uE000', true).hard).not.toContain('control-or-private-ratio')
  })

  it('视觉内容与文本量严重不匹配（文本 < 30 字符且页面丰富）→ visual-text-mismatch → ocr', () => {
    const r = result('张伟 电话', true)
    expect(r.hard).toContain('visual-text-mismatch')
    expect(r.decision).toBe('ocr')
    // 纯文本页（无视觉内容标志）短文本不误判
    expect(result('张伟 电话', false).hard).not.toContain('visual-text-mismatch')
  })
})

describe('analyzePageQuality 软异常分项', () => {
  it('有效中英文/数字比例 < 70% → +30', () => {
    // 大量符号/乱码：有效字符比例低（≥30 字符避开视觉失配硬异常）
    const r = result('%%%%%%%&&&&&@@@@@#######$$$$$$$*****+++++ 正常', true)
    const item = r.soft.find((s) => s.type === 'low-valid-ratio')
    expect(item?.score).toBe(30)
  })

  it('文本稀少但页面内容丰富 → +30', () => {
    // ≥30 字符（不触硬异常）且 <120（稀少）+ 有视觉内容
    const r = result('张伟 电话：138-0000-1234 邮箱：zhangwei@example.com 现居：北京 求职意向：后端开发工程师 教育：北京理工大学', true)
    const item = r.soft.find((s) => s.type === 'sparse-rich-page')
    expect(item?.score).toBe(30)
  })

  it('异常断词/碎片化（中文字符间空格 ≥ 3 处）→ +20', () => {
    const r = result('张 伟 北 京 理 工 大 学 计 算 机 专 业 学 习 能 力 强', false)
    const item = r.soft.find((s) => s.type === 'fragmented-words')
    expect(item?.score).toBe(20)
  })

  it('双栏坐标分布 → +25', () => {
    const items = [
      { str: '左一', x: 40, y: 100 }, { str: '左二', x: 45, y: 130 }, { str: '左三', x: 42, y: 160 },
      { str: '左四', x: 38, y: 190 }, { str: '左五', x: 44, y: 220 }, { str: '左六', x: 40, y: 250 },
      { str: '右一', x: 500, y: 100 }, { str: '右二', x: 510, y: 130 }, { str: '右三', x: 505, y: 160 },
      { str: '右四', x: 498, y: 190 }
    ]
    // hasVisual=false：仅考察坐标信号（避免短文本触发视觉失配硬异常）
    const r = result('左一左二左三左四左五左六右一右二右三右四', false, items)
    const item = r.soft.find((s) => s.type === 'two-column-order')
    expect(item?.score).toBe(25)
  })

  it('关键字段格式异常（截断日期/电话字母混淆）→ +15', () => {
    const r = result('教育经历 202-09 至 2026-06 电话 1O8-0000-1234', true)
    const item = r.soft.find((s) => s.type === 'key-format-anomaly')
    expect(item?.score).toBe(15)
  })

  it('重复行或截断迹象 → +15', () => {
    // 重复行（文本 ≥30 字符避免硬异常）
    expect(
      result('张伟 电话：138-0000-1234 邮箱：zhangwei@example.com\n技能 Java Python TypeScript\n技能 Java Python TypeScript', true).soft.some((s) => s.type === 'duplicate-or-truncated')
    ).toBe(true)
    // 多行末行极短无结束标点（截断迹象）
    expect(
      result('张伟 电话：138-0000-1234 邮箱：zhangwei@example.com\n教育经历 北京理工大学 计算机科学与技术\n短尾', true).soft.some((s) => s.type === 'duplicate-or-truncated')
    ).toBe(true)
  })
})

describe('analyzePageQuality 决策边界与反例', () => {
  it('软异常累计 39 分 → pending；达到 40 分 → ocr', () => {
    // 30（有效比例）+ 20（碎片化）= 50 → ocr（文本 ≥30 字符避免硬异常）
    const r50 = result('%%%%%%%&&&&&&&@@@@@@@### 张 伟 北 京 理 工 大 学 计 算 机 专 业', true)
    expect(r50.softScore).toBeGreaterThanOrEqual(SOFT_OCR_THRESHOLD)
    expect(r50.decision).toBe('ocr')
    // 25 + 15 = 40 → ocr（边界）
    const twoColItems = [
      { str: 'a', x: 40, y: 100 }, { str: 'b', x: 45, y: 130 }, { str: 'c', x: 42, y: 160 },
      { str: 'd', x: 38, y: 190 }, { str: 'e', x: 44, y: 220 }, { str: 'f', x: 40, y: 250 },
      { str: 'g', x: 500, y: 100 }, { str: 'h', x: 510, y: 130 }, { str: 'i', x: 505, y: 160 },
      { str: 'j', x: 498, y: 190 }
    ]
    const r40 = result('abcdefghij 202-09 1O8-0000-1234 教育经历', true, twoColItems)
    expect(r40.softScore).toBeGreaterThanOrEqual(SOFT_OCR_THRESHOLD)
    expect(r40.decision).toBe('ocr')
    // 15 分 → pending（重复行，无其他异常；hasVisual=false 避免稀少页信号干扰）
    const r15 = result('张伟 电话：138-0000-1234 邮箱：zhangwei@example.com\n教育经历：北京理工大学 计算机科学与技术\n教育经历：北京理工大学 计算机科学与技术', false)
    expect(r15.softScore).toBe(15)
    expect(r15.decision).toBe('pending')
  })

  it('内容很少但确实是正常尾页（无视觉内容标志）→ text，不误 OCR', () => {
    // 简历尾页只有一行简短内容：无视觉内容标志、有效字符比例高、无异常
    const r = result('第 3 页', false)
    expect(r.decision).toBe('text')
    expect(r.softScore).toBe(0)
    // 有视觉内容但文本足够多 → 也不误判
    const normal = result(
      '张伟\n电话：138-0000-1234\n邮箱：zhangwei@example.com\n北京理工大学 本科 计算机科学与技术 2022-09 ~ 2026-06\n技能：Java、Spring Boot、TypeScript\n项目：校园二手交易平台 基于 Spring Boot 实现',
      true
    )
    expect(normal.hard).toEqual([])
    expect(normal.decision).toBe('text')
  })
})
