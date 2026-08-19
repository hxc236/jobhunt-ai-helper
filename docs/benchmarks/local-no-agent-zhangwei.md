# 本地（无 Agent）识别结果基准 —— AI全栈工程师.pdf

> 用途：#85 决策依据。先看「不使用 Agent 的本地识别结果」质量，再决定是否依赖 Agent 结构化。
> 方法：运行 `extractPdfPages`（pdfjs 文本层提取）+ `buildPdfDraft` + `parseResumeText`（规则字段提取）+ `draftToResume`（本地映射），全程不经过 Agent。来源即本仓库代码（`src/main/services/resume-parse.ts`、`resume-import.ts`）与实测输出（`.acceptance/raw-local-result.json` 副本见本目录）。

## 测试对象

- 文件：`C:\Users\Hou_Xiangchen\Desktop\AI全栈工程师.pdf`（452,546 B）
- 类型：**文本型 PDF（含文本层）**——本地路径走 pdfjs 文本提取，**不涉及 OCR 引擎**
- 页数：2 页（第 1 页 1400 字符 / 128 项；第 2 页 992 字符 / 58 项）
- 说明：扫描型 PDF 才走 Windows OCR；OCR 引擎因本机缺 zh-Hans 语言包不可用（已记录 blocker，见 #79），文本型 PDF 不受影响。

## 原始识别数据

### 第 1 页全文（提取原文，未删改）

```
侯 祥 晨
13082624367   |   houxc2249@gmail.com   |   男   |   2002-03   |   中共党员
Github：https://github.com/hxc236
求职意向：AI Agent工程师｜AI应用开发工程师｜AI全栈工程师   ·   期望城市：北京 / 杭州 / 上海 / 济南
教育背景
山东科技大学   本科 · 软件工程   2020.09 ~ 2024.06
GPA 3.83/5.0   ·   排名 前 10%
相关课程：   C语言程序设计   C++面向对象程序设计   数据结构   算法设计与分析   Java后端开发 Web前端开发
山东科技大学   硕士 · 计算机科学与技术   2024.09 ~ 2027.06
相关课程：   数理统计   机器学习   深度学习   数字图像处理
项目经历
求职助手 JobHunt AI Helper   2026.06 ~ 2026.08
设计本地桌面求职助手，以“岗位匹配度”为主线串联职位管理、简历优化、学习清单、文本模拟面试与复盘回填，通过 GitHub MVP Spec 和 Issues 驱动需求拆解与验收。
……（共 10 个项目/经历段，提取完整，中文无乱码、数字/日期/URL 保真）
```

（全文 2,392 字符见 `.acceptance/raw-local-result.json` 的 `perPageRawText[].text`；本文件仅节选开头以控制篇幅。）

### 本地规则字段提取（parseResumeText）

| 字段 | 值 | 状态 |
| --- | --- | --- |
| 姓名 | （未提取到） | **missing** |
| 电话 | 13082624367 | text |
| 邮箱 | houxc2249@gmail.com | text |
| 性别 | 男 | text |
| 生日 | 2002-03 | missing（未映射） |
| 教育 | 山东科技大学·本科·软件工程·2020.09 ~ 2024.06 | text |
| 技能 | 工程能力/科研能力/其他能力（21 项分词） | text |

本地映射 Resume（draftToResume）：name=空、phone/email/education 完整、gender=男。
缺失字段（missingFieldsOf）：`name`（其余关键字段齐备）。

### 未映射内容（unmappedText）

```
其他能力 ：CET-6、普通话二级乙等
```

（该行被规则解析器判为未映射，保留原文待人工/Agent 确认。）

## 质量评估

| 维度 | 结果 |
| --- | --- |
| 乱码/替换字符 | **无**（全文中文/英文/数字均正常） |
| 行结构/段落 | 完整（保留换行与分节） |
| 字段保真 | 电话/邮箱/教育/GPA/排名/日期/URL 逐字正确 |
| 规则解析 | 姓名漏提取（页面为「侯 祥 晨」带空格，规则未命中）；生日未入 basics |
| 未映射 | 仅 1 行（CET-6 等），其余正文全部落入已解析结构或技能列表 |

## 结论（供 #85 决策）

1. **文本型 PDF 的本地识别质量已足够好**：2,392 字符零乱码，关键字段除姓名外全部命中；姓名因「侯 祥 晨」字间空格未被规则识别，属规则覆盖问题（可加一条规则：去除姓名字符间空白后匹配）。
2. Agent 的价值定位应为「规则漏网的补充」（如姓名、未映射行），而非替换本地识别——若 Agent 输出与本地冲突，应以原文为准（现有提示词已约束）。
3. 10s 目标：本地路径（无 Agent 等待）远快于 6.6s 的含 Agent 路径；若接受「先本地出草稿、Agent 后台补充」的交互，可同时满足速度与补齐。

## 复现

```
npm test -- src/main/services/__rawdump.test.ts   # 输出 .acceptance/raw-local-result.json
```
