# 求职助手（jobhunt-ai-helper）

本地桌面求职应用：围绕「岗位匹配度」形成 **职位检索 → 简历优化 → 学习清单 → 模拟面试** 的闭环（MVP 范围，见 `docs/mvp-spec.md`）。

- 技术栈：Electron + Vue 3 + TypeScript（ESM）+ better-sqlite3 + pi SDK（agent）
- 数据全部本地存储（单文件 SQLite），无服务器
- 手动功能（职位/简历/采集/规则打分）不依赖模型；agent 功能（优化/学习/面试）未配置模型时给出引导提示

## 功能一览

| 模块 | 能力 |
|---|---|
| 职位 | 手动录入（去重）、采集（牛客校招日程/猎聘校招，节流/重试/上限/留痕）、预览确认入库（upsert）、详情/编辑/删除、网申倒计时、投递状态机（未投递→已投递→面试中→offer/已拒绝/已放弃）、匹配度评估（5 维度规则打分仪表） |
| 简历 | 分节编辑器（含政治面貌/生源地等国企字段）、JSON 模式、上传 docx/PDF 解析为草稿（置信度/缺字段/扫描件降级）、多份基准 + 按 JD 生成优化稿（三轮 agent：JD 解析→缺口评估→生成，strict 不虚构）、并排对比确认入库（派生稿关联职位卡）、A4 预览与 PDF 导出 |
| 学习 | 从 JD 分析生成清单（优先级 1-5/来源标记/去重/无缺口降级）、三态（待学习/学习中/已掌握）、teach 聊天会话（流式打字机、跨次续接） |
| 面试 | 四阶段编排（开场/技术面/反问/收尾）、三种风格（真实/教学/压力）、动态难度、打断/补充、文字输入兜底 + 按住说话（PTT 语音，模型缺失自动降级）、结束后自动生成复盘（4 维度 + 薄弱点参考回答 + 下一步）、薄弱点一键回填学习清单、历史回看 |

## 环境要求

- Node.js ≥ 22.19
- npm ≥ 11（`package.json` 使用 `allowScripts` 管理原生模块安装脚本）
- Windows（开发目标平台；Electron 跨平台代码，但采集/语音依赖以 Windows 验证）

## 安装与启动

```bash
# 1. 安装依赖（better-sqlite3 按 Electron ABI 安装，见 .npmrc）
npm ci

# 2. 开发模式（热重载）
npm run dev

# 3. 生产构建 + 启动
npm run build
npm start
```

## 配置模型（agent 功能必需）

设置页（侧边栏第五入口）→ 选择 provider 并填写 API key → 保存。

- API key 写入应用自有目录 `userData/pi/auth.json`，不落数据库、不依赖用户全局 `~/.pi/agent`
- 未配置时：职位/简历/采集/匹配度照常可用；优化/学习/面试显示配置引导
- teach 技能使用仓库内置副本（`resources/teach`），无需额外安装

## 语音输入（可选）

按住说话（PTT）需要 sherpa-onnx 流式中文模型，放入：

```
resources/sherpa-onnx/
├── encoder.onnx
├── decoder.onnx
├── joiner.onnx
└── tokens.txt
```

模型缺失时自动降级：面试页隐藏 PTT 按钮并提示使用文字输入（文字输入始终可用）。

## 测试与检查

```bash
npm test          # vitest（经 Electron-as-Node 运行：better-sqlite3 按 Electron ABI 安装，
                  # 普通 node 会因 NODE_MODULE_VERSION 不匹配无法加载，见 scripts/test.mjs）
npm run typecheck # tsc（主进程）+ vue-tsc（渲染进程）
npm run build     # electron-vite 构建
```

## 数据存储

- 数据库：`userData/jobhunt.db`（SQLite；positions/applications/topics/interviews/crawl_runs/settings 六表 + jd_analysis 缓存列，迁移见 `src/main/db/migrations.ts`）
- 模型认证：`userData/pi/auth.json`
- 采集留痕与候选快照：`crawl_runs` 表（预览确认的数据源）

## 目录结构

```
src/
├── main/          # 主进程：db / services（Position·Resume·Crawl·Topic·Learn·Interview·Optimize·Score·Asr·Agent）/ ipc
├── renderer/      # Vue 3：views（职位/简历/学习/面试/设置）+ components + composables
├── preload/       # contextBridge 类型化 api 客户端（无裸 ipcRenderer 调用）
└── shared/        # 主/渲染共用：类型、IPC 协议（protocol.ts）、resume schema、ScoreEngine
resources/
└── teach/         # teach 技能副本（学习会话使用）
docs/              # mvp-spec.md / architecture.md / adr/（0001-0007）/ research/
```

## 文档指针

- `docs/mvp-spec.md` — MVP 规格（需求/验收/降级策略）
- `docs/architecture.md` — 服务接口与 IPC 协议
- `docs/adr/` — 架构决策（Electron 主进程/pi SDK/单一简历 schema/混合打分/SQLite 模型/BrowserWindow 爬虫/sherpa-onnx）
- `CONTEXT.md` — 领域术语表
