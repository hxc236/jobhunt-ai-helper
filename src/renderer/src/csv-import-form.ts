import type { CsvImportPreviewResult, CsvImportSelection, PositionInput } from '@shared/types'

/**
 * CSV 导入确认请求构造（#68/T3；issue #72 回归修复）。
 *
 * 为什么需要深拷贝：`csvPreview` 是 `ref`（深响应式），`preview.items[i].input` 实际是
 * Vue 响应式 **Proxy**。渲染 → 主进程的 `ipcRenderer.invoke` 走 structured clone，
 * Proxy 不可序列化 → 抛「An object could not be cloned.」（DataCloneError）。
 * 这里对 input 做 JSON 往返得到纯数据对象（字段均为 JSON 安全类型：string/number）。
 */
export function csvSelections(
  preview: CsvImportPreviewResult,
  selected: Set<number>,
  updates: Set<number>
): CsvImportSelection[] {
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => ({
      // JSON 往返剥离响应式代理（Proxy 对 JSON.stringify 透明，结果必为纯对象）
      input: JSON.parse(JSON.stringify(preview.items[i].input)) as PositionInput,
      // 仅 exists 行 update 标志有意义（勾选即默认更新；可取消）；新行走插入
      update: preview.items[i].exists ? updates.has(i) : false
    }))
}
