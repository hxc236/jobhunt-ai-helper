# 实习/社招信息源调研（候选矩阵）

> 调研时间：2026-08-14。方法：直接 HTTP 探测（curl，Chrome UA，无 cookie），与 recruit-sources.md（2026-08-11，校招源）同一套方法。原始证据存 `.checkpoint/intern-social/`（robots.txt 原文、各站首页/列表页 HTML、国聘 JS bundle 提取的 API 路径）。
> 显式请求约 40 次，单次访问、无绕过。补充说明：BOSS 反爬处置（ADR-0009 人工浏览 + F8）不涉及本报告站点；本报告候选源若接入，同样优先考虑「人工浏览 + 截图提取」零风险形态，SSR 免登录站才评估自动采集。
> 关联：issue #62（人工浏览提取基建）、本次 grill 会话 Q6 决策（先补齐实习/社招调研，再定接入）。

## 结论速览

| 源 | 覆盖度（实习/社招） | 可爬性 | robots | 数据形态 | 结论 |
|---|---|---|---|---|---|
| **实习僧** | ★★★★★ 实习第一站 | ★★★☆ SSR 内嵌数据，但职位名 iconfont 混淆（curl 读不到明文，**真实浏览器渲染后是明文**） | 空（无禁爬） | `window.__NUXT__` 内嵌 `interns.data[]`（薪资/城市/学历/公司全有） | ✅ **实习源首选**，走真实浏览器（DOM 读取或 F8 式提取） |
| **国聘** | ★★★★★ 国资央企校招+社招主渠道 | ★★★ API 已逆向（`/api/jobs/v3/list`，POST），直连 405/回退 SPA；需登录态会话 | ✅ 全放行（`Disallow:` 空） | SPA（Vue）+ XHR API | 🟡 **高价值候选**，需登录态 + 真实浏览器验证 API 签名 |
| **智联招聘** | ★★★★ 社招全行业 | ★ robots.txt 都返回 Security Verification 页（JS 挑战在入口层） | —（入口即挑战） | 挑战墙后未知 | ❌ 入口 WAF 墙 |
| **前程无忧** | ★★★★ 社招全行业 | ★ 阿里云 antidom/interfaceacting 脚本（已知双重 WAF） | — | 挑战墙 | ❌ 与 recruit-sources.md 校招结论一致（双重 WAF） |
| **拉勾** | ★★ 已式微（主体转向拉勾教育） | ★ aliyun_waf_aa/bb 挑战 | — | 挑战墙 | ❌ |
| **脉脉** | ★★ 职场社区为主 | ★★ 首页 32KB SSR（文章/动态），无结构化职位列表接口 | AI 爬虫仅允许公开内容 | 社区内容 | ❌ 非职位源 |
| **应届生求职网** | ★★★ 校招/实习资讯 | ★★ 首页是 APP 下载落地页，`/job/` 404 | 常规（禁 cache/内部路径） | 数据主体在 APP | ❌ 无 Web 职位数据 |

## 一、实测明细

### 1. 实习僧 shixiseng.com（推荐 ✅ 实习源）

- `https://www.shixiseng.com/interns` → **200，592KB，Nuxt SSR**（`<html data-n-head-ssr>`），`window.__NUXT__` 内嵌 `interns.data[]` 列表（首屏完整职位卡）
- 内嵌字段实测：`name`、`minsal/maxsal/maxsalary`（薪资）、`city`、`degree`（学历）、`cname/c_uuid`（公司）、`scale`（规模）、`day`、`ftype/type`、`job_label`（实习标签）、`uuid`（职位 id）
- **⚠️ 反爬混淆（关键）**：职位 `name` 是 **iconfont 码点**（`&#xf101&#xe65b…`，私有区 Unicode）——curl 读 HTML 只见码点不见明文。但这是 CSS 图标字体映射，**真实浏览器渲染后就是正常文字**（页面 `intern-detail__job` 卡片可见）。含义：**纯 HTTP 解析拿不到职位名明文，走真实浏览器（DOM 读取）可以**
- robots.txt：空（无任何 Disallow）
- 首页 521（Cloudflare），但具体路径 200——入口层有防护，路径层可访问
- 结论：接入形态 = 真实浏览器 DOM 读取（可复用 F8 式只读提取），或 BrowserWindow 内嵌数据 + 浏览器环境渲染后取明文

### 2. 国聘 iguopin.com（🟡 高价值候选，需登录态）

- `https://www.iguopin.com/job` → 200，**1.3KB Vue SPA 壳**（`<div id="root">`，无数据）
- robots.txt → **`Disallow:` 空，全放行**（一手实测，与 computer-use-sources.md 结论一致）
- **API 逆向成功**（从 `main.685b2086.js` 3.3MB bundle 提取）：
  - `/api/jobs/v3/list`（method: post, data 参数）——职位列表
  - `/api/jobs/v3/info`、`/api/jobs/v3`、`/api/jobs/v1/count`——详情/计数
  - 另有活动/日历/公司/区划等全套 v1 API
- 直连表现：GET 回退 SPA 壳（catch-all），裸 POST → **405 nginx**——需要浏览器会话（cookie/签名）才能拿到数据
- 结论：**高价值**（国资央企主渠道，与你的国企向求职强相关），但接入前置条件 = 登录态 + 真实浏览器验证 API 签名（与 BOSS 的登录分区机制可复用）。验证实验需登录态，列为二期验证项

### 3. 智联招聘 zhaopin.com（❌）

- `https://www.zhipin.com/robots.txt` 误，正确为 `https://www.zhaopin.com/robots.txt` → **返回 Security Verification JS 挑战页**（连 robots.txt 都过 WAF）
- `https://sou.zhaopin.com/` → 同上 1987B 挑战页
- 结论：入口层 JS 挑战，curl 不可达；与 recruit-sources.md 的「职位 API 登录墙」叠加，成本高

### 4. 前程无忧 51job.com（❌）

- 首页 200（145KB），`we.51job.com/pc/search` → 7.9KB，含 `g.alicdn.com/frontend-lib/.../antidom.js` + `interfaceacting.js`（阿里云 WAF 前端组件）
- 与 recruit-sources.md 校招结论一致：**双重 WAF JS 挑战**
- 结论：同前，不做

### 5. 拉勾 lagou.com（❌）

- 首页/职位页均返回 **aliyun_waf_aa/bb 挑战页**（11KB，meta 带 WAF 标记）
- 且拉勾主体业务已转向拉勾教育，招聘板块式微
- 结论：不做

### 6. 脉脉 maimai.cn（❌ 非职位源）

- robots.txt：AI 爬虫仅允许公开内容（文章/社区动态），职位数据不在公开抓取范围
- 首页 200 32KB SSR，为职场社区内容
- 结论：社区而非职位库，不做

### 7. 应届生求职网 yingjiesheng.com（❌ Web 无数据）

- 首页 200（164KB）但为 **APP 下载落地页**；`/job/` → 404
- robots.txt 常规（禁 cache/datatemp 等内部路径），sitemap 存在
- 结论：数据主体在 APP/小程序，Web 无职位数据

## 二、建议

1. **接入优先级：实习僧（实习）> 国聘（国企向社招/校招）**，其余不接
2. **实习僧接入形态**：真实浏览器 DOM 读取（复用 issue #62 的「只读页面提取」基建思路），或 BrowserWindow 加载列表页后取渲染后 DOM 明文（iconfont 映射后）；**不要**纯 curl 解析（职位名是码点）
3. **国聘接入前置**：登录态会话 + 真实浏览器验证 `/api/jobs/v3/list` 的请求签名（POST body 参数、cookie/header 要求）——一次登录态探测实验，与 BOSS 登录分区复用。robots 全放行是合规友好项
4. **暂不做的理由记录**：智联/前程无忧/拉勾 = WAF 挑战墙；脉脉/应届生 = 无 Web 职位数据

## 三、备注

- 全部探测单次访问、无 cookie、无绕过，结论对本地桌面应用内置浏览器（本机 IP、低频人工触发）成立
- 实习僧首页 521 是 Cloudflare 入口防护，具体内容路径可访问——实测 `/interns` 200
- 实习僧/国聘都未绕过登录/验证码/混淆，只记录形态结论
- 下一步验证实验（若接入）：① 实习僧：BrowserWindow 加载 `/interns` 读 DOM 明文职位卡，确认字段完整度与翻页；② 国聘：登录态下 BrowserWindow 页面内调 `/api/jobs/v3/list`，确认响应签名要求
