# 整体架构设计（jobhunt-ai-helper）

依据：ADR-0001~0007 + spec #13。本文档细化到**模块接口与 IPC 协议**级别，是实现 tickets 的切分依据。

## 分层总览

```
┌──────────────────────────────────────────────────────────┐
│ 渲染进程 (Vue 3 + Vite + vue-router hash)                 │
│  AppShell 侧边栏：职位 / 简历 / 学习 / 面试 / 设置         │
│  视图 → composables → api 客户端（类型化，contextBridge）  │
├──────────────────────────────────────────────────────────┤
│ IPC（shared/protocol）：invoke/handle 请求-响应 + 事件推送 │
├──────────────────────────────────────────────────────────┤
│ 主进程服务层（构造注入 db / agent provider / fetcher）     │
│  Settings · Position · Resume · ScoreEngine · Optimize    │
│  Topic · Interview · Crawl · AgentService · Asr           │
├──────────────────────────────────────────────────────────┤
│ db：better-sqlite3（:memory: 可注入）+ SQL migrations     │
│ 表：positions / applications / topics / interviews /      │
│     crawl_runs / settings                                 │
└──────────────────────────────────────────────────────────┘
```

## 目录结构

```
src/
├── main/                 # 主进程
│   ├── index.ts          # 窗口 + 生命周期 + IPC 注册
│   ├── services/         # 十个服务（见下）
│   ├── db/               # 连接 + migrations + 访问层
│   └── ipc/              # handler 注册（薄层，仅参数校验+转调服务）
├── renderer/             # Vue 3
│   ├── AppShell.vue      # 侧边栏 + <router-view>
│   ├── views/            # jobs / resumes / learn / interview / settings
│   ├── components/       # 聊天组件（流式打字机）、简历渲染、复盘卡片…
│   └── composables/      # usePositions / useOptimize / useInterview…
├── shared/               # 主/渲染共用
│   ├── types/            # 实体 + 请求/响应 + 事件类型
│   └── protocol.ts       # channel 常量 + 类型化签名
└── resources/            # sherpa-onnx 模型、teach 技能副本
```

## 服务接口（主进程）

构造注入：`db`（SQLite 实例）、`agentProvider`（真实 pi SDK / fake）、`fetcher`（BrowserWindow 抓取器）。

- **SettingsService**: `getStatus(): {configured, provider, model}` · `configureProvider(provider, apiKey, model)`（写应用自有 auth.json 经 ModelRuntime）· `get/set(key, value)`（非敏感设置入 settings 表）
- **PositionService**: `create(input)`（含 dedupe_key 生成）· `update(id, patch)` · `list(filters)` · `get(id)` · `setApplicationState(positionId, {appliedAt, channel, status})`（状态机校验）
- **ResumeService**: `list() / get(id) / create(resume) / update(id, resume)`（schema 校验）· `delete(id)`（删除基准不影响已存派生稿——独立副本，F-12 已实现）· `parseUpload(filePath): Draft`（docx/pdf）· `confirmDraft(draft): id` · `renderHtml(id): string`（A4 模板）· `exportPdf(id): path`
- **ScoreEngine**（纯函数，无依赖）: `score({jdAnalysis, resume}): {total, dimensions[{name,score,evidence}], hits, misses}`
- **OptimizeService**: `run(jobId, resumeId, mode): OptimizeTask`（三轮 agent：JD 解析→评估→生成优化稿+changes[]；写 jd_analysis 缓存；`optimizationMode: strict|balanced`）
- **TopicService**: `generateFromJob(jobId)`（jd_analysis + 缺口 + 项目 techStack，优先级 1-5；无缺口来源时降级）· `create/update/delete(id)` · `setStatus(id, status)`
- **InterviewService**: `start(jobId, style): {sessionId}`（注入 JD 分析/优化简历/learned 清单）· `answer(sessionId, text)`（agent 回复流）· `interrupt(sessionId)` · `end(sessionId): Review`（LLM 复盘 + suggestLearn 入 topics）· `history()`
- **CrawlService**: `run(source, mode, filter): Preview{candidates, inserted, updated, missingFields}`（节流/重试/上限）· `confirmImport(previewId)`（upsert）· `runs()`
- **AgentService**（底层）：session provider 抽象；`optimizeTask(params)` · `interviewSession(params)`（长驻，steer/followUp）· `learnSession(topic)`（teach，cwd=教学工作区，continueRecent）；事件流 `text_delta / tool_* / turn_end / error`
- **AsrService**: `startRecording()`（PTT 按下）· `stopRecording(): text`（sherpa-onnx 流式 + VAD 切句）

## IPC 协议（shared/protocol.ts）

类型化 channel 清单（示意）：

```
请求-响应（invoke/handle）：
  settings:get-status · settings:configure-provider
  positions:list · positions:create · positions:update · positions:set-application
  resumes:list · resumes:create · resumes:update · resumes:delete · resumes:upload-parse
  resumes:render-html · resumes:export-pdf
  optimize:run · topics:generate · topics:update
  interview:start · interview:answer · interview:interrupt · interview:end · interview:history
  crawl:run · crawl:confirm-import · crawl:runs
  asr:start · asr:stop

事件推送（主 → 渲染）：
  agent:delta（流式文本）· agent:status · interview:turn-end · crawl:progress
```

渲染进程通过 `api` 客户端对象调用（每个 channel 一个类型化方法），不裸调 `ipcRenderer.invoke`。

## db 层

- better-sqlite3 主进程直连；`migrations = [sql, sql, ...]` + `PRAGMA user_version` 递增执行
- 表：positions / applications / topics / interviews / crawl_runs（ADR-0005 定稿）+ **settings**（key-value，非敏感设置）
- `jd_analysis` 为 positions 的 JSON 列；`transcript`/`review` 为 interviews 的 JSON 列

## 渲染层

- vue-router（hash）：`/jobs` `/resumes` `/learn` `/interview` `/settings` + 详情子路由
- composables 封装 api 客户端 + 本地状态；聊天组件统一消费 `agent:delta` 流（优化进度/教学/面试通用）
- 降级提示：`settings:get-status` 未配置时，优化/学习/面试视图显示引导卡片（跳设置）；职位/简历/采集照常

## 关键数据流（验收主线）

```
职位卡(手动/采集) ──JD──> OptimizeService 三轮 ──> jd_analysis 缓存
                                              └──> 优化简历(确认入库)
jd_analysis + 缺口 + techStack ──> topics 清单 ──> teach 会话(跨次续接)
职位卡 + 优化简历 + learned ──> 面试会话(PTT+ASR) ──> 复盘 ──> suggestLearn 入 topics
```

## 降级策略（分层，spec #13 Q3）

- LLM 未配置/断网：职位/简历/采集/规则打分（ScoreEngine）可用；Optimize/Interview/teach 提示配置
- ASR 未就绪（模型文件缺失）：面试退化为文字输入（T15 验收含此路径）
- 爬虫目标站结构变化：解析器单独修（nowcoder/liepin 分离），采集失败不影响其他模块
