/**
 * 文本工具（shared：内容优化诊断/改写/整合确认共用，单一实现防止漂移）。
 *
 * #95 review 修复：normalizeText/flattenValue 原在 rewrite-engine 与 content-review
 * 各有一份近同实现（正则/递归逻辑重复）——统一收口到本模块，两处 import 同一实现。
 */

/** 宽松归一：去空白（含全角空格）、去常见标点、小写。 */
export function normalizeText(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(
      /[，。、,.;；:：!！?？()（）「」『』【】\[\]{}"'“”‘’\u2010-\u2015—_/\\]/g,
      ''
    )
    .toLowerCase()
}

/** 任意值扁平化（数组按序 join、对象按值 join）——项目/节文本比较用。 */
export function flattenValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => flattenValue(item)).join('\n')
  if (typeof value === 'object' && value !== null) return flattenObject(value as Record<string, unknown>)
  return ''
}

/** 对象值扁平化（忽略键名，仅取值）。 */
export function flattenObject(obj: Record<string, unknown>): string {
  return Object.values(obj).map((v) => flattenValue(v)).join('\n')
}
