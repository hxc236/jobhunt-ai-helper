# Agent 爬虫调研（科普向）· Kimicode 查证 · BOSS 场景结论

> 调研时间：2026-08-13。本文写给产品 owner 本人读（技术能看懂但不深），科普优先。
> 关联：boss-zhipin-crawlability.md（2026-08-13，BrowserWindow 实测）、computer-use-sources.md（2026-08-12，OpenAI Computer Use）。
> 方法：一手来源优先（官方文档 / 官方 GitHub / 官网，均可直接访问，本次网络环境未出现上次调研的 403）；BOSS 探测仅 2 次 BrowserWindow 导航 + 页面内 fetch（脚本 `.checkpoint/boss-probe7-copypaste.cjs`、`.checkpoint/boss-probe8-spa-click.cjs`，证据在 `.checkpoint/boss-probe{7,8}-result.json`）。
> 与上次调研的差异：OpenAI/Anthropic 官方文档正文本次已直接抓取（上次 403），机制描述与上次结论一致，无冲突。

---

## 0. 一句话版本（先看这个）

**Agent 爬虫 = 让 AI 当"眼睛和大脑"，真实浏览器当"手"，像人一样看着网页、决定点哪里、然后把数据读出来。**

- **传统爬虫**：程序直接向网站服务器发请求要数据（接口/HTML），按固定规则解析。像"给商家传真一份货单要库存表"——**快、便宜、能批量**，但商家一看你不是正常客户就拒收（风控），而且货单格式一改（页面改版）你的解析就全废。
- **Agent 爬虫**：AI 模型观察页面（看截图或读页面结构）→ 决定动作（点哪里、输入什么）→ 真实浏览器执行 → 再看结果 → 循环，直到任务完成。像**雇了个会看网页的实习生帮你操作**——页面怎么改它都能看懂，但每步都要"看一眼想一下"，**慢、贵、每跑一次花一次模型钱**。

一句话本质区别：**传统爬虫是"构造请求拿数据"，Agent 爬虫是"操作浏览器读内容"。**

对 BOSS 场景的预告结论（详见第 4 节）：
1. **JD 复制保护不构成障碍**——今天实测 BOSS PC 网页 JD 详情**根本没有 CSS/JS 复制保护**，而且 JD 全文本来就在接口 JSON 里（三次实测 code:0）；
2. **Agent 方案解决不了你真正的短板**（匿名会话薪资为空）——页面/接口里没有的字段，任何"看屏幕"的方案都拿不到；要先解决登录态；
3. **现有 BrowserWindow 方案仍是主力**；Agent 方案只适合当"登录态 + 人工确认"的低频兜底。

---

## 1. Agent 爬虫是什么（给非技术读者）

### 1.1 通用工作机制：一个循环

```
任务（如"打开 BOSS 搜'前端'岗位，读出 JD"）
   ↓
① 模型观察页面：看截图（视觉方案）或读页面结构 DOM/无障碍树（DOM 方案）
   ↓
② 模型输出动作：点击（像素坐标）／点击（元素编号 ref）／输入文字／滚动
   ↓
③ 调用方（你自己的程序）在真实浏览器里执行这些动作
   ↓
④ 把执行后的新页面状态回传给模型
   ↓
重复 ①②③④，直到模型认为任务完成
```

要点：**模型不碰浏览器，浏览器里也没有模型**——中间靠 API 调用循环连接（OpenAI 官方文档原话："inspect screenshots, return interface actions for your code to execute" [1]；官方 TS 参考实现 openai-cua-sample-app 的 `responses-loop.ts` [2]）。

### 1.2 为什么现在才流行

- **传统爬虫的三大死穴**：① 现代网站大量是 SPA 壳页（HTML 是空的，数据全在 JavaScript 加载后的接口里，见 [boss-zhipin-crawlability.md](boss-zhipin-crawlability.md) 对 BOSS 9.2KB 壳页的实测）；② 服务端风控（浏览器指纹、行为检测，curl 直连 BOSS 接口 100% 返回 code:37 环境异常）；③ 验证码与登录墙。
- **LLM 的突破**：2024 年起模型能"看懂"截图和页面结构，可以自主规划操作。标志性节点：Anthropic 2024-10 发布 Computer Use（首个商用"模型操作电脑"）[3]、OpenAI 2025 年推出 Operator 与 Computer Use API [1]、browser-use 等开源框架兴起 [4]。
- **2025-2026 的形态演进**：从"看截图点坐标"走向"读 DOM 结构操作元素"——更快、更稳、更便宜。Anthropic 官方明确推荐 Playwright DOM 工具而非纯坐标 [5]。

### 1.3 与"脚本自动化"（老式 RPA）的区别

老式 RPA（按键精灵、UiPath）也是"操作浏览器"，但规则是**人预先写死的**（"点击坐标 (100,200)"），页面一改就失效。Agent 爬虫的规则是**模型每次实时生成的**（"看到搜索框就输入关键词，看到结果列表就逐条打开"）——本质是"意图驱动"而非"脚本驱动"。代价是每次运行都要花模型推理的钱和时间。

---

## 2. 技术方案全景

### 2.1 全景表

| 方案 | 原理（一句话） | 成本 | 速度 | 稳定性 | 反爬表现 |
|---|---|---|---|---|---|
| **视觉方案**（OpenAI Computer Use / Anthropic Computer Use） | 模型看截图，输出像素坐标动作，你的程序在真实浏览器执行并回传新截图 | 高：单次任务约 $0.1~0.3（10~15 轮推理，截图逐轮累积 token；重试可到 $1 量级）[6][7] | 慢：单轮 10s+，单任务 1~3 分钟 [6] | 中：坐标随窗口尺寸/布局变化失效（Anthropic 官方原话 "pixel coordinates break when windows resize"）[5] | 真实浏览器可过指纹校验；但官方演示确认 Google 搜索会触发 CAPTCHA [5]；滑块验证码轨迹检测易翻车 |
| **DOM / 无障碍树方案**（Playwright MCP；Anthropic 推荐的 Playwright 浏览器工具） | 模型直接读页面结构（DOM/无障碍树）与元素编号（ref），用 ref 定位元素而非坐标 [5][8] | 低：无需视觉模型，几乎无截图 token [8] | 快：结构数据远小于截图 | 高：ref 定位跨窗口尺寸稳定 [5]；确定性工具调用 [8] | 同真实浏览器；对纯 canvas/特殊渲染页面弱（无 DOM 可读） |
| **开源框架**（browser-use [4]、Crawlee [9]、UI-TARS [10]） | browser-use：Python 开源，LLM 无关，DOM 优先的 agent 循环，云版带代理+验证码解决 [4]；Crawlee：爬虫框架，无头浏览器抓取，**不依赖 LLM**（传统爬虫的现代工程化）[9]；UI-TARS：字节开源 GUI agent 模型 [10] | 模型费同量级（browser-use）；Crawlee ≈ 0（框架免费，无 LLM） | 取决于所选通道 | browser-use 自评榜单 87.4% 领先（第三方自评，需甄别）[6] | 与所选浏览器通道一致 |
| **国内产品**（Kimi WebBridge [11]、Kimi Claw [12]、Manus [13]、豆包 [14]） | 见 2.2 与第 3 节 | 多为会员/订阅制 | 中 | 中 | Kimi WebBridge 直接复用用户真实登录态，风控表现接近真人（见第 3 节） |

### 2.2 国内产品（能查到的）

- **Kimi WebBridge**（月之暗面，2026-05 发布）：浏览器扩展 + 本地桥接服务，基于 Chrome DevTools Protocol 直接驱动用户正在使用的 Chrome/Edge，**继承用户真实登录态**。官方场景明确包含"提取信息""跨站点内容整合"。详见第 3 节 [11]。
- **Kimi Claw**：月之暗面云端 7×24 智能体服务（OpenClaw 云端版，40G 空间，Kimi 模型驱动），无需本地部署 [12]。
- **Manus**：通用 AI agent，官网产品线含 "Manus browser operator"（浏览器操作器）与桌面版 [13]。形态为"云端任务 + 浏览器操作"。
- **豆包**：字节跳动，浏览器插件形态（AI 问答/总结/翻译/智能搜索，2025 年发布）[14]；另有"豆包大模型可自主操作浏览器订酒店"的报道 [15]，以及开源 GUI agent 模型 UI-TARS [10]。

### 2.3 对反爬的意义：能过什么，又触发什么

**Agent 爬虫能过传统爬虫过不了的：**
1. **浏览器指纹**——用真实浏览器（Electron/Chrome/Playwright），不再是无指纹的 curl。BOSS 实测：curl 直连接口必返 code:37，真实浏览器页面内 fetch 即 code:0（[boss-zhipin-crawlability.md](boss-zhipin-crawlability.md)）。
2. **SPA 壳页**——JS 渲染完成后读 DOM，而不是读 9KB 空壳 HTML。
3. **登录态**——继承真实用户会话（WebBridge 直接复用用户已登录的浏览器 [11]），或用户手动登录一次后持久化 cookie。
4. **部分验证码**——模型"看到"滑块尝试拖拽，成功率不稳定，失败仍需人工 [6]。

**但它会触发新的：**
1. **滑块验证码与轨迹检测**——机器的拖拽轨迹被识别拒绝（Anthropic 官方演示都躲不开 Google 的 CAPTCHA）[5]。
2. **账号风控**——高频操作 = 封号风险；BOSS 的 API 层风控会随会话/IP 累积渐进升级（code:37 → 200404，[boss-zhipin-crawlability.md](boss-zhipin-crawlability.md)）。
3. **robots/合规**——**技术形态不豁免合规**：robots.txt 禁爬的站，用"像真人的 agent"去爬，违反的是站方条款，与"怎么爬"无关（见第 5 节）。

**关键洞察**：Agent 爬虫解决的是"**能不能拿到**"的技术问题，不解决"**该不该拿**"的合规问题；而且它把成本从"一次性开发成本"转移为"**每次运行的 API 成本**"——频率越高越贵，恰好与风控（频率越高越危险）形成双重约束。

---

## 3. "Kimicode" 查证结果

### 3.1 结论：没有叫 "Kimicode" 的产品，你说的是 **Kimi Code**

判断依据（一手来源）：
- 官方产品页标题即 "Kimi Code - 搭载 Kimi K3 的 AI 编程 Agent 与 CLI 工具" [16]，月之暗面官网产品线里没有 "Kimicode"。
- GitHub 搜索 "kimicode" 返回的仓库全部是 **Kimi Code 的社区生态**（KimiCodeBar 用量监控、KimiCodeWebApp 等第三方工具），无官方产品 [17]。
- 官方 GitHub 仓库两个：`MoonshotAI/kimi-cli`（Python，11k+ star，2025-10 创建）→ 正演进为 `MoonshotAI/kimi-code`（TypeScript，6.4k star，2026-05 创建，"The Starting Point for Next-Gen Agents"）[18]。
- **"Kimicode" 就是社区对 "Kimi Code" 的连写**（用户大概率听到的是口头说法）。

### 3.2 它"有爬虫功能"的说法从哪来：两个层面

**层面一：Kimi Code 内置网页工具（web-search + fetch-url）**
官方 kimi-cli README 原话："It can read and edit code, execute shell commands, **search and fetch web pages**, and autonomously plan and adjust actions during execution" [19]。源码细节（`MoonshotAI/kimi-code`）[20]：
- **web-search 工具**：走 Moonshot 云端搜索，需账号认证（源码 `packages/agent-core-v2/src/agent/tools/web-search/`）[21]；
- **fetch-url 工具**：**优先走云端**（POST URL 到 Moonshot 服务端，返回 Markdown 提取结果，请求头 `Accept: text/markdown`）；**本地 fallback 是纯 HTTP GET + Chrome UA + Readability 提取正文——不执行 JavaScript**，源码注释明说 "The page may require JavaScript to render"（对 BOSS 这种 SPA 壳页，本地抓取会失败）[22][23]。

**层面二（重点）：Kimi WebBridge 浏览器插件——这才是真正的"Agent 爬虫"能力**
2026-05 发布，官方页面 [11]（https://www.kimi.com/zh-cn/features/webbridge）：
- 定位："专为 AI Agent 设计的浏览器插件，让 AI 帮你打开网页、点击按钮、填写表单、**提取信息**，为你自动化各种繁琐的网页操作"。
- **技术方案**：本地桥接服务 + 浏览器扩展双组件，基于 **Chrome DevTools Protocol (CDP)** 在**用户正在使用的真实 Chrome/Edge** 里执行导航、点击、截图、读取页面；所有执行在本地完成，**登录态和网页内容不出设备**。
- **关键卖点：继承用户真实登录态和 Cookie**——"AI 在操作目标网站时，等同于用户本人在操作，无需额外配置账号、处理验证码或突破登录壁垒"（第三方整理 [24]；官方 FAQ 确认"登录态……不会离开你的设备" [11]）。
- 生态：配套 Kimi Code / Claude Code / Cursor / Codex 等本地 agent；在 Kimi 桌面端 Kimi Work 模式内直接可用；固定流程可编译为专用 CLI 工具（不耗模型 token）[11][24]。
- 官方页面列出的场景："自动调研成文、智能填写信息、量化策略回测" [11]；第三方整理补充了"**自动采集**多个笔记类 APP 的应用商店宣传素材……"与"跨站点内容整合"等示例 [24]——这就是用户听说的"爬虫功能"。

**相关 Kimi 系产品（防混淆）**：
- **Kimi 浏览器插件**（2024-07，月之暗面）：框选搜索、全文总结——**只读不改**，非浏览器自动化 [25]；
- **Kimi Claw**：云端 7×24 智能体（OpenClaw 云端版），用于部署常驻 agent [12]；
- **Kimi K3**：Kimi Code 搭载的模型 [16]。

### 3.3 技术定位小结

Kimi Code 的网页能力 = "**云端/本地单页文本提取 + 搜索**"为主（轻量、快、对 SPA 无力）；Kimi WebBridge = "**CDP 直控真实浏览器 + 登录态继承 + 完整操作**"（重、但正是 Computer Use 想解决的问题，且更便宜——没有截图 token，走协议级操作）。与 OpenAI/Anthropic 的视觉方案相比，WebBridge 的形态更接近"Playwright DOM 方案 + 真实用户会话"的结合体，对"登录态才有完整数据"的站点（如 BOSS 薪资、国聘列表）是更有吸引力的形态。局限：必须用户本机浏览器在线、操作发生在用户眼皮底下（不适合无人值守批量）、受扩展安装与浏览器版本制约。

---

## 4. 对 BOSS 场景的取舍与建议

### 4.1 复制保护：实测结论——不构成障碍

**今日实测**（2026-08-13，脚本 `.checkpoint/boss-probe7-copypaste.cjs` / `boss-probe8-spa-click.cjs`，共 2 次 BrowserWindow 导航 + 页面内 fetch）：

| 探测项 | 结果 |
|---|---|
| 列表页职位卡 user-select | `auto`（可选中，无复制保护） |
| 详情弹层（`.job-detail-box`）user-select | `auto`（**无 user-select:none**） |
| 详情弹层 copy 事件 | `copyPrevented: false`（**无 JS 拦截复制**） |
| 文本可选中性 | selectionLen=211 > 0（文本可正常选中） |
| 详情接口 JD 全文 | `code:0`，`jobInfo.postDescription` 完整可得（probe5/6/7 三次复现） |

**结论**：用户遇到的"页面无法复制"在本机 PC 网页版详情弹层上**未复现**（可能来自右键菜单禁用、剪贴板清理等未测形态，或 App 端）。即使真有复制保护，对采集也不构成障碍，因为：
1. `user-select:none` 只是 CSS，只影响"鼠标选择"动作；`el.innerText` / `el.textContent` 读取**不经过选择与剪贴板**，永远可读；
2. copy 事件拦截只影响剪贴板写入，不影响 DOM 读取；
3. JD 全文本来就在接口 JSON 里（`jobInfo.postDescription`，[boss-zhipin-crawlability.md](boss-zhipin-crawlability.md) 实测 49 字段 + 详情全文）。
**复制保护是"防君子不防小人"的 UX 层措施，对任何能执行 JS 的客户端（Electron/Playwright/Agent）都不构成障碍。** 真正挡爬虫的是接口风控（code:37/200404）与验证码——这恰恰是 Agent 方案也解决不了的部分。

### 4.2 四要素取舍：Agent 方案 vs 现有 BrowserWindow 方案

| 要素 | BrowserWindow 现有方案（实测） | Agent 视觉方案（Computer Use） | Agent DOM/CDP 方案（Playwright / WebBridge 形态） |
|---|---|---|---|
| **登录态** | 需用户扫码/手动登录一次（两方案同此前提）；匿名会话已可用（列表+详情+JD 全文） | 同左 | **WebBridge 直接继承用户已登录会话**，最省事；但绑定用户桌面浏览器，不可无人值守 |
| **薪资** | ⚠️ 匿名会话 `salaryDesc:""`（[boss-zhipin-crawlability.md](boss-zhipin-crawlability.md) 实测） | **解决不了**：页面不渲染薪资，视觉模型"看到"的也是空；接口不返回，读 DOM 也是空——**任何方案都拿不到页面里没有的字段** | 同左。**唯一路径是登录态实测薪资是否恢复**，与方案选择无关 |
| **JD 全文** | ✅ 接口 code:0 实测可得，免费、秒级 | 可得但慢（1~3 分钟/条）、贵（$0.1~0.3/条）[6][7] | 可得；Playwright DOM 免费；WebBridge 耗用户 Kimi 额度 |
| **频率风控** | ⚠️ 30-60s 冷却 + 每窗口单导航 + API 渐进风控（37→200404），冷却后恢复 | 天然慢 = 天然低频，风控暴露小；但成本线性增长 | Playwright DOM 与 BrowserWindow 同类同风险；WebBridge 接近真人行为，但高频仍有封号风险 |
| **成本** | ≈ 0 | $0.1~0.3/次 + 重试 | Playwright ≈ 0；WebBridge 走用户会员 |

### 4.3 建议

1. **主力不变**：继续用现有 BrowserWindow 机制做低频采集，遵守已实测的频率纪律（30-60s 冷却、每窗口单导航、数据提取 DOM 优先、接口 fetch 放在页面加载早期）——免费、实测通过（[boss-zhipin-crawlability.md](boss-zhipin-crawlability.md)）。
2. **下一步唯一值得做的实验是登录态**：让用户扫码登录一次，复测 `salaryDesc` 是否恢复——这决定"薪资字段"能不能做，**与 Agent 方案无关**，任何方案都绕不开。
3. **Agent 方案定位为兜底**（与 computer-use-sources.md 结论一致）：不做视觉 Computer Use 主力采集（贵、慢、验证码翻车）；若二期要做"登录态人工辅助查询"，优先评估 **Kimi WebBridge 形态（CDP 直控 + 登录态继承）或 Playwright DOM**，而非截图+坐标——它们更快更便宜，且 WebBridge 的登录态继承对 BOSS 这类"登录才有完整数据"的站是真实优势。
4. **不引入**：任何绕过验证码/风控的对抗手段（合规与封号风险，见第 5 节）。

---

## 5. 合规提示（如实告知）

- **robots.txt 明确禁爬**：BOSS 直聘对搜索页、职位列表、JD 详情全部 Disallow（`/*?query=*`、`/job_detail/l*.html`、`*?position=*`、`*?city=*` 等）https://www.zhipin.com/robots.txt —— 这是站方对自动化访问的明确表态。
- **用户协议**：https://about.zhipin.com/agreement （SPA 正文未直接抓取，上线前请人工确认其中关于自动化访问、数据使用与账号使用的条款）。
- **登录态采集**：用自己账号登录后自动化采集，违反账号协议的可能性高；高频操作有封号风险（BOSS API 层风控已实测渐进升级，[boss-zhipin-crawlability.md](boss-zhipin-crawlability.md)）。
- **Agent 方案不豁免合规**：WebBridge"像真人操作"解决的是技术可达性，不改变"自动化访问"的性质；robots/条款约束的是行为本身而非技术形态。
- **数据合规**：BOSS 职位数据含 BOSS（招聘者）个人信息与公司信息，批量收集、存储、再分发可能触及《网络安全法》《数据安全法》《个人信息保护法》。
- **建议的产品姿态**（与现有采集预览交互一致）：用户主动触发、低频、结果人工确认，应用内告知用户其行为受目标站条款约束。

---

## 来源清单

| # | 来源 | URL |
|---|---|---|
| [1] | OpenAI 官方文档 Computer use（gpt-5.4，截图→动作→执行循环） | https://platform.openai.com/docs/guides/tools-computer-use |
| [2] | openai-cua-sample-app（官方 TS 参考实现，responses-loop.ts） | https://github.com/openai/openai-cua-sample-app |
| [3] | Anthropic 官方文档 Computer use tool | https://docs.anthropic.com/en/docs/build-with-claude/computer-use |
| [4] | browser-use（开源，AI 浏览器 agent 框架） | https://github.com/browser-use/browser-use ；https://docs.browser-use.com |
| [5] | Anthropic 官方 quickstart browser-use-demo（ref vs 坐标、CAPTCHA 提示） | https://github.com/anthropics/anthropic-quickstarts/blob/main/browser-use-demo/README.md |
| [6] | 本仓库 computer-use-sources.md（成本模型/速度/稳定性，2026-08-12） | docs/research/computer-use-sources.md |
| [7] | LiteLLM 模型价格镜像（第三方交叉核对） | https://github.com/BerriAI/litellm |
| [8] | Playwright MCP（无障碍树，无视觉模型） | https://github.com/microsoft/playwright-mcp |
| [9] | Crawlee（开源爬虫框架） | https://crawlee.dev |
| [10] | UI-TARS（字节开源 GUI agent 模型） | https://github.com/bytedance/UI-TARS |
| [11] | Kimi WebBridge 官方页（CDP、登录态、本地执行） | https://www.kimi.com/zh-cn/features/webbridge |
| [12] | Kimi Claw（云端 7×24 智能体；第三方报道） | https://blog.csdn.net/ 搜索 "Kimi Claw"；https://www.datalearner.com/ 搜索 "Kimi Claw"（两者为当日 360 搜索可见报道，非官方，需复核） |
| [13] | Manus 官网（含 "Manus browser operator" 产品线） | https://www.manus.im |
| [14] | 豆包浏览器插件（AI 工具集收录，2025 年发布） | https://ai-bot.cn/doubao-browser-extension/ |
| [15] | 财新：豆包大模型可自主操作浏览器 | https://www.caixin.com/ 搜索"豆包 浏览器"（当日 360 搜索可见标题，正文未抓取） |
| [16] | Kimi Code 官方产品页 | https://www.kimi.com/code/ |
| [17] | GitHub 搜索 "kimicode" 结果（均为社区生态仓库） | https://github.com/search?q=kimicode&type=repositories |
| [18] | MoonshotAI 官方仓库 kimi-cli / kimi-code | https://github.com/MoonshotAI/kimi-cli ；https://github.com/MoonshotAI/kimi-code |
| [19] | kimi-cli README（"search and fetch web pages"） | https://github.com/MoonshotAI/kimi-cli |
| [20] | kimi-code 仓库源码 | https://github.com/MoonshotAI/kimi-code |
| [21] | kimi-code web-search 工具源码 | https://github.com/MoonshotAI/kimi-code/tree/main/packages/agent-core-v2/src/agent/tools/web-search |
| [22] | kimi-code 云端抓取 provider（moonshot-fetch-url.ts，Accept: text/markdown） | https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/app/web/providers/moonshot-fetch-url.ts |
| [23] | kimi-code 本地抓取 provider（local-fetch-url.ts，无 JS 执行） | https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts |
| [24] | Kimi WebBridge 技术细节整理（AI 工具集，2026-05） | https://ai-bot.cn/kimi-webbridge/ |
| [25] | Kimi 浏览器插件（2024-07 报道） | https://www.ithome.com/ 搜索"Kimi 浏览器插件"（当日 360 搜索可见标题） |
| — | BOSS 实测（两次调研） | docs/research/boss-zhipin-crawlability.md ；docs/research/computer-use-sources.md |

**备注**：
- 标"第三方整理/报道需复核"的来源（[12][14][15][25]）用于科普背景，核心结论均基于官方一手来源（[1]-[11][16]-[23]）。
- BOSS 探测请求量：今日新增 2 次 BrowserWindow 导航 + 若干页面内 fetch（另有 3 次导航尝试被服务端安全校验 abort，未产生数据请求），远低于上次调研（约 20 次显式请求）；未绕过登录/验证码，未修改 src/，未写采集实现。
