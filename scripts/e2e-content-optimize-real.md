# 内容优化 E2E：真实 agent 冒烟入口（T09/AC4，手动运行）

全流程冒烟默认使用 **假 agent**（`JOBHUNT_FAKE_AGENT=1`，确定性断言，见 `e2e-content-optimize.mjs`）。
本文档描述 **真实 agent 冒烟入口**：不注入假 agent，真实调用 LLM 走通内容优化基本流程。

## 定位

- **冒烟接缝**（依赖真实显示环境 + 真实 LLM 服务），**非全量回归**（#90 Testing Decisions）。
- 真实 LLM 输出不确定，**不适用确定性断言**：脚本只驱动「触发内容优化 → 任务到达稳定阶段
  （等待回答 / 可确认 / 无需修改 / 失败）」，并给出截图与落库状态。
- 任务失败时脚本以非零码退出并打印 **明确失败说明**（错误信息）。

## 前置

1. `npm run build`（electron-vite 产物 `out/`）。
2. **在一个持久 userData 目录中配置好 Agent**（provider / API key / model）：
   - 先以该目录启动应用：
     ```bat
     set JOBHUNT_USER_DATA_DIR=%TEMP%\jh-real-agent-e2e
     npm start
     ```
   - 在应用「设置」中配置 AI Agent（provider、API key、model），保存后退出应用。
   - Agent 认证写入该 userData 下的 `pi/auth.json`，配置存入设置库——后续真实冒烟复用同一目录。
3. 网络可达 LLM 服务，API key 有效。

## 运行

```bat
set JOBHUNT_E2E_USER_DATA=%TEMP%\jh-real-agent-e2e
npm run e2e:content-optimize:real
```

（等价于 `JOBHUNT_E2E_REAL=1 node scripts/e2e-run.mjs --real`。）

脚本行为：

1. 以 `JOBHUNT_E2E_USER_DATA` 指向的持久 userData 真实启动应用（**不注入假 agent**）；
2. `JOBHUNT_E2E_SEED=1` 预置一份基准简历（仅在无简历时）；
3. 驱动「简历 → 内容优化」触发，等待任务卡片到达稳定阶段（最多 10 分钟）；
4. 截图 + 读取落库任务状态并打印；
5. 任务 `failed` → 打印错误并以非零码退出（明确失败说明）；其余稳定阶段 → 通过。

## 预期结果

- 正常路径：任务到达 `awaiting_answers`（诊断提出追问）或 `ready_for_review` / `noChanges`（无需修改）。
- 失败路径：`failed`（LLM 超时/未配置/输出非法等），脚本打印具体错误——可据此排查配置或网络。

## 与假 agent 全流程冒烟的关系

- `npm run e2e:content-optimize:full`（假 agent）做**确定性全流程断言**（触发/进度/追问/逐项确认/入库）；
- `npm run e2e:content-optimize:real`（真实 agent）做**手动冒烟接缝**（真实模型可达性 + 基本流程可用）。
