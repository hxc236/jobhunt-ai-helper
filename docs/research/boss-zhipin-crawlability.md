# BOSS直聘可爬性调研（当前采集机制视角）

> 调研时间：2026-08-13。方法：curl（Chrome UA）裸探测 + Electron BrowserWindow 实测（真实 Chromium，复用应用 ADR-0006 采集机制的隐藏窗口方案）。探测脚本在 `.checkpoint/boss-probe*.cjs`（已 gitignore），证据原始输出在 `.checkpoint/boss-probe{1,5,6}-result.json` 与截图 `.checkpoint/shots/boss-main-search.png`。
> 显式请求总量约 20 次（含重试，含 curl 302 链），分布在约 25 分钟内；期间观察到目标站风控逐步升级（见"反爬行为时间线"）。
> 关联 ticket：BOSS直聘采集需求（社招+校招，后续加关键词等筛选）。

## 结论速览

| 问题 | 结论 |
|---|---|
| **主站职位搜索免登录可爬？** | ✅ **可以**。Electron BrowserWindow 加载 `https://www.zhipin.com/web/geek/job?query=前端&city=101020100`：页面渲染真实职位卡（15 张首屏）、无验证码、无登录墙；页面内 fetch 列表接口返回 `code:0` + 完整职位 JSON |
| **curl 裸探测？** | ❌ 列表接口直连返回 `code:37 环境异常`（服务端风控，缺浏览器环境指纹）；页面 HTML 为 9.2KB SPA 壳，无数据 |
| **数据载体** | 主站为 SPA（Vue，壳页无 SSR 数据），职位数据走 XHR 接口：`/wapi/zpgeek/search/joblist.json`（列表）、`/wapi/zpgeek/job/detail.json`（详情，securityId 为主键） |
| **字段可得性** | 列表 49 字段：岗位名/薪资/经验/学历/城市/区/商圈/GPS/公司全信息/福利/技能标签/BOSS 信息等；详情 `jobInfo.postDescription` 为 **JD 全文**（含职责分节）。⚠️ 本次匿名会话中 `salaryDesc` 为空且卡片不渲染薪资（观察，原因未定） |
| **筛选参数** | URL/接口参数：`query`（关键词）、`city`（城市码 101020100=上海）、`page`（分页，hasMore 证实）实测有效；`jobType/salary/experience/degree/...` 参数名在 SPA 自身请求中可见，**数值编码本会话未获成功样本验证**（被风控拦截） |
| **校招站** | `/campus/`、`/campus/jobs` 一律 302 → `/campus/pc/`：是 **BOSS 自家雇主招聘页**（视频+投递按钮，无聚合职位数据）。校招岗位需走主站搜索（query=届数/校招 + jobType 筛选） |
| **BrowserWindow 机制适用性** | ✅ **可行**（实测证明），但有**频率约束**：同进程连续第二次导航被连接重置（ERR_FAILED）；约 15 分钟 ~20 次探测后 API 层被风控升级（code:37 → code:200404），页面渲染不受影响 |
| **官方 API** | ❌ 无开放平台。`open.zhipin.com` DNS 解析到保留地址段（198.18.1.133，DNS 污染）且连接失败 |
| **旧调研结论修正** | recruit-sources.md（2026-08-11）"UA 检测+反爬壳页 ❌"：UA 检测仅针对手机/IE 跳转，桌面 Chrome 不拦截；"壳页"实为 SPA（数据走 XHR，真实浏览器可渲染）。**结论从 ❌ 修正为 ✅（低频可爬）** |

## 一、实测明细

### 1. 主站职位搜索页（PC）

- `GET https://www.zhipin.com/web/geek/job`（Chrome UA，curl）→ 200，9.2KB
  - SPA 壳：`<title>BOSS直聘</title>`，无任何职位数据内嵌（无 `__INITIAL_STATE__` 类 JSON）
  - 关键脚本：`img.bosszhipin.com/static/zhipin/geek/sdk/browser-check-v2.js`（1.2KB）——内容为**浏览器能力检测**：IE/老浏览器跳转 `nonsupport.html`，不设反爬 cookie
  - 页面加载后自动跳转 `/web/geek/jobs?query=...&_security_check=1_<ts>`（客户端安全校验通过后追加参数）
- `GET https://www.zhipin.com/web/geek/job?query=前端&city=101020100`（curl）→ 200，仍是 9.2KB 壳，无职位数据——**curl 拿不到数据**
- **Electron BrowserWindow 实测同一 URL**（隐藏窗口，sandbox:false + contextIsolation:true，与应用 ADR-0006 一致）：
  - 最终 URL：`https://www.zhipin.com/web/geek/jobs?query=前端&city=101020100&_security_check=1_1786554690785`
  - `<title>「上海招聘」-2026年上海人才招聘信息 - BOSS直聘</title>`，首屏 15 张职位卡，`verify: false`（无验证码/人机校验元素）
  - DOM 职位卡字段实测：`前端 / 3-5年 / 本科 / 法本 / 上海·浦东新区·临港`（岗位名、经验、学历、公司、城市·区·商圈）
  - UA 实测含 `Electron/43.4.0` 字样，**未触发拦截**
  - 页面自身 XHR（webRequest 捕获，52 条）关键接口：
    - `GET /wapi/zpgeek/search/joblist.json?_=<ts>`（列表，页面加载时调用）
    - `GET /wapi/zpgeek/job/detail.json?securityId=<长串>&lid=<随机串>.search.<页码>&_=<ts>`（详情，加载时预取首条）
    - `GET /wapi/zpgeek/pc/all/filter/conditions.json`（筛选条件/编码字典）
    - `GET /wapi/zpgeek/search/job/tdk.json?city=...&jobType=&salary=&...`（搜索态参数名可见于此）
    - 其余为埋点/登录态探测（zpToken、getUserInfo、logapi、apm），均 200

### 2. 列表接口

- `GET /wapi/zpgeek/search/joblist.json?query=前端&page=1&city=101020100`
  - **curl 直连（Chrome UA + Referer）→ `{"code":37,"message":"您的环境存在异常.","zpData":{"seed":"...","name":"9a324475","ts":...}}`** —— 服务端风控拒绝，无浏览器环境指纹（非 UA 检测，UA 已伪装 Chrome）
  - **Electron 首访环境、页面内同源 fetch（自动携带页面 cookie）→ `{"code":0,"message":"Success","zpData":{"hasMore":true,"jobList":[...]}}`**（实测两次，均成功）
- 响应字段（实测 49 个 key）：`securityId`（详情接口主键）、`encryptJobId`、`jobName`、`salaryDesc`、`jobLabels`（如 `["3-5年","本科"]`）、`skills[]`、`jobExperience`、`jobDegree`、`cityName`、`areaDistrict`、`businessDistrict`、`gps{lon,lat}`、`brandName`、`brandLogo`、`brandStageName`（融资阶段）、`brandIndustry`、`brandScaleName`、`welfareList`、`bossName`、`bossTitle`、`bossAvatar`、`bossOnline`、`jobValidStatus`、`lid`（详情接口辅助参数）等
  - ⚠️ 本次匿名会话中该职位 `salaryDesc:""`，页面卡片也不渲染薪资文本——**匿名会话薪资可见性存疑**（可能是该职位本身未填薪资，也可能是登录态限制；未进一步验证，需登录态场景再测）

### 3. 详情接口（JD 全文）

- `GET /wapi/zpgeek/job/detail.json?securityId=<列表返回的securityId>`（实测 `jobId=undefined` 也返回 code:0，证明 **securityId 即主键**，SPA 自身调用还带 `lid`）
- 响应结构：`zpData.{pageType, selfAccess, securityId, sessionId, lid, jobInfo, bossInfo, brandComInfo, ...}`
- `jobInfo` 实测字段：`jobName`、`positionName`（如"前端开发工程师"）、`experienceName`（"3-5年"）、`degreeName`（"本科"）、`postDescription`（**JD 全文**，实测含"工作职责"分节）、`showSkills[]`、`address`（详细地址）、`longitude/latitude`、`jobStatusDesc`（"最新"）、`invalidStatus`、`recruitmentCountDesc`
- `brandComInfo`：公司名/融资阶段/规模/行业/简介/labels/activeTime；`bossInfo`：姓名/职位/在线状态

### 4. 校招站

- `GET https://www.zhipin.com/campus/` → 302 → `http://www.zhipin.com/campus/pc/` → 301 → `https://www.zhipin.com/campus/pc/` → 200，3.2KB
- `GET https://www.zhipin.com/campus/jobs` → 同样 302 → `/campus/pc/`（2026-08-13 实测）
- `/campus/pc/` 内容（Electron 实测）：`<title>BOSS直聘2026届校园招聘</title>`，页面只有"主页/岗位详情/招聘动态/工作地点/立即投递 + 宣传视频"——**是 BOSS 自家雇主招聘页，无聚合职位数据**；页面 XHR 仅 zpToken/埋点/getUserInfo
- 页面内 UA 检测脚本实测内容：仅针对手机 UA 跳 `/campus/mobile/`、IE 跳 browser-tips——桌面 Chrome 不受影响
- **校招岗位聚合路径**（推断，未实测）：主站搜索 `query=校招/2026届...` + `jobType`（求职类型）筛选；校招岗位与社招岗位共用主站接口体系

### 5. 反爬行为时间线（本次会话实测，IP 维度）

| 时刻 | 行为 | 结果 |
|---|---|---|
| 首次（全新 IP 会话） | curl 直连列表接口 | `code:37 环境异常`（curl 从未成功过） |
| 首次 Electron 导航 + 页面内 fetch | 列表接口 | ✅ `code:0` 完整数据 |
| 第 2~3 次导航（同进程连续，间隔 <10s） | 第二次导航 | `ERR_FAILED (-2)` 连接重置（两次复现：主站→校招、校招→主站，均第二次失败） |
| ~10 分钟后 | 页面内 fetch 列表 | `code:37 环境异常`（页面自身渲染仍正常） |
| ~15 分钟后 | 页面内 fetch 列表（带筛选参数） | `code:200404 用户未登录`（风控升级形态） |
| ~20 分钟后（间隔几分钟冷却） | 全新 session 页面内 fetch | ✅ 再次 `code:0`（列表+详情均成功） |

结论：风控是**会话/IP 累积维度**的渐进升级，非 UA 维度；冷却后恢复。页面渲染层比 API 层宽容（页面一直能出数据，API 先被拦）。

### 6. 官方开放平台

- `https://open.zhipin.com/`：DNS 解析到 `198.18.1.133`（RFC 保留测试段，典型的域名污染/不可达），连接失败——**无公开开发者开放平台**（业界亦无 BOSS 官方 API 文档）

## 二、当前机制（BrowserWindow）适用性判断

**结论：可行，是"能不能爬"的唯一可行路径，且实测通过；但必须遵守频率纪律。**

| 反爬手段 | curl 表现 | BrowserWindow 表现 |
|---|---|---|
| UA 检测（browser-check-v2.js） | 不适用（curl 无 JS，但 UA 字符串本身不拦截） | ✅ 通过（含 `Electron/43.4.0` 字样仍通过，未做 UA 黑名单） |
| 壳页/SPA 无数据 | 卡死（9.2KB 壳） | ✅ JS 执行后真实渲染 |
| 接口风控（code:37 / 200404） | 100% 被拒 | ✅ 页面加载早期 fetch 成功；被标记后需冷却 |
| 验证码/登录墙 | — | 本次 25 分钟内 6 次导航均**未出现**验证码/登录墙 |
| 同进程连续导航 | — | ❌ 第二次导航被连接重置（ERR_FAILED）——**每窗口只导航一次，窗口间加间隔** |
| 频率累计风控 | — | ⚠️ API 层渐进升级（37 → 200404），冷却后恢复；页面层未封 |

对应用抓取器的落地建议（基于现有 `BrowserWindowFetcher`，不写实现）：

1. **保持"每 fetch 一个独立窗口 + 独立 session + 用后即毁"**（现机制已如此），且**单窗口只 loadURL 一次**，不要在同一窗口内二次导航（会触发 ERR_FAILED）
2. **两次抓取之间加冷却间隔 ≥30~60 秒**；同 IP 短时总量控制（建议每小时 ≤ 数十次页面级抓取，先小规模验证再定）
3. **数据提取两种途径二选一**：
   - 首选 DOM（页面自身渲染的职位卡，字段含岗位名/经验/学历/公司/城市/商圈/标签）——与页面自身流量一致，最不易触发风控
   - 次选页面加载早期（前几秒）页面内 fetch 列表接口拿 49 字段全量 JSON + 详情接口拿 JD 全文——**不要在页面稳定后再补发 fetch**（实测 +3.5s~+8s 的补发 fetch 被风控拦截，加载期内的正常 XHR 不受影响）
4. **匿名会话薪资字段可能为空**：`salaryDesc:""` 且卡片不渲染薪资。若产品需要薪资字段，先验证登录态采集（本期不尝试绕过登录，仅记录）
5. 每条职位记录拿 `securityId`（列表返回），详情接口以其为主键；`lid` 格式 `随机串.search.页码`，缺失时详情仍可用（实测 jobId=undefined 仍成功）

## 三、建议的 URL / 接口与筛选参数

| 用途 | URL / 接口 | 参数 | 实测状态 |
|---|---|---|---|
| 搜索页（DOM 途径） | `https://www.zhipin.com/web/geek/job` | `query`（关键词）、`city`（城市码） | ✅ 实测有效（自动跳 `/web/geek/jobs` + `_security_check`） |
| 列表接口（页面内 fetch） | `/wapi/zpgeek/search/joblist.json` | `query`、`city`、`page`（分页，`hasMore` 标记） | ✅ 实测有效（code:0） |
| 详情接口（页面内 fetch） | `/wapi/zpgeek/job/detail.json` | `securityId`（必，列表返回）、`lid`（选） | ✅ 实测有效（code:0，JD 全文在 `jobInfo.postDescription`） |
| 筛选项编码字典 | `/wapi/zpgeek/pc/all/filter/conditions.json` | — | 接口存在（SPA 调用 200），内容未抓取——**建议实现时首跑抓一次** |
| 城市码 | `/wapi/zpgeek/common/data/defaultcity.json`、`city/site.json` | — | 接口存在（SPA 调用 200） |
| 搜索态参数名参考 | `/wapi/zpgeek/search/job/tdk.json` | `city, encryptExpectId, mixExpectType, expectInfo, multiSubway, multiBusinessDistrict, jobType, salary` | ✅ 参数名从 SPA 自身请求实测 |

**筛选参数说明（重要）**：`jobType/salary/experience/degree/industry/scale/multiBusinessDistrict/multiSubwayLineId` 等参数名见于 SPA 自身请求与公开资料，但**数值编码本会话未获成功样本验证**（带筛选参数的 fetch 恰逢风控拦截，返回 200404 而非数据）。已知的公开资料常见编码（如 `experience: 102=在校/应届 103=经验不限 104=1-3年 105=3-5年...`、`degree: 202=大专 203=本科 204=硕士...`、`salary: 4=3-5K 5=5-10K 6=10-20K 7=20-50K 8=50K以上`）**仅作参考，需在实现阶段用 `filter/conditions.json` 返回的实际字典核对**。城市码 `101020100=上海` 已实测有效。

## 四、备注

- 所有结论基于 2026-08-13 单机单 IP 实测；探测显式请求约 20 次（含重试与 302 链），未出现封 IP 或验证码
- 标注"推断"的内容：校招岗位聚合路径（走主站搜索）、筛选参数数值编码、匿名薪资为空的成因
- 未尝试：登录绕过、验证码绕过、滑块、代理池——超出本次调研范围
- 若产品接受低频（手动触发 + 预览确认，与现有采集预览交互一致），BOSS 直聘社招+校招（校招走主站搜索）可作牛客/猎聘之外的**补充源**试点；若未来需要高频批量采集，需先解决频率风控（间隔、代理、登录态），届时再评估 Playwright/Computer Use 通道（ADR-0006 二期预案）
