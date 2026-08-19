import { FakeAgentProvider } from './fake-agent-provider'
import type { Resume } from '../../shared/types/resume'

/**
 * E2E 测试基建（T02/#92）：dev 模式假 agent 开关用的脚本化 provider。
 *
 * 真实启动应用（`JOBHUNT_FAKE_AGENT=1`）时，ContentOptimizeService 的 LLM 轮次
 * 由本 provider 应答，保证 E2E 确定性：
 * - 内容优化诊断轮（提示词含 `[内容优化 1/2`）：从提示词内嵌的简历 JSON 提取项目，
 *   返回「全部保持」的空诊断（`projects: keep / questions: []`）→ 无需修改 → 不建版本；
 * - 其他任务类型回显（不会在 E2E 中触发真实模型）。
 */

/** 从诊断提示词中提取简历 JSON（标记 `简历 JSON：` 之后的对象）。 */
export function extractResumeFromPrompt(prompt: string): Resume | null {
  const marker = '简历 JSON：'
  const index = prompt.indexOf(marker)
  if (index === -1) return null
  const start = prompt.indexOf('{', index)
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < prompt.length; i++) {
    const ch = prompt[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(prompt.slice(start, i + 1)) as Resume
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 内容优化 E2E 假 agent：诊断轮返回全部「保持」的空诊断。 */
export function createContentOptimizeFakeProvider(): FakeAgentProvider {
  return new FakeAgentProvider({
    onPrompt: (prompt, session) => {
      if (session.task !== 'content_optimize') return `echo: ${prompt}`
      if (prompt.includes('[内容优化 1/2')) {
        const resume = extractResumeFromPrompt(prompt)
        const projects = (resume?.projects ?? []).map((p) => ({
          projectId: p.id ?? '',
          verdict: 'keep' as const
        }))
        return JSON.stringify({ rules: [], projects, questions: [] })
      }
      // 改写轮（T05 前不会被 E2E 触发）：回显兜底
      return `echo: ${prompt}`
    }
  })
}
