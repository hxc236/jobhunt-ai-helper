# 校招信息源调研（试点爬虫源选择）

> 调研时间：2026-08-11（27 届秋招进行中）。方法：直接 HTTP 探测各候选源的 PC 端页面与接口（curl，Chrome UA），验证可访问性、反爬、数据是否 SSR 嵌入、字段完整度。所有结论均来自当日实测，注明来源 URL。
> 关联 ticket：[jobhunt-ai-helper#4](https://github.com/hxc236/jobhunt-ai-helper/issues/4)

## 结论速览

| 源 | 覆盖度 | 可爬性 | 更新频率 | 信息结构 | 结论 |
|---|---|---|---|---|---|
| **牛客网校招日程** | ★★★★★ 2.2万+ 企业，国企/大厂/私企全有 | ★★★☆ 免登录 SSR，分页需逆向 API | 每日（页面标注收录/更新日期） | 网申起止时间、岗位名、投递渠道、城市 | ✅ **试点首选** |
| **猎聘校招** | ★★★★ 全行业，中小私企多 | ★★★★ 免登录 SSR 列表 | 高频 | 公司+项目卡、示例职位、无截止时间 | ✅ **试点次选** |
| 高校就业信息网（清华等） | ★★ 单校覆盖，国企/宣讲会多 | ★★★★ 传统 SSR 门户免登录 | 每日 | JD 公告全文、无结构化截止时间 | 备选（后期按校接入） |
| 智联招聘校招 | ★★★★ 岗位多 | ★ 职位 API 有登录墙 | 高频 | 结构好 | ❌ MVP 不做 |
| BOSS 直聘校招 | ★★★★ | ★ UA 检测+反爬壳页 | 高频 | 结构好 | ❌ MVP 不做 |
| 前程无忧校招 | ★★★★ | ★ 百度+阿里云双重 WAF JS 挑战 | 高频 | 结构好 | ❌ MVP 不做 |
| 公司官网（字节/小米等） | ★ 每站 1 家公司 | ★★ 各家 SPA，系统各异 | 高 | JD 权威、有截止时间 | 后续按公司清单定向接入 |
| OfferShow | ★★ 校招时间表 | ★ Vue 空壳，数据在 App/小程序 | 高 | 无 JD | ❌ |
| NCSS 国家大学生就业平台 | ★★★★ 国企必发 | ★ 学信网登录墙 | 高 | 规范 | ❌（登录墙） |

## 一、候选源实测明细

### 1. 牛客网校招（推荐 ✅）

页面结构（均为免登录可访问的 SSR 页面）：

- 校招日程列表：`https://www.nowcoder.com/jobs/school/schedule`（200，184KB）
  - `window.__INITIAL_STATE__` 内嵌 `scheduleData` JSON：`totalCount: 22116`、`totalPage: 1106`、首屏 `datas[]` 约 20 条
  - 每条字段：`name`（公司名）、`batchName`（如"27届秋招"）、`wangshenBeginDate` / `wangshenEndDate`（网申起止，epoch ms）、`wangshenTime`（如 "7.31-10.31"）、`cityList`、`sourceInformation`（投递渠道=公司官网 URL）、`companyEvaluation`（公司简介）
  - 页面内置筛选：届数批次（26 春招/26 秋招/27 提前批/27 秋招等）、行业、**国企/外企/民企/事业单位**、城市
- 企业校招详情页：`https://www.nowcoder.com/enterprise/{companyId}?pageSource=5014&channel=recruitmentSchedule`（200，95KB，SSR）
  - 实测（enterprise/164，巨人网络）：`招聘批次：27届秋招`、`网申时间：2026/08/10 ~ 2026/10/31`、`招聘城市：上海`、`招聘岗位：客户端开发、测试、交互/设计、动画/特效、游戏设计`、`官网投递`（投递渠道），页面标注"校招日程于2026/08/11更新"
- 校招职位列表：`https://www.nowcoder.com/jobs/school/jobs`（200，369KB）— SSR 壳，`jobList: null`，职位数据走 XHR

限制：

- 分页（共 1106 页）数据走 XHR API，接口路径被混淆（实测常见路径 `/api/sparta/*` 均 404），需用 headless 浏览器（Playwright）首跑一次抓取真实 XHR，之后可直连
- 岗位只有名称列表，无 JD 全文
- 更新频率：收录日期可见（如 "07.06收录"），详情页标注每日更新

### 2. 猎聘校招（推荐 ✅）

- 校招首页：`https://www.liepin.com/campus/`（200，68KB，SSR 文本内嵌数据，免登录）
  - 热门职位卡：职位名、薪资（如 "15-25k·15薪"）、城市、学历要求、福利标签、公司（含行业/规模）
  - 校招项目卡：如"韬润半导体2027届校园招聘"、"京东2027届JDS校园招聘"——公司名+届数项目+行业+融资+规模+城市数+职位数+示例职位
- 热门企业列表：`https://www.liepin.com/campus/comp-list/`（200，128KB，SSR，同上结构）
- 项目详情：`https://www.liepin.com/campus/project-detail/{id}/`（200，31KB，SSR）— 仅有公司介绍 SSR，职位列表与网申时间走 XHR
- 覆盖国央企样本：中国钢研科技集团、湖北航天工业学校、中铝科学院等出现在首页

限制：列表无截止时间字段；详情页职位/时间数据需 XHR（接口 `api-c.liepin.com` 免登录直连返回登录页，需浏览器首跑）。

### 3. 高校就业信息网（备选）

- 清华大学学生职业发展指导中心：`https://career.tsinghua.edu.cn/`（200，38KB）；招聘信息列表 `https://career.cic.tsinghua.edu.cn/xsglxt/f/jyxt/anony/xxfb`（200，213KB，SSR 免登录）
  - 条目：日期+标题+单位（实测含"芯动科技2027届校园招聘""江苏省南通市市属国有企业'名校优生'选聘"），可按单位性质（**国有企业**/外资/民营）、行业、地区、职位类型筛选
  - 详情为公告全文（含 JD），无结构化网申截止时间
- NCSS 国家大学生就业服务平台：`https://www.ncss.cn/student/jobs/` 重定向到学信网 passport 登录页（`account.chsi.com.cn/passport/login`）— **登录墙**
- 其他高校（job.tsinghua.edu.cn、career.pku.edu.cn、job.bjtu.edu.cn 等）多数可达，结构类似

限制：单校覆盖（仅来该校宣讲/投递的单位），岗位量少；宣讲会信息为主。

### 4. 智联招聘校招（不推荐）

- `https://xiaoyuan.zhaopin.com/`（200，644KB Vue SPA）
- 从 bundle 挖出的职位接口（`/positionbusiness/exposure/getPositionList`、`/positionbusiness/searchrecommend/searchPositions`）POST 直连返回登录页 HTML——**职位数据需登录 cookie**

### 5. BOSS 直聘校招（不推荐）

- `https://www.zhipin.com/campus/` → `https://www.zhipin.com/campus/pc/`（200，3.2KB 壳页）— 页面内 UA 检测脚本跳转（手机页/验证），无数据

### 6. 前程无忧校招（不推荐）

- `https://xy.51job.com/`（200，4.75MB SSR 首页，含校园招聘/宣讲会/实习导航）
- 校园招聘列表 `https://jobs.51job.com/campus/`：首访返回百度 WAF JS 挑战（`_waf_bd8ce2ce37`），带 cookie 二次访问触发阿里云 WAF（`aliyun_waf_aa`）——**双重 JS 挑战**，需真实浏览器过验证

### 7. 公司官网招聘页（后续阶段）

- 大厂校招页均为 SPA：字节 `https://jobs.bytedance.com/campus/position`（855KB）、小米 `https://xiaomi.jobs.f.mioffice.cn/campus/`（124KB）
- 牛客/猎聘页面中可见各公司官网直链（如 `jobs.mihoyo.com`、`talent.antgroup.com`、`talent.lenovo.com.cn`、`campus.kuaishou.cn`），投递渠道多为 Moka/北森/自研系统，**每家一套适配器**
- 国家电网招聘平台 `https://zhaopin.sgcc.com.cn/` 返回 412 反爬
- 价值：JD 权威、含截止时间；适合在试点验证后，基于牛客/猎聘抓到的公司清单定向补充大厂/国企官网

### 8. OfferShow（不推荐）

- `https://www.offershow.cn/home`（200，5.6KB Vue 空壳，无 title、无内嵌数据）；API 直连 404/不可达——数据主体在 App/小程序

## 二、试点建议

### 试点 1：牛客网校招日程（首选）

理由：

- **覆盖最广**：2.2 万+ 企业（含国企筛选维度），正是"国企、大厂、私企"全要的场景
- **字段命中率最高**：秋招开始时间、截止时间、招聘岗位、投递渠道（官网链接）、城市全部有（详情页 SSR 实测：`网申时间 2026/08/10 ~ 2026/10/31`）
- **免登录**：列表首屏与详情页均为 SSR HTML，纯 HTTP 可抓
- 秋招时间线（届数批次筛选）与产品核心字段"秋招开始时间"完全对应

实施要点：

1. 首屏数据直接解析 `__INITIAL_STATE__` JSON；完整列表用 Playwright 首跑一次捕获分页 XHR（一次性逆向，之后可直连带 UA/Referer 调 API）
2. 按 `batchName` 过滤"秋招"批次 + 关注届数（如 27 届），按 `wangshenBeginDate` 排序即得秋招时间线
3. 详情页按 `companyId` 逐个抓取补全岗位列表与投递渠道
4. 更新频率建议：每日一次（页面标注"校招日程于 X 更新"）

### 试点 2：猎聘校招（次选，与牛客互补）

理由：

- **免登录纯 SSR**，纯 HTTP GET + HTML 解析即可，实现成本最低
- 覆盖牛客偏弱的行业（机械/制造、新能源、国企院所等），含大量中小私企
- 首页即有"校招网申"项目卡（公司+届数+职位数），适合做"公司级校招项目"列表

限制：无截止时间字段；详情页职位数据需浏览器首跑抓 XHR。建议 MVP 阶段只抓列表卡数据（公司、届数项目、城市、职位示例），截止时间字段留空或后续从公司官网补。

### 暂不做（记录原因）

- 智联/BOSS/前程无忧：登录墙或双重 WAF，MVP 成本过高；后续有浏览器自动化基建再评估
- NCSS：登录墙（学信网），但作为国企信息权威源，若产品未来做登录态爬取可优先考虑
- 公司官网：每站一个适配器，等试点验证后按公司清单定向接入
- 高校就业网：单校覆盖，作为宣讲会补充源按校接入（清华等结构简单、免登录）

## 三、备注

- 所有实测 HTTP 探测均使用普通 Chrome UA、无 cookie、无代理，结论对本地桌面应用内置爬虫（本机 IP、单机频率）成立；高频抓取需自控频率并尊重 robots/ToS
- 测试日期为 2026-08-11，正值 27 届秋招；次年秋招季字段（届数、时间）随季节滚动，爬虫需按届数参数化
