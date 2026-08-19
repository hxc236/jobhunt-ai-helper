# PDF / DOCX 简历导入失败诊断报告（#88）

## 1. 结论摘要

本次“有的简历能导入，有的长期停在 Agent 结构化”的现象不是单一超时问题，而是两个独立缺陷叠加：

1. **部分中文 PDF 依赖外部 Adobe CMap，当前 pdfjs 没有加载 CMap 和标准字体资源。**
   - 这类 PDF 有文本层，并非扫描件；但文本层不内嵌 `ToUnicode`，只声明 `Adobe-GB1 / GB-EUC-H`。
   - 原实现 `getDocument({ data })` 无法把字形编码还原为中文，只在 stderr 写 warning，业务代码仍把乱码当作“解析成功”。
   - 乱码随后进入版面路由和 Agent，导致错误路由、字段规则失效以及模型请求长时间无结果。

2. **`resume_import` 使用了完整的 Pi Coding Agent 资源上下文。**
   - 虽然会话已关闭工具，但 `DefaultResourceLoader` 仍加载代码 Agent 的系统提示、项目 `AGENTS.md`、skills、prompt templates、themes 等资源。
   - 简历导入只是“文本 → JSON”的纯数据转换；无关代码上下文显著放大请求并干扰模型。
   - 在真实模型下，受影响样本 45–120 秒没有首个文本 delta；隔离资源后，三份真实样本均在约 8–15 秒内完成。

修复后：

- pdfjs 显式加载 `pdfjs-dist/cmaps` 和 `standard_fonts`；
- `resume_import` 使用独立最小 system prompt，禁用 skills、模板、主题、项目上下文，并关闭 thinking；
- 加入不含私人信息的 Adobe-GB1 合成 PDF 回归测试；
- 扩展真实 Pi SDK 冒烟测试，单独覆盖 `resume_import` 的 30 秒完成边界。

> 隐私：三份真实简历仅用于本机验证。报告只记录聚合指标和匿名样本编号；文件、路径、姓名、电话、邮箱和正文均未提交 Git。

---

## 2. 样本差异与失败原因

| 匿名样本 | 文件特征 | 修复前表现 | 直接原因 | 修复后实测 |
| --- | --- | --- | --- | --- |
| 样本 A | 2 页普通文本型 PDF，内嵌可用字符映射 | 能提取，但 Agent 约 19 秒，稳定性受完整代码上下文影响 | Pi 导入会话加载无关 coding-agent 资源 | 约 9.4 秒完成；Agent schema 通过 |
| 样本 B | 表格型 DOCX，mammoth 可提取段落/表格文字 | Agent 超过 35 秒，曾进入 timeout | 输出内容较长，同时加载无关 coding-agent 资源 | 约 14.2 秒完成；教育/项目/科研/荣誉/三类能力均进入 schema |
| 样本 C | 1 页文本型 PDF，Type0 中文字体，外部 Adobe-GB1 CMap，双栏坐标 | 中文文本变乱码；Agent 45–120 秒无首个文本 delta | pdfjs 缺 `cMapUrl`；随后 Agent 又受完整代码上下文拖慢 | 中文文本恢复；双栏坐标重排；约 7.8 秒完成 |

### 2.1 为什么“换一份 PDF 就不行”

PDF 的“看起来都能选中文字”不代表其内部编码方式相同：

- 样本 A 在 PDF 内提供了足够的 Unicode 映射，`getTextContent()` 可直接得到中文；
- 样本 C 只保存字符码和 `Adobe-GB1` 字体集合信息，需要 pdfjs 从外部 CMap 文件将字符码映射到 Unicode；
- 原测试 PDF 由 PDFKit 生成，都会嵌入可用的 `ToUnicode`，因此无法代表样本 C。

样本 C 修复前的明确运行证据：

```text
Warning: loadFont - translateFont failed:
Ensure that the cMapUrl API parameter is provided.
```

相同 PDF 的聚合结果：

| 配置 | 中文字符数 | 结果 |
| --- | ---: | --- |
| 原 `getDocument({ data })` | 0 | 空文本/乱码，不能用于结构化 |
| 加载 Adobe CMap | 780 | 中文文本恢复 |

### 2.2 为什么 Agent 看起来“卡死”

真实 Pi SDK 事件时间线显示，修复前不是 Vue 卡顿，也不是 IPC 丢事件：

```text
read → parse → map → agent → status(running)
```

之后 45–120 秒：

- `text_delta = 0`；
- 没有 `turn_end`；
- `session.prompt()` 不 resolve；
- 30 秒会产生 `agent_pending(timeout)`，但选择“继续等待”后没有第二个硬终止点。

最小健康请求“只回复 OK”约 1.5–1.9 秒完成，说明认证和模型服务可用。真正的差异是导入请求携带了：

- 完整简历文本；
- 完整 Resume schema 提示；
- Coding Agent 默认 system prompt；
- 项目 `AGENTS.md`；
- skills / prompt templates / themes 元数据。

将 `resume_import` 改为最小资源会话后，样本 C：

```text
首次 text_delta ≈ 1.0s
Agent done ≈ 7.8s
```

所以“卡住”是 **PDF 乱码输入 + 错误的 Agent 资源边界** 共同造成，而不是文件大小问题（样本 C 仅约 145 KiB）。

---

## 3. 精确代码定位

### 3.1 PDF 字符映射缺失

**原故障点**：`src/main/services/resume-parse.ts` 的 `extractPdfPages()`。

原逻辑：

```ts
getDocument({ data })
```

它只给 pdfjs 文件字节，没有提供 Node 环境所需的 CMap/字体资产。pdfjs 的 warning 不会抛到业务层，因此：

1. `loadingTask.promise` 正常完成；
2. `getTextContent()` 返回空串或伪 Unicode 乱码；
3. `ResumeParseError` 不会触发；
4. 错误文本继续流入路由和 Agent。

**修复位置**：

- `src/main/services/resume-parse.ts:28-38`：解析 `pdfjs-dist` 安装目录并构造资源路径；
- `src/main/services/resume-parse.ts:83-91`：传入：
  - `cMapUrl`；
  - `cMapPacked: true`；
  - `standardFontDataUrl`。

Node pdfjs 的资源路径必须使用 `/` 且以 `/` 结尾；代码显式做了 Windows 路径归一化。

### 3.2 Pi 导入会话加载了错误的上下文

**原故障点**：`src/main/services/pi-agent-provider.ts` 的 `createAppLoader()`。

原实现为所有 task 创建同一种 ResourceLoader，并统一注入 teach skill。`resume_import` 虽然在 `TASK_STRATEGIES` 中没有工具，但：

> `noTools` 只关闭工具，不会关闭 system prompt、AGENTS.md、skills、模板和上下文文件。

**修复位置**：

- `src/main/services/pi-agent-provider.ts:152-172`：创建会话时把 `task` 传给 loader；导入任务显式 `thinkingLevel: 'off'`；
- `src/main/services/pi-agent-provider.ts:201-230`：`resume_import` 使用隔离策略：
  - `noSkills: true`；
  - `noPromptTemplates: true`；
  - `noThemes: true`；
  - `noContextFiles: true`；
  - 专用最小 system prompt；
  - 保持 `noTools: 'all'`、`SessionManager.inMemory()`。

其他 optimize / interview / learn 任务保持原资源策略，避免扩大改动面。

### 3.3 Agent 超时与降级边界

`src/main/services/resume-import.ts:247-382` 负责：

1. 检查开关、认证和隐私同意；
2. 创建 `resume_import` 会话；
3. 发送结构化 prompt；
4. 30 秒无结果时发出 `agent_pending(timeout)`；
5. 用户可继续等待或终止 Agent 使用本地草稿；
6. 网络错误重试一次；
7. schema 非法时修正一次；
8. 仍失败则以明确原因降级。

先前 #87 已补 `createSession()` 阶段的超时；本次根因发生在 session 已创建、prompt 已 accepted 之后。通过缩小请求上下文，正常样本不再触发 30 秒分支。

### 3.4 IPC 与 UI 不是本次根因

事件链代码：

- 主进程事件转换：`src/main/index.ts:179-210`；
- IPC 请求入口：`src/main/ipc/index.ts:193-201`；
- UI 订阅与 token 过滤：`src/renderer/src/views/ResumesView.vue:198-244`；
- 核对 UI：`src/renderer/src/views/ResumesView.vue:904-956`。

真实 CDP 诊断确认主进程发出的 `agent_pending(timeout)` 能到达 renderer；因此本次没有通过增加 UI 定时器掩盖后端问题，而是修复上游文本和 Agent 会话。

---

## 4. 数据流

```text
用户选择 PDF / DOCX
  │
  ▼
ResumesView.onImportFilePicked
  │ IPC: resumes:import-start(filePath)
  ▼
ResumeImportService.start
  ├─ 扩展名 / 可读性 / 20 MiB 上限
  └─ 创建 token，异步 run(entry)
       │
       ├─ phase=read
       ├─ phase=parse
       │    ├─ DOCX: mammoth.extractRawText
       │    └─ PDF: pdfjs.getDocument
       │         ├─ CMap + standard fonts        ← 本次修复 1
       │         ├─ getTextContent
       │         └─ page text + x/y items
       │
       ├─ PDF routePdfPages
       │    ├─ 页面质量分析
       │    ├─ 双栏坐标重排
       │    └─ 必要时栅格化 + OCR
       │
       ├─ phase=map
       │    ├─ buildDraft / parseResumeText
       │    └─ draftToResume（本地 fallback）
       │
       ├─ phase=agent
       │    ├─ 隐私同意 / 配置检查
       │    ├─ Pi resume_import 隔离会话       ← 本次修复 2
       │    ├─ 文本 → Resume JSON
       │    ├─ extractJson
       │    ├─ assertValidResume
       │    └─ 必要时修正一轮 / 降级
       │
       └─ event: resumes:import-done
            │
            ▼
ResumesView.openImportEditor
  ├─ 左：提取全文
  ├─ 右：Agent 最终 Resume JSON
  └─ 用户编辑并点击“确认并创建基准简历”
            │ IPC: resumes:import-confirm
            ▼
ResumeImportService.confirm
  └─ ResumeService.createImported
       ├─ schema 再校验
       ├─ 强制基准简历关系为空
       ├─ 重名追加 (1)/(2)…
       └─ SQLite 入库，仅保存溯源，不保存原始全文
```

---

## 5. 业务流程与失败语义

| 阶段 | 成功产物 | 失败/降级行为 |
| --- | --- | --- |
| 选文件 | 本地路径 | 不支持类型、不可读、超 20 MiB：立即提示 |
| 文档读取 | DOCX 文本或 PDF pages | 损坏、加密、PDF 超 10 页：明确 error |
| PDF 字符还原 | 正确 Unicode 文本 | 外部 CMap 现在由 pdfjs 资源恢复 |
| 页面路由 | text / reflowed / OCR | 低质量页标记风险；OCR 失败给明确错误 |
| 本地映射 | 最低可编辑 Resume | Agent 不可用时保底，不阻止人工录入 |
| Agent 结构化 | schema 合法 Resume | 未配置、拒绝隐私、网络失败、超时、非法输出：显示原因并降级 |
| 人工核对 | 可编辑草稿 | 不确认不入库 |
| 确认 | 新基准简历 | schema 不合法时阻止；重名自动加序号 |

本次修复遵守业务边界：Agent 仍只获得提取文本、没有文件系统工具、会话不落盘，最终仍需人工确认。

---

## 6. 为什么原测试全部通过却漏掉真实问题

### 6.1 PDF fixture 覆盖偏差

`resume-parse.test.ts` 和导入测试使用 PDFKit + Windows 中文字体生成 PDF。该类夹具内嵌可用 Unicode 映射，因此只覆盖：

```text
有 ToUnicode 的常规 PDF → pdfjs 提取成功
```

没有覆盖：

```text
Type0 CJK font + Adobe-GB1 external CMap + no embedded ToUnicode
```

本次新增 `buildExternalCMapPdf()`，以脱敏文字构造后一种 PDF。修复前测试稳定失败（提取文本为空），修复后恢复中文。

### 6.2 Fake Agent 与真实 Pi SDK 不同

`resume-import-agent.test.ts` 使用 `FakeAgentProvider`：

- `createSession()` 立即完成；
- 不创建 `DefaultResourceLoader`；
- 不加载 AGENTS / skills / system prompt；
- 延迟只是固定 `delayMs`；
- 回复是测试中立即返回的 JSON。

所以它能验证业务编排、schema 修正和降级，却不能发现真实 Pi 资源上下文造成的请求膨胀。

### 6.3 缺少跨格式真实冒烟性能边界

原 `agent.smoke.test.ts` 覆盖 optimize / interview / learn，没有单独覆盖 `resume_import`。本次加入：

- 脱敏简历文本；
- 真实 Pi SDK；
- 30 秒完成边界；
- 默认跳过，仅在显式 `AGENT_SMOKE=1` 时调用真实模型。

### 6.4 自动化与真实文件的隐私边界

真实简历不能提交为 fixture，这是正确约束；但此前没有用“匿名合成的同类 PDF 编码结构”替代私人 fixture。正确做法不是提交真实文件，而是从失败文件提炼格式特征后构造最小脱敏夹具，本次已补齐。

---

## 7. 验证结果

### 7.1 本机真实样本（不入 Git）

| 样本 | 提取/路由 | Agent 终态 | 端到端到草稿耗时 |
| --- | --- | --- | ---: |
| A：普通文本 PDF | 2 页；文本有效 | used=true，schema 通过 | ~9.4s |
| B：表格 DOCX | mammoth 文本有效 | used=true，schema 通过 | ~14.2s |
| C：Adobe-GB1 PDF | 中文恢复；双栏 reflowed；parsePath=text | used=true，schema 通过 | ~7.8s |

样本 C 修复后的结构数量（仅用于确认不是空结果）：教育 2、项目 3、实习 2、荣誉 2、能力 2。模型输出存在非确定性，产品契约按用户确认采用“schema 校验 + 人工核对”，不对条目数量做硬编码。

### 7.2 自动化验证面

- 新增 Adobe-GB1 外部 CMap PDF 回归；
- 保留 DOCX/PDF、逐页路由、OCR adapter、Agent 成功/失败/超时/修正、确认入库测试；
- 真实 Pi `resume_import` 冒烟测试为 opt-in；
- 私人样本和诊断全文未进入仓库。

---

## 8. 后续风险

1. **扫描型 PDF** 仍依赖 Windows 中文 OCR 语言能力；这与本次“有文本层但需 CMap”的问题不同。
2. **模型服务网络波动** 仍可能触发 30 秒 timeout；用户可改用本地草稿，不能保证第三方 API 永不超时。
3. **Agent 语义归类具有非确定性**；schema 校验保证结构合法，事实完整性仍由核对 UI 和人工确认兜底。
4. **生产打包** 必须保留 `pdfjs-dist/cmaps` 和 `standard_fonts`。当前主进程将 pdfjs 作为外部依赖解析，开发/构建验证会检查资源路径；若未来改 ASAR 打包策略，需要把这两个目录加入资源清单。
