# 简历导入流水线详解：目标 / 做法 / 产出（#85）

> 依据代码事实（primary source = 本仓库实现）：`src/main/services/resume-parse.ts`、
> `resume-import.ts`、`pdf-routing.ts`、`pdf-page-quality.ts`、`pdf-raster.ts`、`ocr-import.ts`。
> 实例数据来自 `docs/benchmarks/local-no-agent-zhangwei.md`（AI全栈工程师.pdf 实测）。

## 流程总览

```
选择文件 → ①pdfjs 文本层提取 → ②逐页路由（质量分析→文本/双栏重排/OCR）
→ ③本地规则映射（字段来源+未映射）→ ④Agent 结构化（约束只映射原文）
→ 确认建新基准简历
```

| 环节 | 输入 | 输出 |
| --- | --- | --- |
| ① 文本层提取 | 文件路径 | `PdfPageText[]`（每页 text + 字符坐标 items） |
| ② 逐页路由 | 每页 text/items/视觉信号 | `routed[]`（text/reflowed/ocr + risk）、parsePath |
| ③ 本地规则映射 | 路由后的全文 | `ResumeDraft`（fields/fieldStatus/missingFields/unmappedText）+ 本地 Resume |
| ④ Agent 结构化 | 提取全文（只读原文） | Agent Resume（schema 校验通过）或降级原因 |

---

## ① pdfjs 文本层提取（`extractPdfPages`）

**目标**：对「有文本层的数字 PDF」零 OCR、零识别错误地取出全文——快、准、保真。

**怎么做**：
- `pdfjs-dist getDocument → getPage → getTextContent`，逐页遍历；
- 逐 item 拼接文本：`hasEOL`（pdfjs 行分隔判定）→ 换行，否则空格——**保留原始行结构**；
- 同时保留每个字符的坐标 `transform[4]/[5]`（x/y）到 `items`，供双栏重排使用；
- 边界：加密 → `encrypted`；损坏 → `read-failed`；页数 > 上限（10 页）→ `too-many-pages`。

**得到什么**：`PdfPageText[]` = `{ pageNo, text, items[] }`。
实测（AI全栈工程师.pdf）：2 页，1400/992 字符，**零乱码**，姓名/电话/邮箱/日期/URL 逐字正确。

**局限**：只取文本层——扫描页（无文本层）提取为空；表格结构、阅读顺序均不在此环节处理。

---

## ② 逐页路由（`routePdfPages` + `analyzePageQuality` + `reflowTwoColumn` + `normalizeExtractedText`）

**目标**：对每一页独立决策「走文本 / 坐标重排 / OCR」，避免好的文本页被 OCR 污染、也避免扫描页被当文本空转；OCR 后复检，把风险暴露给用户。

**怎么做**（每页）：
1. **质量分析** `analyzePageQuality`：
   - **硬异常**（任一命中 → 直接 OCR）：无文本但有视觉内容、替换字符/U+0000、控制/私用区字符占比 ≥5%、有视觉但文本 <30 字符；
   - **软异常**（累计风险分，初始阈值 #79）：低有效字符比例（<70% → 30 分）、文本稀疏但页面丰富（<120 字符 → 30 分）、连续单字断裂（→20 分）、双栏坐标分布（→25 分）、关键格式异常/重复截断（→15 分）；
   - 阈值：**总分 ≥40 → OCR；15–39 → 保留文本标记 pending；<15 → 正常文本**（阈值是待基准校准的初始值，非行业常量）。
2. **双栏优先坐标重排**：当软异常含 two-column-order 且 items ≥8 → `reflowTwoColumn` 按 x 中位切左右栏、y 容差 8pt 分行、交替合并两栏行 → 重排后**复检**，仍异常才转 OCR。
3. **OCR 路径**：无文本层/异常页 → 栅格化（隐藏 BrowserWindow + pdfjs canvas 渲染 PNG，`pdf-raster.ts`）→ `Windows.Media.Ocr` 中文识别（`ocr-import.ts`）→ OCR 后复检，仍异常标记 `low-confidence`。
4. **安全归一** `normalizeExtractedText`：只改形式不改事实——全角空格→空格、全半角标点映射、带「年月日」标记的日期形式归一；**裸 YYYY.MM 小数绝不动**。

**得到什么**：`routed[] = { pageNo, text, source: 'text'|'ocr', risk? }`；合并成 `parsePath`：全文本 `text` / 全 OCR `ocr` / 混合 `mixed`；逐页风险 `pageRisks`（pending/low-confidence/reflowed/ocr-needed）在核对面板展示。

**已知边界**：OCR 引擎依赖系统中文语言包（本机缺 → ENGINE_FAIL 明确报错，非崩溃）；栅格化窗口曾因 electron-vite 模板污染与就绪竞态报「Script failed to execute」，均已修复（#84）。

---

## ③ 本地规则映射（`buildDraft` / `parseResumeText` / `draftToResume`）

**目标**：不依赖模型，用**确定性规则**把文本映射为简历字段；每字段标注来源状态；Schema 表示不了的条目原样保留（不静默丢弃、不硬塞）。

**怎么做**：
- `parseResumeText`（正则，弱启发优先保真）：
  - 姓名：首行且为 2–4 个中文字符、排除「XX简历/求职」类标题行；
  - 电话：`1[3-9]x` 大陆手机号（兼容 `-`/空格分隔）→ 归一纯数字；
  - 邮箱、性别（性别:男/女）、生日（出生日期/生日/出生年月 后 YYYY-MM）；
  - 教育：含 本科/硕士/博士/大学/学院 的行 → `{school, degree, major?, period}`（去重，period 支持 `~`/`-`/至今）；
  - 技能：技能/掌握/熟悉 节下行 → 分词去重（上限 30）；
- `fieldStatus`：每字段 `text`（有值来自文本）或 `missing`（无值）——**无整体置信度，逐字段证据**（#76）；
- `extractUnmappedLines`：证书/CET/四六级/普通话/校园经历/社团 等 Schema 无法表示的条目 → `unmappedText` 保留原文；
- `draftToResume`：字段 → 可编辑 Resume（basics/education），缺失字段清单 `missingFieldsOf`（name/phone/email/education 四项用于 UI 待确认）。

**得到什么**：`ResumeDraft` = `{ fields, fieldStatus, missingFields, unmappedText, text, scanned, parsePath }` + 本地 Resume。
实测：phone/email/education/gender 全命中；**姓名漏提取**（「侯 祥 晨」字间空格不满足首行规则）、生日未入 basics、1 行未映射（CET-6 等）。

**局限**：规则覆盖有限——排版变体（字间空格、竖排、图标化排版）易漏；这是 Agent 环节存在的意义。

---

## ④ Agent 结构化（`structureWithAgent` / `buildStructurePrompt` / `parseStructured`）

**目标**：用模型补规则的漏网（姓名、未映射归位、多段教育/技能结构化），但**只映射原文、禁止虚构**；任何失败都必须降级回本地草稿，不阻塞导入。

**怎么做**（完整决策链，均可降级）：
1. 前置检查：未启用 / 未配置模型 → 直接返回 `agent-disabled` / `agent-not-configured`（用本地草稿）；
2. 隐私同意：首次使用发 `agent_pending(consent)` 等用户答复（#84 后 decide IPC 可用）；拒绝 → `consent-declined`；
3. 创建 `resume_import` 会话（无工具、inMemory），提示词 `buildStructurePrompt` 硬约束：
   - 只映射/归一/组织原文证据，禁止补写、润色、虚构；
   - 姓名/电话/邮箱/学校/日期/数字必须与原文一致，不得猜测修改；
   - 原文无法表示的条目（证书/语言成绩等）忽略，不得塞字段；
   - 输出须符合 schema（basics.name 必填、education 非空、skills 三分类）；
4. 输出解析 `extractJson` → `assertValidResume` schema 校验；非法 → `buildRepairPrompt` 携带问题定位**修正一轮**；仍非法 → 降级；
5. 网络类暂时错误（ECONN/timeout/5xx）**重试一次**；仍失败 → 降级 `agent-failed`；
6. 等待超阈值（30s）→ `agent_pending(timeout)`，用户选「继续等待 / 使用本地草稿」；选本地 → 立即出草稿；
7. 通过后 `fieldStatus` 相应字段标记 `agent`（替代 text 来源），草稿与 Resume 以 Agent 结果为准。

**得到什么**：
- 成功：Agent 结构化 Resume（schema 已校验）+ 草稿字段来源更新为 agent；
- 任何失败路径：**保留本地草稿 + 明确降级原因**（UI 核对面板展示），导入不中断；
- 隐私：会话 inMemory，不落盘原文；设置可整体关闭（`agent.importEnabled`）。

实测（AI全栈工程师.pdf，同意后）：6.6s 完成全链，Agent 补出姓名等规则漏网字段，全程 <10s。

---

## 关键取舍（#85 决策用）

| 维度 | 现状 | 可改进方向 |
| --- | --- | --- |
| 文本层提取 | pdfjs，准 | PyMuPDF 可更快/更全（表格 bbox） |
| 扫描件 | 仅 Windows.Media.Ocr（依赖语言包） | RapidOCR（ONNX）离线中文更强、不依赖系统包 |
| 版面 | 仅坐标双栏重排 | 版面分析模型（DocLayout-YOLO/RapidLayout）可覆盖多栏/页眉页脚 |
| 本地规则 | 姓名空格等缺口 | 补「去空格姓名」规则即可全字段命中 |
| Agent | 只映射原文、降级完备 | 保持；可做「本地先出、Agent 后台补齐」交互提速 |

## 复现

- 本地基准：`npm test -- .acceptance/raw-local-extract.test.ts`（见 `docs/benchmarks/local-no-agent-zhangwei.md`）
- 全链路测试：`src/main/services/resume-import*.test.ts`（467+ 测试覆盖）
