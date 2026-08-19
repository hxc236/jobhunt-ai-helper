import { FakeAgentProvider } from './fake-agent-provider'
import type { Resume } from '../../shared/types/resume'

/**
 * E2E 测试基建（T02/#92）：dev 模式假 agent 开关用的脚本化 provider。
 *
 * 真实启动应用（`JOBHUNT_FAKE_AGENT=1`）时，ContentOptimizeService 的 LLM 轮次
 * 由本 provider 应答，保证 E2E 确定性：
 * - 内容优化诊断轮（提示词含 `[内容优化 1/2`）：从提示词内嵌的简历 JSON 提取项目，
 *   按场景返回：
 *   - `empty`（默认）：全部「保持」的空诊断（projects: keep / questions: []）→ 无需修改 → 不建版本；
 *   - `questions`（JOBHUNT_E2E_SCENARIO=questions）：含追问的诊断（项目需补充信息，
 *     questions 带稳定 id）→ awaiting_answers → 追问表单 → 提交回答 → 改写轮；
 *   - `promotion`（JOBHUNT_E2E_SCENARIO=promotion）：honors 含大赛（种子简历带荣誉）→
 *     输出大赛提升建议 → 追问表单确认提升 → 重新诊断（提升后 honors 已无大赛 → 全部保持）；
 * - 内容优化改写轮（提示词含 `[内容优化 2/2`）：questions 场景返回合法最小 ContentRewrite
 *   （原简历原样 + 一条 change），empty 场景不会触发；
 * - 其他任务类型回显（不会在 E2E 中触发真实模型）。
 */

/** E2E 假 agent 场景：empty=空诊断（T02 垂直切片）；questions=追问流程（T04）；promotion=大赛提升（T08）。 */
export type E2eContentScenario = 'empty' | 'questions' | 'promotion'

/** 大赛/竞赛特征词（种子简历 honors 判定；真实场景由 LLM 判定）。 */
const COMPETITION_PATTERN = /大赛|竞赛|挑战赛|比赛|杯赛|杯/

/** 从 honors 中找第一个大赛条目下标（无则 -1）。 */
export function findCompetitionHonorIndex(honors: string[] | undefined): number {
  return (honors ?? []).findIndex((h) => COMPETITION_PATTERN.test(h))
}

/** 从提示词中提取简历 JSON（标记 `简历 JSON：` 之后的对象）。 */
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

/** 内容优化 E2E 假 agent（场景化；场景默认由 JOBHUNT_E2E_SCENARIO 环境变量决定）。 */
export function createContentOptimizeFakeProvider(
  options: { scenario?: E2eContentScenario } = {}
): FakeAgentProvider {
  const envScenario = process.env['JOBHUNT_E2E_SCENARIO']
  const scenario: E2eContentScenario =
    options.scenario ?? (envScenario === 'questions' || envScenario === 'promotion' ? envScenario : 'empty')
  return new FakeAgentProvider({
    onPrompt: (prompt, session) => {
      if (session.task !== 'content_optimize') return `echo: ${prompt}`
      if (prompt.includes('[内容优化 1/2')) {
        const resume = extractResumeFromPrompt(prompt)
        const projects = (resume?.projects ?? []).map((p) => ({
          projectId: p.id ?? '',
          verdict: 'keep' as const
        }))
        if (scenario === 'promotion') {
          // T08 大赛提升场景：honors 中仍有大赛 → 输出提升建议；已提升（honors 无大赛）→ 全部保持。
          const honorIndex = findCompetitionHonorIndex(resume?.honors)
          if (honorIndex !== -1) {
            const honorName = resume?.honors?.[honorIndex] ?? '大赛'
            return JSON.stringify({
              rules: [],
              projects,
              questions: [],
              promotions: [
                {
                  id: 'promo-0',
                  honorIndex,
                  honorName,
                  evidence: `原文：${honorName}`,
                  missingFields: ['startDate', 'techStack', 'description']
                }
              ]
            })
          }
          return JSON.stringify({ rules: [], projects, questions: [], promotions: [] })
        }
        if (scenario === 'questions' && projects.length > 0) {
          // T04 追问场景：首个项目需补充信息（难点/结果），带稳定 id 的追问
          const pid = projects[0]!.projectId
          return JSON.stringify({
            rules: [
              { ruleId: 'R1', target: `project:${pid}`, status: 'improve', evidence: '原文：C2C 二手交易系统', issue: '缺难点与解决行动', suggestion: '补充技术难点与解决行动', factSource: 'original' },
              { ruleId: 'R4-结果', target: `project:${pid}`, status: 'insufficient', evidence: '原文未提及结果', issue: '缺可归因结果', suggestion: '回答结果追问', factSource: 'original' }
            ],
            projects: [{ projectId: pid, verdict: 'needs-info' }],
            questions: [
              { id: 'q1', projectId: pid, field: '难点', question: '项目最大的技术难点是什么？', evidence: '原文：C2C 二手交易系统', candidates: ['高并发秒杀压测优化', '分布式锁保证一致性'] },
              { id: 'q2', projectId: pid, field: '结果', question: '项目最终达成了什么可量化的结果？', evidence: '原文未提及', candidates: ['接口 P95 < 200ms'] }
            ]
          })
        }
        return JSON.stringify({ rules: [], projects, questions: [] })
      }
      if (prompt.includes('[内容优化 2/2')) {
        if (scenario === 'questions') {
          // 合法最小 ContentRewrite：改写稿对项目做真实改动（parseRewrite 过 schema + 溯源校验）
          const resume = extractResumeFromPrompt(prompt)
          const pid = resume?.projects?.[0]?.id ?? ''
          const rewritten = {
            ...resume,
            projects: (resume?.projects ?? []).map((p, i) =>
              i === 0
                ? { ...p, description: 'C2C 二手交易系统（含高并发难点与可量化结果）' }
                : p
            )
          }
          return JSON.stringify({
            resume: rewritten,
            changes: [
              {
                projectId: pid,
                section: 'projects',
                before: 'C2C 二手交易系统',
                after: 'C2C 二手交易系统（含高并发难点与可量化结果）',
                reason: '融合用户回答补充难点与可量化结果',
                source: 'user-answer'
              }
            ]
          })
        }
        // 改写轮（empty 场景不会被 E2E 触发）：回显兜底
        return `echo: ${prompt}`
      }
      return `echo: ${prompt}`
    }
  })
}
