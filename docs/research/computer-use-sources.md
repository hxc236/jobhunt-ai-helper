# OpenAI Computer Use 查招聘源（BOSS 直聘 / 国聘）可行性调研

> 调研时间：2026-08-12。背景：产品为本地桌面应用（Node/TS + Electron），二期方案，不阻塞 MVP（MVP 试点牛客+猎聘普通爬虫，见 [校招信息源调研#4](https://github.com/hxc236/jobhunt-ai-helper/issues/4)）。
> 关联 ticket：[jobhunt-ai-helper#11](https://github.com/hxc236/jobhunt-ai-helper/issues/11)。
> 方法说明：本调研网络环境对 `platform.openai.com` / `docs.anthropic.com` / `claude.com` 返回 403 或超时，官方文档正文无法直接抓取。以下结论优先基于**可访问的官方一手来源**：OpenAI 官方仓库（openai-cua-sample-app、openai-node SDK、openai-cookbook）、Anthropic 官方仓库（anthropic-quickstarts）、Microsoft 官方仓库（playwright-mcp）、status.openai.com，以及对两个目标站的当日实测（curl / Chrome UA）。价格数字为 LiteLLM 维护的模型价格镜像（第三方交叉核对），**上线前需在可访问官方价格页的网络复核**。

## 结论速览

| 维度 | 结论 |
|---|---|
| 能力边界 | Computer Use = 视觉模型看截图 + 输出鼠标/键盘动作，由调用方在真实浏览器里执行并回传新截图；API 形态为 Responses API 的 `computer`（新）/ `computer_use_preview`（旧）工具；模型当前为 GPT-5.x 系列（官方 TS 示例默认 `gpt-5.4`），旧预览模型为 `computer-use-preview` |
| BOSS 直聘 | ⚠️ 不乐观：robots.txt 明确禁爬搜索/职位页；全部职位页（含校招频道）为 9KB 反爬壳页（`browser-check-v2.js` 指纹校验）；站点内置 geetest 验证码与"后羿采集器"等爬虫工具识别；JD 详情返回"请稍候"拦截页。Computer Use 用真实 Chrome 可过指纹校验，但搜索/翻页/登录大概率触发滑块验证码，需人工介入 |
| 国聘 | ⚠️ 数据 API 登录墙：网页端 SPA，职位列表/详情 API（`gp-api.iguopin.com`）未登录直接 403（"账号类型错误或权限不足"）；登录支持手机号/微信扫码；引入阿里云滑块验证码。robots.txt 允许访问。登录态下 Computer Use 可翻页+读 JD，但"登录+验证码"环节仍需人工或半自动 |
| 成本 | 单次"查某公司校招职位"约 10~15 轮（turn），输入 ~4~10 万 token、输出 ~3~6 千 token；用 gpt-5.4（$2.5/$15 每 M）约 **$0.1~0.3/次**；旧 computer-use-preview（$3/$12）约 $0.15~0.35/次；含重试 ~0.5~1 美元量级 |
| 速度/稳定性 | 单轮 API 延迟秒级~10s+，单任务 1~3 分钟；失败重试会显著拉高耗时与成本；status.openai.com 近两周无重大故障（多为已解决的 minor 事件） |
| 集成 | 官方 TS 示例（openai-cua-sample-app）就是"Node/TS + Playwright 驱动 + Responses API 循环"，可直接照搬进 Electron 子进程；开源兜底：browser-use（Python，云代理+验证码解决）、Playwright MCP（无障碍树驱动，不需要视觉模型，Token 更省） |
| 对比 | Anthropic：官方推荐 Playwright DOM 工具（ref 定位）而非纯坐标截图，成本与 OpenAI 同级（sonnet $3/$15）；browser-use：自称 Odysseys 榜 87.4% 领先 OpenAI/Anthropic 官方案（第三方自评，需甄别） |
| 合规 | BOSS 直聘 robots.txt 明确 Disallow 搜索/职位页（`/*?query=*`、`/job_detail/l*.html` 等），自动化访问有条款风险；国聘 robots 放行但需登录态。建议二期仅做登录态下的低频人工辅助查询，不批量抓取 |

**总体判断**：技术上行得通（官方有现成 TS 参考实现），但**对这两个源价值有限**——BOSS 直聘反爬强、国聘数据需登录，Computer Use 的视觉点击并不比"Playwright + 登录态 + 直接读 DOM"更可靠或更便宜，反而更慢更贵。二期建议定位为"登录态、低频、人工确认"的兜底通道，而不是主力采集手段；主力仍是普通爬虫 + 结构化解析。

## 一、OpenAI Computer Use 能力边界

### 1.1 工作机制（视觉模型操作浏览器）

机制是"**模型看截图 → 输出动作 → 调用方执行 → 回传新截图**"的循环，模型本身不碰浏览器：

1. 调用方（你的代码）启动真实浏览器（Playwright/Chrome），截图页面
2. 把截图（base64 PNG）连同任务指令发给 Responses API，声明 `tools: [{ type: "computer" }]`
3. 模型返回 `computer_call` 输出项，内含动作批（`actions[]`）：`click`、`double_click`、`drag`、`keypress`、`move`、`scroll`、`type`、`wait`、`screenshot`（带坐标/按键参数）
4. 调用方在浏览器里逐条执行动作，再把执行后的新截图作为 `computer_call_output`（`type: "computer_screenshot"`）回传，循环至模型给出最终答复

来源：OpenAI 官方 TS 示例 openai/openai-cua-sample-app（`packages/runner-core/src/responses-loop.ts`，含上述完整循环实现与 `pending_safety_checks` 处理）https://github.com/openai/openai-cua-sample-app ；动作类型与参数定义见官方 SDK openai/openai-node `src/resources/responses/responses.ts`（`ComputerAction` 联合类型）https://github.com/openai/openai-node

要点：

- **坐标点击**：模型给的是**像素坐标**（相对它看到的截图），调用方负责把坐标落到真实视口；官方 Anthropic 示例专门做了 1920x1080 视口 → 1456x819 处理图的坐标换算（anthropic-quickstarts/browser-use-demo README "Coordinate Scaling" 一节）https://github.com/anthropics/anthropic-quickstarts/blob/main/browser-use-demo/README.md
- **状态连续性**：多轮对话通过 `previous_response_id` 衔接（示例代码 `runResponsesNativeComputerLoop`），`truncation: "auto"`、`reasoning: { effort: "low" }` 是示例默认
- **安全机制**：模型输出可能带 `pending_safety_checks`，需调用方显式确认（`acknowledged_safety_checks`）后才能继续；官方示例未实现该确认流、直接抛错。来源同上两处仓库
- **截图 token 成本**：Anthropic 官方文档给出的量级是"每张截图 ≈ 1500 输入 token"（anthropic-quickstarts/computer-use-best-practices README "Effective caching and context pruning" 一节）https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-best-practices/README.md —— OpenAI 侧量级相同（约 1~1.7k/图，图片按 tile 计费）

### 1.2 API 形态与可用模型

- **旧预览形态**：`computer_use_preview` 工具 + `computer-use-preview` 模型，需声明 `display_width` / `display_height` / `environment`（`windows`|`mac`|`linux`|`ubuntu`|`browser`），输出上限 1024 token/响应。来源：openai-node `ComputerUsePreviewTool` 类型定义；LiteLLM 价格镜像中 `computer-use-preview` 条目
- **当前形态**：`computer` 工具（无参数）+ GPT-5.x 系列模型（视觉模型直接具备电脑操作能力）。官方 TS 示例 .env 默认 `CUA_DEFAULT_MODEL="gpt-5.4"`，默认 `maxResponseTurns=24` https://github.com/openai/openai-cua-sample-app（.env.example）
- **调用入口**：Responses API `POST /v1/responses`，官方 Node SDK `openai.responses.create()`（示例代码 `OpenAIResponsesClient`）。官方文档（本网络 403，需复核）：https://platform.openai.com/docs/guides/tools-computer-use 、https://platform.openai.com/docs/api-reference/responses/create
- **环境要求**：OpenAI 官方在浏览器/桌面两种环境都支持；官方 cookbook 示例用 Daytona 云沙箱（Linux 桌面 Xvfb+VNC）承载，适配层实现 `AsyncComputer` 接口（截图/点击/滚动/键入/按键/移动/拖拽/等待），`max_turns=50` 上限"一个表单填写任务好跑远低于此"。来源：openai-cookbook `examples/agents_sdk/computer_use_with_daytona` https://github.com/openai/openai-cookbook

## 二、对两个目标源的实际适用性（当日实测）

### 2.1 BOSS 直聘（zhipin.com）

实测（2026-08-12，Chrome UA）：

- **robots.txt 明确禁爬**：`Disallow: /*?query=*`、`/job_detail/l*.html`、`*?position=*`、`*?city=*`、`/*?*` 等——搜索、职位列表、JD 详情全部被排除 https://www.zhipin.com/robots.txt
- **反爬壳页**：职位搜索页 `https://www.zhipin.com/web/geek/job?query=校招` 与校招频道 `https://www.zhipin.com/web/geek/campus` 均只返回 9.2KB 空壳 HTML（title 仅"BOSS直聘"），页面注入 `browser-check-v2.js`（浏览器指纹校验），真实内容在 JS 校验通过后由 XHR 加载——纯 HTTP 客户端拿不到任何职位数据
- **JD 详情拦截**：`https://www.zhipin.com/job_detail/1.html` 返回 41KB"请稍候 - BOSS直聘"拦截页
- **验证码/风控**：站点 JS 里可见 geetest 极验接入与对"后羿采集器"等爬虫工具的主动识别（前端埋点 ignore 列表含 `geetest`、`后羿采集器`）——说明登录、搜索、翻页等敏感操作会走滑块验证码
- **用户协议**：https://about.zhipin.com/agreement （SPA，正文需浏览器渲染，本网络未取到条款原文；以 robots.txt 的明确 Disallow 为准）

对 Computer Use 的含义：

- 用真实 Chrome（非 headless 裸协议）能过 `browser-check` 指纹校验——这恰是 Computer Use 相对普通爬虫的唯一优势
- 但**登录墙 + geetest 滑块**仍存在：模型能"看到"滑块并尝试拖拽，成功率不稳定；滑动验证码的轨迹检测会拒绝机器拖拽，失败后需人工完成
- 列表翻页、JD 详情在登录态下是常规 DOM 操作，视觉模型可胜任但**慢**（每页一屏截图 + 一轮推理）
- 站方条款风险高（见第七节）

### 2.2 国聘（iguopin.com）

实测（2026-08-12，Chrome UA）：

- **纯 SPA**：首页只有 1.4KB 壳，内容全部由 React 加载；robots.txt 放行（`Disallow:` 为空）https://www.iguopin.com/robots.txt
- **数据 API 登录墙**：职位列表/详情接口 `gp-api.iguopin.com/api/jobs/v3/list`、`/api/jobs/v3/info` 未登录直接返回 `{"code":403,"msg":"账号类型错误或权限不足"}`；部分接口还有频控（"当前访问人数过多，请稍后重试"）。即**未登录连列表都拿不到**
- **登录方式**：手机号短信、微信扫码/授权、邮箱、App 扫码等（前端路由含 `/login/sms`、`/login/wechat-code` 等）；前端引入阿里云滑块验证码（`aliyunCaptcha`）
- **其他入口**：App API（`appv5-api.iguopin.com`）响应为加密 blob，不可直接读；另有小程序（微信内）
- **职位结构**：列表/详情接口字段规范（`/api/jobs/v3/list`、`/api/jobs/v3/info`），登录后结构良好；校招/社招分频道

对 Computer Use 的含义：

- 登录态下（用户扫码一次，会话保持）视觉模型翻页、读 JD 可行；JD 详情在登录后是普通 DOM
- **真正的门槛是登录与验证码**，这与 Computer Use 无关——任何方案都得先解决登录态
- 若已有登录 cookie，普通 Playwright 直接调 API 读 JSON 比视觉点击便宜一个数量级；Computer Use 只适合"接口又改版、DOM 解析失效"时的兜底

### 2.3 访问方式小结

| | 未登录 | 登录后 | 验证码 | 备注 |
|---|---|---|---|---|
| BOSS 直聘 | 壳页+拦截页，无数据 | 可看列表/JD，搜索易触发风控 | geetest 滑块 | robots 禁爬；高频操作易封号风险 |
| 国聘 | API 403，无数据 | API 数据完整、结构规范 | 阿里云滑块（登录时） | robots 放行；登录态可用普通爬虫 |

## 三、成本模型（单次"查询某公司校招职位"）

### 3.1 定价（USD / 每百万 token，需官方页复核）

| 模型 | 输入 | 输出 | 备注 |
|---|---|---|---|
| gpt-5.4（当前推荐，官方示例默认） | $2.50 | $15.00 | 官方示例默认模型 |
| computer-use-preview（旧） | $3.00 | $12.00 | 输出上限 1024 token/响应 |
| gpt-4o（较老） | $2.50 | $10.00 | 视觉可用 |
| claude-sonnet-4-5/4-6（Anthropic） | $3.00 | $15.00 | 对比用 |
| claude-haiku-4-5 | $1.00 | $5.00 | 便宜档 |
| gemini-2.5-computer-use-preview | $1.25 | $10.00 | Google CUA 对比 |

来源：LiteLLM `model_prices_and_context_window.json`（第三方镜像，维护活跃，与官方价目一致）https://github.com/BerriAI/litellm ；官方价格页（本网络 403，需复核）：https://platform.openai.com/docs/pricing 、https://www.anthropic.com/pricing

### 3.2 步数与 token 估算

以"BOSS 直聘（已登录会话）：查某公司校招职位列表 + 2~3 条 JD"为例：

| 环节 | 轮数（turn） | 每轮输入构成 |
|---|---|---|
| 打开站点/搜索公司/进公司页 | 3~5 | 系统提示 ~1k + 累积截图（每张 ~1.5k） |
| 校招频道/职位列表翻页 | 2~4 | 同上 + 历史截图累积 |
| 打开并阅读 2~3 条 JD | 3~6 | 同上 |
| 汇总输出 | 1 | — |
| **合计** | **~10~15 轮** | 输入累计 ~4万~10万 token，输出 ~3千~6千 token（含推理） |

- 截图会累积进上下文：官方量级"30 轮后截图历史 ≈ 4.5 万 token"（Anthropic 官方 best-practices，OpenAI 侧同量级）。10~15 轮任务不会触发上下文压缩，但输入逐轮增长
- 官方循环默认 `reasoning: {effort: "low"}` 控制推理 token（openai-cua-sample-app）

### 3.3 单次成本

- 用 gpt-5.4：输入 7 万 × $2.5/M ≈ $0.175 + 输出 4 千 × $15/M ≈ $0.06 → **≈ $0.2~0.3/次**（含 1 次重试约 $0.4~0.6）
- 用 computer-use-preview：≈ $0.25~0.35/次
- 若被验证码卡住反复重试 3 次以上，单任务可到 **$1 量级**
- 对比：登录态普通爬虫调国聘 API 读同量级数据 ≈ 0 美元 + 分钟级开发维护成本；Computer Use 的成本全在"每次查询都重新看一遍屏幕"

## 四、速度与稳定性

- **单轮延迟**：Anthropic 官方示例实测单轮（截图+推理+执行）约 12.3s（best-practices README 的 `[usage] ... 12.3s` 行）；OpenAI 侧量级相同（秒级~20s/轮，取决于推理配置与负载）。10~15 轮任务约 **1~3 分钟**
- **失败模式**：验证码/风控页（最致命，模型可能原地空转）、元素点击坐标偏差（窗口尺寸变化）、登录过期、API 限流。官方循环均需调用方自己实现轮数上限（示例默认 24 轮）与超时（示例单工具执行超时 20s）
- **API 稳定性**：status.openai.com 当前"All Systems Operational"；近两周事件多为已解决的 minor 级"error rates / login"问题，无重大故障 https://status.openai.com/
- **重试策略（来自官方示例的工程实践）**：轮数上限（防死循环）+ 单轮工具执行超时 + `previous_response_id` 断点续传；Anthropic best-practices 另建议截图裁剪（JPEG 质量/间隔策略）与 prompt caching（缓存读 ≈ 输入价 1/10）控制成本

## 五、与本地 Node/TS 桌面应用（Electron）的集成

- **API 直连方案（推荐做二期骨架）**：OpenAI 官方 TS 示例的架构可直接照搬——`openai` npm SDK（`openai.responses.create`）驱动循环 + Playwright Chromium 执行动作 + 截图回传；Electron 主进程可把该循环放进子进程（示例即 Fastify runner + 独立 UI，天然适合本地服务模式）。仓库：https://github.com/openai/openai-cua-sample-app
- **兜底 1：开源 browser-use**（Python）：LLM 无关（OpenAI/Anthropic/Gemini 任选），自带 DOM 优先的 agent 循环；云版宣称"代理轮换 + 验证码解决 + 隐身"，有 REST API。但 Python 生态需进程外部署（sidecar），且其准确率声明为自评（Odysseys 榜 87.4%"领先 OpenAI/Anthropic/Google/Microsoft 官方 CU 代理"）需甄别。https://github.com/browser-use/browser-use
- **兜底 2：Playwright MCP**（Microsoft 官方）：走**无障碍树**而非截图——"不需要视觉模型/截图，结构化数据驱动、确定性强、token 更省"；作为 MCP server 可被任意 agent 客户端调用，Node 18+ 即可，与 Electron 同栈。https://github.com/microsoft/playwright-mcp
- **实践建议**：二阶方案 = 普通爬虫（国聘登录态直读 API / BOSS 登录态 Playwright DOM）为主，Computer Use 只作为"结构解析失效时的视觉兜底"，且只跑在**低频人工触发**场景；Electron 侧集成用官方 TS 循环 + 子进程即可

## 六、顺带对比（简短）

| 方案 | 机制 | 成本（同任务） | 效果/可靠性 | 集成成本 |
|---|---|---|---|---|
| OpenAI Computer Use | 截图+坐标点击（gpt-5.4） | ~$0.2~0.3/次 | 视觉通用；验证码易翻车；官方 TS 参考实现 | 低（npm SDK + Playwright） |
| Anthropic Computer Use | 截图+坐标点击 或 Playwright DOM 工具（官方推荐后者） | sonnet $3/$15，同量级 | 官方明确建议浏览器任务用 **DOM ref 定位**而非纯坐标（"坐标随窗口尺寸失效"）；其演示确认 Google 搜索会触发 CAPTCHA | 低（anthropic-quickstarts 参考实现） |
| browser-use（开源） | DOM 优先 agent 循环，多模型 | 模型费同量级；云版另计费 | 自评榜单领先；云版带验证码解决/代理 | 中（Python sidecar） |
| Playwright MCP / 自写 Playwright | 无障碍树/DOM 直读，无视觉 | ≈0（无视觉 token） | 对"已登录、结构稳定"的站最高效最稳 | 低（Node 原生） |

来源：anthropic-quickstarts/browser-use-demo（CAPTCHA 提示、DOM vs 坐标优劣、model 兼容清单）https://github.com/anthropics/anthropic-quickstarts/blob/main/browser-use-demo/README.md ；browser-use README https://github.com/browser-use/browser-use ；playwright-mcp README https://github.com/microsoft/playwright-mcp

## 七、合规性注意

- **BOSS 直聘**：robots.txt 对搜索/职位列表/JD 详情**全部 Disallow**（见 2.1），这是站方对自动化访问的明确表态；用户协议页 https://about.zhipin.com/agreement （正文未抓取到，上线前人工确认其中关于自动化访问/数据使用的条款）。高频自动化查询存在账号风控与封禁风险
- **国聘**：robots.txt 放行，但数据接口要求登录；登录即受其用户协议约束，建议确认协议中"禁止批量抓取"类条款（协议页在 SPA 内，未直接抓取到 URL）
- **通用**：即使技术上可行，自动化访问第三方站点仍需遵守目标站条款与当地法律（中国《网络安全法》《数据安全法》《个人信息保护法》对个人信息采集有限制）。**建议二期定位为"用户主动触发、低频、登录态、结果人工确认"的辅助查询**，不做批量采集；Electron 应用内明确告知用户其行为受目标站条款约束

## 八、对二期的建议

1. **不把 Computer Use 当主力采集**：两个目标源的核心障碍（BOSS 反爬风控、国聘登录墙）不是视觉模型能低成本解决的；登录态下普通爬虫/DOM 读取更便宜可靠
2. **若做，做"登录态人工辅助"通道**：用户扫码/手动登录一次，会话持久化；Computer Use 或 Playwright DOM 执行"查某公司校招"的低频查询，输出经用户确认
3. **技术选型顺序**：国聘=登录态 API 直读（最简单）；BOSS=登录态 Playwright DOM + 保守频率；视觉兜底用 OpenAI 官方 TS 循环（openai-cua-sample-app 为模板）；全部方案预留 Playwright MCP 作为无视觉备胎
4. **成本护栏**：轮数上限（≤15）、单任务预算（≤$0.5）、失败自动转人工
5. **复核项**：官方价格页与 Computer Use 文档正文（本网络不可达）、BOSS 用户协议条款原文、国聘协议 URL
