# 功能规格（tickets 切分输入）

> 工作文档：从 spec #13 移出的功能级规格，作为 to-tickets 的现成输入（一条功能点 = 一条 ticket 骨架）。
> 来源：spec #13（2026-08-12 修订版）。

## 功能规格（Feature Specs）

> 功能点 = 一个 session 能确定完成的小功能。每条含：行为（输入→输出）、规则（决策引用）、验收（可测试/可操作）。
> User Stories 是用户视角的总纲，本节是可执行的切分依据。工程功能（EF）为技术组件，无用户行为。

### EF 工程功能

**EF-01 项目脚手架**：行为：初始化 Electron + Node/TS(ESM) + Vue3 + Vite + vitest 工程，main/renderer/shared 三目录，窗口启动，一条示例 IPC（ping）。验收：`dev` 起窗口；ping 往返；vitest 示例测试绿。

**EF-02 db 层与 migrations**：行为：better-sqlite3 连接封装（`:memory:` 可注入）、`PRAGMA user_version` + 有序 SQL 数组迁移机制、settings 表。验收：迁移递增生效；注入内存库测试；重启不重跑已应用迁移。

**EF-03 IPC 协议框架**：行为：shared/protocol.ts 类型化通道定义 + contextBridge 封装 + 渲染侧 api 客户端（channel→方法）+ 主→渲染事件推送。验收：类型化调用通过；事件送达；无类型绕过。

**EF-04 AgentService（pi SDK 封装）**：行为：`createAgentSession` 封装（ModelRuntime 应用自有目录认证）；provider 抽象（真实 pi SDK / fake 可注入）；事件流（text_delta/status/error）转发；任务类型：optimize / interview / learn。验收：fake provider 全流程测试绿；真实 SDK 手动冒烟通过。

### F 职位模块

**F-01 职位录入**：行为：表单（公司/岗位/企业性质/JD/城市/渠道/渠道链接/网申起止/批次/备注）→ 校验 → 创建职位卡并生成 dedupe_key。规则：必填=公司+岗位；企业性质枚举（央企/国企/大厂/私企/外企/事业单位/其他）；dedupe_key=company|title|recruit_season（#5）。验收：提交后列表可见；缺必填有提示；重复公司+岗位提示。

**F-02 职位列表**：行为：职位行（公司/岗位/倒计时徽标/性质 pill/状态 pill）+ 四维筛选（企业性质/批次/投递状态/秋招季）+ 空状态。规则：≤14 天倒计时红标；无 end_date 显「待核实」。验收：筛选正确；倒计时正确；空状态引导。

**F-03 职位详情**：行为：详情页（JD 全文/渠道链接/匹配度概览占位/操作区：优化·清单·面试·投递）。验收：JD 完整显示；操作按钮可达。

**F-04 职位编辑/删除**：行为：编辑任意字段（保存更新 updated_at）；删除职位卡（级联删投递记录）。验收：编辑生效；删除确认；级联删除正确。

**F-05 投递状态服务**：行为：applications 表 + 状态机（planned→applied→interviewing→offer/rejected，withdrawn 任意态）+ 投递时间/渠道记录。规则：状态非法流转拒绝（#5）。验收：全流转服务测试绿。

**F-06 投递状态 UI**：行为：详情内状态操作按钮组 + 投递记录列表（时间/渠道/状态）+ 按状态筛选联动。验收：操作后列表徽标更新；记录可见。

**F-07 采集执行框架**：行为：CrawlService（隐藏 BrowserWindow fetcher 抽象）执行采集：模式（筛选/全量）+ 节流（≥2s）+ 重试（2 次退避）+ 上限（100 条截断）+ crawl_runs 留痕。规则：ADR-0006。验收：fake fetcher 下执行流程测试绿；留痕记录正确。

**F-08 牛客解析器**：行为：牛客校招日程列表/翻页/详情页 DOM → 职位字段映射（company/title/channel/start_date/end_date/city/source_url）。规则：解析器与抓取分离，纯函数。验收：HTML fixture 映射测试绿（含缺字段场景）。

**F-09 猎聘解析器**：行为：猎聘 campus SSR 列表 → 字段映射（end_date 置 null）。规则：同 F-08 分离。验收：fixture 测试绿。

**F-10 采集预览确认**：行为：预览页（「将新增 N / 更新 M / 缺字段 K」摘要 + 候选勾选 + 缺字段标记）→ 确认 → upsert 入库（URL 优先 + dedupe_key 兜底，命中更新不新建）。验收：预览统计正确；确认后入库与去重正确（服务测试 + UI 操作）。

**F-11 采集入口与留痕查看**：行为：采集触发入口（源选择/模式/筛选输入）+ 留痕列表（来源/模式/数量/时间/状态）。验收：触发流程可用；留痕可见。

### F 简历模块

**F-12 简历 schema 与 CRUD**：行为：resume.schema.json（#7 定稿，来自 prototype/resume-model）+ 多份基准简历 CRUD + schema 校验 + 删除语义（基准删除不影响已存派生稿）。验收：校验拒绝非法 JSON；删除语义服务测试绿。

**F-13 简历编辑器 UI**：行为：分节表单（基本信息含国企字段/教育/技能/项目/实习/证书/自评/链接）+ 简历列表（基准分组/派生分组）+ JSON 模式切换。验收：表单增删条目；保存后校验错误定位。

**F-14 A4 渲染与 PDF 导出**：行为：A4 模板渲染（printToPDF）+ 导出文件对话框。验收：打印样式正确；PDF 可打开。

**F-15 上传解析 docx**：行为：mammoth 解析 .docx → 文本 → 结构化草稿（置信度标记）。验收：样例 docx 解析测试绿。

**F-16 上传解析 pdf**：行为：pdfjs-dist 解析 .pdf → 文本 → 结构化草稿。验收：样例 pdf 解析测试绿（含双栏/扫描件失败降级提示）。

**F-17 解析草稿确认**：行为：草稿确认界面（逐节核对/修正）→ 确认后存为基准简历。规则：草稿不入库（#7）。验收：确认前库中无数据；确认后可见。

### F 匹配度与优化

**F-18 规则 JD 关键词提取**：行为：JD 文本 → 关键词/技能清单（规则层，中文分词 + 别名归一化如 Spring Boot→Spring）。验收：样例 JD 提取测试绿。

**F-19 ScoreEngine 打分器**：行为：输入（jd_analysis + 简历 JSON）→ 5 维度加权分（关键词25/技能25/项目20/经历15/学历15）+ 命中/缺失依据清单。规则：ADR-0004；无 LLM 依赖。验收：边界测试（空简历/JD 无关键词/全命中）绿。

**F-20 优化 JD 解析轮**：行为：LLM 解析 JD → jd_analysis（skills/keywords/requirements/hardRequirements）→ 缓存 positions.jd_analysis（JD 变更失效重算）。验收：fake provider 下解析+缓存测试绿。

**F-21 优化评估轮**：行为：LLM 基于规则分 + 简历逐节缺口评估 → 短板清单。验收：fake 测试绿。

**F-22 优化生成轮**：行为：LLM 生成优化稿（完整 resume JSON，meta.baseResumeId/targetJobId 已填）+ changes[]（位置/原样/改后/理由）；optimizationMode strict 默认；输出过 schema 校验。规则：不虚构（#9）。验收：fake 测试 + 校验测试绿。

**F-23 匹配度仪表**：行为：环形总分 + 5 维度条 + 依据清单展开。验收：分数与依据一致。

**F-24 并排对比视图**：行为：左基准/右优化稿，改动行高亮 + 理由气泡 + LLM 建议卡。验收：diff 高亮正确。

**F-25 优化触发与确认入库**：行为：触发（选职位+基准+模式）→ 三轮进度流式展示 → 编辑 → 确认 → 派生稿入库（多职位多稿）。规则：确认前不入库（#9）。验收：完整走通；未确认不落库。

### F 学习模块

**F-26 topics 清单生成**：行为：jd_analysis + 简历缺口 + 项目 techStack → topics（优先级 1-5：硬性/提及/缺口/项目/手动；来源标记 jd/resume-gap/project/manual/interview）；无缺口时降级生成。验收：生成+优先级+去重+降级测试绿。

**F-27 学习清单 UI**：行为：分组展示（按优先级/状态）+ 增删改 + 三态切换 + 降级提示。验收：操作生效。

**F-28 teach 聊天会话**：行为：点条目 → AgentService learn 任务（cwd=教学工作区、continueRecent 续接、/skill:teach）→ 聊天流式 UI。规则：ADR-0002。验收：fake 下会话流程测试；真实 teach 手动冒烟。

### F 面试模块

**F-29 面试会话骨架**：行为：InterviewService start（注入 jd_analysis/优化简历/learned 清单）/ answer / interrupt / end + transcript 落库（interviews 表）。规则：一次面试一个长驻 session；steer/followUp（#10）。验收：fake provider 全流程测试绿。

**F-30 四阶段与风格**：行为：开场/技术面（硬性要求→项目深挖→learned 检验）/反问/收尾；动态难度（答好深挖/答不出降级）；风格 real/coach/strict。验收：fake 下阶段推进与风格差异测试绿。

**F-31 面试会话 UI**：行为：对话流（打字机）+ 风格选择 + 打断按钮 + 文字输入兜底 + PTT 按钮（先占位）。验收：文字输入可完成一场面试。

**F-32 AsrService 接入**：行为：PTT 录音（MediaRecorder）→ sherpa-onnx 流式识别 + VAD 切句 → 文本入会话；缺模型时降级文字输入提示。规则：ADR-0007。验收：接口 fake 测试绿；真实识别手动冒烟；降级路径可用。

**F-33 复盘生成**：行为：结束面试 → LLM 生成复盘 JSON（总分 + 4 维度 + 亮点 + 薄弱点[含参考回答] + 下一步）→ 存 interviews.review。验收：fake 下生成+结构校验测试绿。

**F-34 复盘展示与回填**：行为：复盘视图（总分环/维度/薄弱点/参考折叠/下一步）+ suggestLearn 一键入 topics（source=interview）+ 历史回看（对话+复盘）。验收：回填生成条目；历史列表+详情可用。

### F 简历内容优化（业务①，#90，与按 JD 优化独立）

**F-35 内容优化任务骨架（T02）**：行为：基准简历行「内容优化」入口 → ContentOptimizeService 异步任务（状态机 `created→diagnosing→awaiting_answers→rewriting→ready_for_review→confirmed`；failed 手动重试、cancelled 续接或作废、应用重启自动恢复中断轮次）；LLM 轮次全局串行队列（每轮超时 60s、重试 1 次）；任务记录存 `content_optimize_tasks` 独立存储；首次触发自动补齐项目稳定 ID/≤4 条要点/sectionOrder（#91）；空诊断（全部保持）→「无需修改」不创建新版本；事件 `content-optimize:changed` 实时推送阶段流转。E2E 基建：`JOBHUNT_FAKE_AGENT=1` 假 agent + 真实启动 Electron + CDP 鼠标/键盘驱动 + 截图/无障碍快照断言 + 落库断言。规则：#90-27（只对基准简历开放）、#90-21（确认后成为新基准简历）。验收：状态机/重试/取消续接/单基准单草稿/持久化单测绿；E2E 冒烟（`npm run e2e:content-optimize`）通过。

**F-36 确认、对比与整合（T06）**：行为：改写完成进入可确认后，逐项目对比确认区（接受改写/保留原文；删除建议「确认删除/保留原文+警告」）；推断-待确认改动（`source=inferred`）须显式勾选「确认纳入最终版」（含节级非项目改动）后才可确认（US17）；确认时服务端整合：接受项目采用改写稿、拒绝项目保留原文且不阻塞其他项目、拒绝删除项目留在原位置（US15/18/19）、标点/排序自动修复仅计入实际采纳改动；最终稿与原文无差异（`resumesDiffer` 键序无关深度比较）时不创建新版本（US20）；确认后生成新基准简历（#90-21），任务卡片保留整合汇总（标点修复/顺序调整/删除/保留原文警告/仍有未解决项目）。setReview 决策与推断勾选落库（`decisions_json`/`inferred_confirmed_json`，migration v12）。验收：确认/门禁/整合纯函数单测绿；E2E questions 场景含确认区断言通过。

