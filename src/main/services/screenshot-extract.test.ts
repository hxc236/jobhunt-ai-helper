import { describe, expect, it } from 'vitest'
import { toScreenshotDraft, normalizeOcrText } from './screenshot-extract'

/**
 * 截图 OCR 文本 → 职位卡草稿（issue #67）。
 * Windows.Media.Ocr 输出特征：中文单字空格分隔（"职 位 描 述"），
 * 先归一化再去掉 CJK 间空格，复用 toBossPageDraft 的 BOSS 详情页段落识别；
 * 识别不到 JD 段落（非 BOSS 详情页截图）→ 兜底：整段文本进 JD。
 */

describe('normalizeOcrText（Windows OCR 单字空格归一化）', () => {
  it('去掉中文字符间的空格，保留拉丁/数字串', () => {
    expect(normalizeOcrText('职 位 描 述')).toBe('职位描述')
    expect(normalizeOcrText('20 - 40K · 14 薪')).toBe('20-40K·14薪')
    expect(normalizeOcrText('3 - 5 年 本 科')).toBe('3-5年本科')
    expect(normalizeOcrText('BOSS 直 聘 前 端 开 发 工 程 师')).toBe('BOSS 直聘前端开发工程师')
  })
  it('空输入不变', () => {
    expect(normalizeOcrText('')).toBe('')
  })
})

describe('toScreenshotDraft（OCR 文本 → 职位卡草稿）', () => {
  const BOSS_DETAIL_OCR = [
    '前 端 开 发 工 程 师 招 聘 - 法 本 - BOSS 直 聘',
    '20 - 40K · 14 薪',
    '上 海 · 浦 东 新 区 · 临 港 3 - 5 年 本 科',
    '职 位 描 述',
    '工 作 职 责',
    '负 责 自 动 驾 驶 数 据 平 台 的 前 端 架 构 设 计 与 开 发 。',
    '任 职 要 求',
    '1 . 本 科 及 以 上 学 历 ， 计 算 机 相 关 专 业 。',
    '公 司 介 绍',
    '法 本 信 息 是 全 国 领 先 的 软 件 技 术 服 务 提 供 商 。'
  ].join('\n')

  it('BOSS 详情页截图（含段落标记）→ 全字段映射（含薪资/城市/招聘类型）', () => {
    const result = toScreenshotDraft(BOSS_DETAIL_OCR)
    expect(result.draft).not.toBeNull()
    const draft = result.draft as NonNullable<typeof result.draft>
    expect(draft.title).toBe('前端开发工程师')
    expect(draft.company).toBe('法本')
    expect(draft.city).toBe('上海')
    expect(draft.salary_min).toBe(20)
    expect(draft.salary_max).toBe(40)
    expect(draft.salary_text).toBe('20-40K·14薪')
    expect(draft.hire_type).toBe('社招')
    expect(draft.jd).toContain('工作职责')
    expect(draft.jd).toContain('任职要求')
    expect(draft.jd).not.toContain('公司介绍')
  })

  it('非 BOSS 详情页（无段落标记）→ 兜底：整段文本进 JD，字段留空', () => {
    const result = toScreenshotDraft('某 公 司 招 聘 信 息\n招 聘 内 容 详 见 官 网')
    expect(result.draft).not.toBeNull()
    const draft = result.draft as NonNullable<typeof result.draft>
    expect(draft.jd).toContain('某公司招聘信息')
    expect(draft.jd).toContain('招聘内容详见官网')
    expect(draft.title).toBe('某公司')
    expect(draft.company).toBe('')
  })

  it('空 OCR 文本 → 错误', () => {
    const result = toScreenshotDraft('')
    expect(result.draft).toBeNull()
    expect(result.error).toBeTruthy()
  })
})
