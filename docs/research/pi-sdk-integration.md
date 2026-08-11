# 调研：pi SDK（@earendil-works/pi-coding-agent）在 Electron 应用中的集成能力边界

- **关联 ticket**: https://github.com/hxc236/jobhunt-ai-helper/issues/2
- **调研对象**: `@earendil-works/pi-coding-agent` v0.84.1（本机全局安装于 `D:\npm-global\node_modules\@earendil-works\pi-coding-agent\`）
- **调研日期**: 2026 年（以 v0.84.1 源码为准）
- **结论先行**: SDK 可以直接在 Electron 主进程（Node 运行时）中运行，覆盖产品三个模块的全部需求（会话创建/流式输出/中断/多会话/持久化/skills）。唯一硬性门槛是 Node ≥ 22.19（ESM 包）；核心 SDK 路径**无原生依赖**，打包无额外负担。

---

## 1. 总览：SDK 提供什么

`createAgentSession()` + `AgentSession` 是主入口，围绕它还有三个配套设施：

| 组件 | 作用 |
|---|---|
| `createAgentSession(options)` | 工厂函数，创建单个 `AgentSession`（含事件流、消息历史、模型状态、compaction、队列） |
| `createAgentSessionRuntime()` / `AgentSessionRuntime` | 需要"替换当前会话"（新建/恢复/fork/导入）时的运行时层，内置交互模式与 RPC 模式同层 |
| `ModelRuntime` | 模型目录 + 凭据（API key / OAuth）统一管理 |
| `SessionManager` / `SettingsManager` | 会话持久化（JSONL 树）与设置 |

来源：`docs/sdk.md`（Core Concepts 一节）、`docs/sdk.md`（Run Modes 一节）。

---

## 2. createAgentSession 用法与选项

最小用法（来源：`examples/sdk/01-minimal.ts`、`docs/sdk.md` Quick Start）：

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();   // 读 ~/.pi/agent/auth.json + models.json
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),        // 或 create(cwd)/continueRecent(cwd)/open(path)
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("...");
```

完整选项（来源：`docs/sdk.md` Options Reference、`examples/sdk/README.md` Options 表）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `cwd` | `process.cwd()` | DefaultResourceLoader 的资源发现根 + 会话目录命名 + 内置工具工作目录 |
| `agentDir` | `~/.pi/agent` | 全局配置目录（extensions/skills/prompts/settings/models/auth/sessions） |
| `model` | settings 或第一个可用模型 | `getModel("anthropic", "...")` 或 `modelRuntime.getModel(provider, id)` |
| `thinkingLevel` | settings/"off" | off/minimal/low/medium/high/xhigh/max |
| `scopedModels` | — | 模型循环列表（对应 Ctrl+P） |
| `modelRuntime` | 默认运行时 | 认证解析优先级：运行时 override（不落盘）→ `auth.json` → 环境变量 → fallback resolver |
| `tools` | `["read","bash","edit","write"]` | 内置工具白名单：read/bash/edit/write/grep/find/ls；`noTools: "all"/"builtin"`、`excludeTools` 亦可 |
| `customTools` | `[]` | `defineTool()` 定义的自定义工具，与扩展注册的工具合并 |
| `resourceLoader` | `DefaultResourceLoader` | 负责 extensions/skills/prompts/themes/context files 的发现 |
| `sessionManager` | `SessionManager.create(cwd)` | 持久化策略 |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | 设置（compaction/retry 等），`inMemory()` 免文件 IO |

返回值：`{ session, extensionsResult, modelFallbackMessage? }`（来源：`docs/sdk.md` Return Value）。

要点：

- **认证可完全由应用自管**：`ModelRuntime.create({ authPath, modelsPath })` 可指向应用自己的目录，或注入 `InMemoryCredentialStore`；`modelRuntime.setRuntimeApiKey("anthropic", key)` 不落盘。不必让用户装 pi CLI 或写 `~/.pi/agent`（来源：`docs/sdk.md` API Keys and OAuth、`examples/sdk/12-full-control.ts`）。
- **system prompt 可覆盖**：`DefaultResourceLoader({ systemPromptOverride: () => "..." })`，或用自定义 `ResourceLoader` 全量接管（来源：`docs/sdk.md` System Prompt、`examples/sdk/03-custom-prompt.ts`、`examples/sdk/12-full-control.ts`）。
- 每次 `session.prompt()` 前需有可用认证，否则抛错（源码：`dist/core/agent-session.js` preflight 逻辑）。

---

## 3. Skills：发现与调用（含 teach 技能）

### 发现（来源：`docs/sdk.md` Directories、`docs/skills.md` Locations）

`DefaultResourceLoader` 按以下位置发现 skills：

- `agentDir/skills/`（即 `~/.pi/agent/skills/`）、`~/.agents/skills/`
- `cwd/.pi/skills/`、cwd 及祖先目录的 `.agents/skills/`（到 git 仓库根）
- `settings.json` 的 `skills` 数组；CLI `--skill`；pi 包（npm/git）的 `skills/` 目录
- 目录式：包含 `SKILL.md` 的目录递归发现；`.pi/skills/` 下根级 `.md` 直接作为技能

可通过 `skillsOverride` 过滤/合并/注入自定义技能（`examples/sdk/04-skills.ts` 演示了用 `createSyntheticSourceInfo` 注入虚拟技能）；加载后 `loader.getSkills()` 返回 `{ skills, diagnostics }`。

### 调用机制（SDK 场景下关键，源码：`dist/core/agent-session.js` L824、L949-985）

- `/skill:name [args]` 是技能命令；`session.prompt()` 在发送前**自动展开**技能内容（`expandPromptTemplates` 默认 `true`，L793），展开为一个 `<skill name=... location=...>` XML 块 + 参数文本。
- 未知技能名原样透传；读取失败通过 extension runner 发错误事件。
- 展开后模型看到完整 SKILL.md 正文（不含 frontmatter），相对路径以 `skill.baseDir` 为基准。
- `docs/rpc.md` 同样注明："Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing"（L69）；`get_commands` 返回的 skill 命令名为 `skill:<name>`（L823）。
- 渐进式披露：系统提示里只放技能名+描述，模型不一定会主动 read SKILL.md；`/skill:` 强制加载。teach 技能额外设了 `disable-model-invocation: true`，**只有显式 `/skill:teach` 才能触发**（来源：`C:\Users\Hou_Xiangchen\.pi\agent\skills\teach\SKILL.md` frontmatter）。

### teach 技能的行为特征（来源：`~/.pi/agent/skills/teach/SKILL.md` 全文）

- `name: teach`，`disable-model-invocation: true`，`argument-hint: "What would you like to learn about?"`。
- **有状态技能**：把 `cwd` 当作"教学工作区"，在其中维护 `MISSION.md`、`RESOURCES.md`、`NOTES.md`、`reference/*.html`、`learning-records/000N-*.md`、`lessons/000N-*.html`、`assets/`。
- 调用形态：`/skill:teach <要学的主题>`；教学依赖跨会话状态（learning-records 决定"最近发展区"），因此**学习模块应给每个用户/课程一个独立 cwd 作为教学工作区，并复用同一会话（或 continueRecent）**。
- 技能依赖 `read`/`write`/`bash`（写 HTML、开浏览器）等工具，SDK 侧需保留相应工具；建议 `tools` 白名单覆盖 `read, write, edit, bash, ls, grep, find`。

集成方式（两种，来源：`docs/sdk.md` Skills + Directories）：

1. **简单**：保持默认 `agentDir`（用户机器上有 `~/.pi/agent/skills/teach`），直接 `session.prompt("/skill:teach " + topic)`。
2. **应用自包含**：用 `DefaultResourceLoader({ skillsOverride })` 把项目内自带的 teach SKILL.md 注入（`examples/sdk/04-skills.ts` 模式），不依赖用户全局目录。

---

## 4. 流式输出、中断、steer / followUp

### 事件流（来源：`docs/sdk.md` Events、`dist/core/agent-session.d.ts` L40-108）

`session.subscribe(listener)` 返回退订函数。事件类型（`AgentSessionEvent`）：

- **流式文本**：`message_update` → `assistantMessageEvent.type === "text_delta"`（`delta`）或 `"thinking_delta"`
- **工具执行**：`tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- **消息/回合/代理生命周期**：`message_start`/`message_end`、`turn_start`/`turn_end`、`agent_start`/`agent_end`（含 `messages`、`willRetry`）/`agent_settled`（真正全部结束，含 retry/compaction/队列）
- **会话级**：`queue_update`（steering/followUp 队列长度）、`compaction_start/end`、`auto_retry_*`、`entry_appended`、`session_info_changed`、`thinking_level_changed`

### 中断与排队（来源：`docs/sdk.md` Prompting and Message Queueing、RPC 文档 L57-76）

- 流式进行中调用 `prompt()` **必须**传 `streamingBehavior`，否则抛错：
  - `"steer"`：插队——当前 assistant turn 的工具调用执行完后、下一次 LLM 调用前投递（中断当前思路）
  - `"followUp"`：排队——等 agent 完全停止后投递
- 也可直接调 `session.steer(text)` / `session.followUp(text)`（两者都会展开技能/模板，但拒绝扩展命令）
- `session.abort()` 中止当前操作；`await session.agent.waitForIdle()` 等待完全空闲
- `preflightResult(success)` 回调：`prompt()` 被接受/排队时先调 `true`，被预检拒绝时 `false`；`prompt()` 本身在整轮跑完（含重试）后才 resolve
- `session.messages` / `session.agent.state` 可读当前消息与模型状态；`session.isStreaming` 判断是否在流式

模拟面试官模块可直接映射：用户语音转文本 → `prompt()`；打断提问 → `steer()`；"答完再补充" → `followUp()`；每帧 delta → UI 打字机渲染。

---

## 5. 多会话管理与持久化

### SessionManager（来源：`docs/sdk.md` Session Management、`docs/session-format.md`、`examples/sdk/11-sessions.ts`）

- `SessionManager.inMemory()` — 不持久化；`create(cwd[, customDir])` — 新建持久化会话；`continueRecent(cwd)` — 继续最近会话（无则新建）；`open(path)` — 打开指定文件
- 持久化位置：`<agentDir>/sessions/--<cwd路径--编码>--/<timestamp>_<uuid>.jsonl`（`docs/session-format.md` L8；可传 customDir 完全自定义，避开默认全局目录）
- 格式：JSONL、每行一个 entry、`id`/`parentId` 组成**树**（v2/v3，v1 自动迁移）；含消息、模型切换、thinking level、label、compaction、分支摘要、扩展自定义 entry（`pi.appendEntry`）
- 树 API：`getEntries()/getTree()/getPath()/getLeafEntry()/getEntry(id)/getChildren(id)`、`getLabel/setLabel`、`branch(entryId)`、`branchWithSummary(id, summary)`、`createBranchedSession(leafId)`
- 列举：`SessionManager.list(cwd)` / `listAll(cwd)` → `[{ id, firstMessage, path, ... }]`

### AgentSessionRuntime（会话替换，来源：`docs/sdk.md`、`examples/sdk/13-session-runtime.ts`）

- `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })`，factory 用 `createAgentSessionServices({ cwd })` + `createAgentSessionFromServices(...)` 组装
- 支持 `runtime.newSession()` / `switchSession(path)` / `fork(entryId, {position: "before"|"at"})` / `importFromJsonl()`；`runtime.session` 在替换后变化
- **重要**：事件订阅绑定在具体 AgentSession 上，替换后必须重新 `subscribe`，有扩展则重新 `bindExtensions()`（`examples/sdk/13-session-runtime.ts` 的 `bindSession()` 模式）
- 三个模块若各自只用固定单会话（简历优化每次新建、面试每次新建、学习持续复用），`createAgentSession` 单层即可；若产品需要"会话列表/切换/分支"，再上 runtime 层

---

## 6. Electron 主进程运行要求

来源：`package.json`（v0.84.1）、`docs/sdk.md`、`docs/extensions.md`、`docs/skills.md`、`docs/packages.md`。

### Node 版本

- `engines: { "node": ">=22.19.0" }`（package.json）。**无运行时强制检查**（dist 中无 process.versions 校验），但这是官方支持基线。
- 包为纯 ESM（`"type": "module"`）。Electron 主进程自 Electron 28 起支持 ESM；需确认目标 Electron 内置 Node ≥ 22.19（Electron 37+ 内置 Node 22.x，但 22.19 是较新的补丁号，**集成时务必用 `process.versions.node` 实测目标 Electron 版本**，必要时随 Electron 升级或换用 RPC 子进程方案兜底）。
- 备选方案：SDK 代码也可跑在 Electron 的 utilityProcess 或独立 Node 子进程里，通过 IPC 与主进程通信（RPC 模式即此形态）。

### 原生依赖（重要打包结论）

- `dependencies` 中唯一原生包是 `@silvia-odwyer/photon-node`（Rust 原生模块，图片处理）。
- 它**只在** `dist/utils/photon.js` 中被**惰性加载**（`await loadPhoton()`），调用方仅 `dist/utils/clipboard-image.js`（TUI 粘贴剪贴板图片用）——**不在 SDK 核心路径上**（`dist/core/*` 无引用）。
- `@mariozechner/clipboard` 是 `optionalDependencies`。
- **结论**：`createAgentSession` 核心路径（模型调用、skills、事件、会话）无原生依赖加载 → asar 打包、electron-builder 无额外 rebuild 负担；只需注意不要从 SDK 里引入 TUI 剪贴板图片工具链，或对 photon 做 external 处理。

### 其他运行注意点

- **扩展通过 jiti 加载 TS**（`docs/extensions.md`）：`~/.pi/agent/extensions/*.ts` / `.pi/extensions/*.ts` 自动发现；扩展可声明 `package.json` 依赖、可 `pi.registerTool/registerCommand/registerProvider`。扩展代码有完整系统权限（安全提示：只加载可信来源，`docs/extensions.md` Extension Locations 安全警告）。
- **扩展工厂里不要启动后台资源**（进程/定时器/文件监听），等 `session_start` 再起、`session_shutdown` 里关（`docs/extensions.md` Long-lived resources and shutdown）。
- **cwd 敏感**：工具（bash/read/write 等）绑定会话的 cwd；会话按 cwd 命名/归类。每个业务模块应显式传自己的 `cwd`（如学习工作区目录）。
- 设置项：`SettingsManager.create(cwd, agentDir)` 读 `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json` 合并；`inMemory()` 免 IO。`enableSkillCommands` 设置控制 `/skill:` 命令是否注册（`docs/skills.md` Skill Commands）。
- 生命周期：用完 `session.dispose()`；`session_shutdown` 事件给扩展做清理（`docs/extensions.md`）。
- 会话替换/重启后 `withSession` 等回调必须只用新 ctx，旧捕获对象已失效（`docs/extensions.md` Session replacement lifecycle and footguns）——对应用内"多会话页签"设计有参考价值。

### 与 RPC 子进程方案的取舍（来源：`docs/sdk.md` RPC Mode Alternative）

| 维度 | SDK（同进程） | RPC（`pi --mode rpc` 子进程） |
|---|---|---|
| 类型安全/状态直读 | ✅ `session.agent.state` 等 | 需 JSON 协议（`docs/rpc.md`） |
| 进程隔离/崩溃隔离 | ❌ | ✅ |
| Node 版本隔离（可绕开 Electron 内置 Node 老版本） | ❌ | ✅（子进程可用独立 Node ≥22.19） |
| 依赖分发 | 随应用打包 | 需随应用分发 pi CLI |
| 适用 | Electron 主进程内嵌、自定义工具/扩展 | 跨语言、隔离、不想维护 SDK 依赖 |

---

## 7. 对三个产品模块的集成映射（建议）

| 模块 | 建议形态 | 关键 API |
|---|---|---|
| 简历优化（基准简历+JD→优化稿） | 每次任务一个 `createAgentSession`，`SessionManager.inMemory()` 或 `create(cwd, appSessionDir)`；`cwd` 指向任务工作目录；prompt 注入简历+JD；完成后读 `session.agent.state.messages` 取最终稿 | `createAgentSession`、`ModelRuntime`、`prompt`、`text_delta` 订阅 |
| 模拟面试官（语音转文本→问答） | 单会话长驻；UI 打字机消费 `message_update`；用户打断→`steer()`；追问→`followUp()`；可用 `noTools`/`tools: ["read"]` 收紧 | `steer`/`followUp`、`abort`、`queue_update`、`isStreaming` |
| 学习（teach 技能驱动） | `cwd` = 教学工作区目录；`session.prompt("/skill:teach " + topic)`；会话用 `continueRecent(cwd)` 跨会话续接；保留 `read/write/edit/bash` 工具；teach 有 `disable-model-invocation: true`，必须显式 `/skill:` 调用 | `/skill:` 展开（`expandPromptTemplates` 默认开）、skillsOverride 注入、`entry_appended` |

共性要点：认证用 `ModelRuntime.create({ authPath, modelsPath })` 指到应用自有目录；`DefaultResourceLoader` 可全自定义（`examples/sdk/12-full-control.ts` 是最佳参照）；`agentDir`/`cwd`/`sessionManager` 三个参数决定"资源发现 + 会话落盘"的隔离边界。

---

## 8. 风险与注意点清单

1. **Node ≥ 22.19 + ESM**：Electron 内置 Node 版本需实测；不满足则退到 RPC 子进程（独立 Node）方案。
2. **teach 技能依赖用户全局技能目录**：若 `agentDir` 自定义或打包发布，需用 `skillsOverride` 自带 teach 技能（SKILL.md + 相对资源）。
3. **技能是提示词不是代码**：模型不保证主动读 SKILL.md，`/skill:` 是可靠触发方式；`disable-model-invocation` 的技能只能显式触发。
4. **认证失败在 `prompt()` 前抛错**：需先 `modelRuntime.checkAuth(provider)` 或捕获 preflight 异常做引导 UI。
5. **会话替换后需重订阅**（若用 runtime 层）。
6. **扩展/技能有完整权限**：随应用分发的扩展要自己审计；`project_trust` 机制只影响项目级 `.pi/` 资源。
7. **photon-node 原生模块**：不在核心路径，但打包时建议 external 掉 TUI 剪贴板工具链，避免误带原生二进制。

---

## 来源索引（一手资料）

- `D:\npm-global\node_modules\@earendil-works\pi-coding-agent\docs\sdk.md` — SDK 全量 API（createAgentSession/AgentSession/AgentSessionRuntime/ModelRuntime/SessionManager/SettingsManager/ResourceLoader/run 模式/RPC 取舍）
- `...\docs\extensions.md` — 扩展 API、事件、生命周期、jiti 加载、安全、会话替换 footguns
- `...\docs\skills.md` — 技能位置/结构/frontmatter/`/skill:` 命令/渐进式披露
- `...\docs\sessions.md`、`...\docs\session-format.md` — 会话存储、JSONL 树格式、SessionManager 树 API
- `...\docs\rpc.md` — RPC 协议、`/skill:` 展开语义（L69）、get_commands
- `...\docs\packages.md` — pi 包（npm/git）分发 skills/extensions 的机制
- `...\examples\sdk\01-minimal.ts`、`02-custom-model.ts`、`04-skills.ts`、`11-sessions.ts`、`12-full-control.ts`、`13-session-runtime.ts`、`README.md` — 可直接照抄的代码范式
- `...\package.json` — `engines.node >=22.19.0`、`"type": "module"`、依赖清单（photon-node 原生包）
- `...\dist\core\agent-session.js`（L793/824/949-985）— `/skill:` 展开与 preflight 源码实证
- `...\dist\utils\photon.js`、`dist\utils\clipboard-image.js` — 原生模块惰性加载实证
- `C:\Users\Hou_Xiangchen\.pi\agent\skills\teach\SKILL.md` — teach 技能行为（状态文件、disable-model-invocation）
- Ticket: https://github.com/hxc236/jobhunt-ai-helper/issues/2
