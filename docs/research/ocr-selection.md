# OCR 技术选型调研（2025–2026）：方法对比与 PDF 识别管线现状

> 调研对象：#85「导入 PDF 到出结果」流程优化决策。覆盖：现代 OCR 主流方法多角度对比、
> 业界「PDF → 结构化结果」管线现状、本项目当前流程对照与选型建议。
> 主要来源为各项目官方仓库/文档（primary sources），链接随文标注。

## 1. 方法分类

当前「文字识别」实际是三个层次的竞争：

| 层次 | 代表 | 特点 |
| --- | --- | --- |
| A. 传统本地引擎 | Tesseract 5、Windows.Media.Ocr | 轻量、离线、CPU 可跑；中文精度中等偏下；无版面理解 |
| B. 深度学习本地管线 | PaddleOCR（PP-OCRv5/PP-StructureV3）、Surya、EasyOCR、RapidOCR | 检测+识别+版面+表格+公式的完整管线；中文强；可离线 |
| C. 视觉大模型 / 云 API | Qwen2.5-VL、GPT-4o、Gemini、Claude、Kimi、Mistral OCR、百度/腾讯云 OCR | 「端到端文档理解」，版面/表格/公式/手写通吃；需网络/API Key/成本 |

## 2. 多角度对比

### 2.1 本地引擎（A 层）

| 引擎 | 中文准确率 | 速度 | 部署 | 版面/表格 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **Tesseract 5**（LSTM，chi_sim） | 中（干净印刷体可用） | CPU 快 | 需装语言包 | 无 | 官方 tessdoc 说明语言数据为独立 Data Files；中文需 `chi_sim.traineddata`（[tessdoc/Data-Files](https://github.com/tesseract-ocr/tessdoc/blob/main/Data-Files.md)） |
| **Windows.Media.Ocr** | 中（微软中文引擎，依赖语言包） | 快（系统级） | 仅 Windows，需安装 zh-Hans OCR 语言包 | 无（返回行/词+坐标） | 微软官方：`OcrEngine.RecognizeAsync` 返回按行、按词的文本与位置，`AvailableRecognizerLanguages` 列出可用语言（[learn.microsoft.com](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)） |
| **EasyOCR**（PyTorch） | 中高 | 慢（模型大） | Python+PyTorch | 无 | 适合多语种快速原型（[github.com/JaidedAI/EasyOCR](https://github.com/JaidedAI/EasyOCR)） |

### 2.2 深度学习管线（B 层）

| 工具 | 中文准确率 | 速度 | 版面/表格/公式 | 部署 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **PaddleOCR / PP-OCRv5** | 高（中文为第一优先） | GPU 检测 70–90ms/页，CPU 380ms/页 | PP-StructureV3：版面+表格+公式+阅读顺序 | Python+Paddle，可导出 ONNX | 官方 benchmark：`PP-OCRv5_server_det` 检测 Hmean 83.8%，GPU 89.55ms、CPU 383ms（[PP-OCRv5.md](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5.md)） |
| **Surya 2**（datalab-to） | 高（多语种 91 语言整体 87.2% pass rate） | 需 GPU 效果好 | 检测+识别+版面+表格+阅读顺序 | Python（torch） | 官方多语种基准：91 语言 32,055 测试、pass rate 87.2%（[surya/benchmark](https://github.com/datalab-to/surya)） |
| **Marker**（Surya 全家桶） | 高 | 慢（每页多模型） | PDF→Markdown，含公式/表格 | Python | 定位「PDF → 干净 Markdown」（[github.com/VikParuchuri/marker](https://github.com/VikParuchuri/marker)） |
| **RapidOCR**（onnxruntime） | 高（复用 PP 模型） | 快 | 部分 | 轻量 ONNX，易嵌入 | 适合无 Python 环境的集成 |
| **版面分析组件** | — | — | DocLayout-YOLO（中文文档版面检测）、RapidLayout `pp_layout_cdla` 支持正文/标题/表格/图注 | ONNX | [RapidLayout 文档](https://rapidai.github.io/RapidLayout/main/)；[DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) |

### 2.3 视觉大模型 / 云 API（C 层）

| 方案 | 中文/文档能力 | 输出 | 成本/依赖 | 备注 |
| --- | --- | --- | --- | --- |
| **Qwen2.5-VL** | 很强：官方称多语言文档、表格、图表、公式、手写全覆盖；OCRBenchV2 等成绩优于 GPT-4o/Gemini Flash/Claude 3.5 | 文本/JSON | 开源权重（可本地）或 DashScope API | 官方技术报告：[arxiv 2507.05595](https://arxiv.org/abs/2507.05595) |
| **GPT-4o / Gemini / Claude** | 强；Gemini 原生支持 PDF 输入 | 文本/JSON | API Key + 计费；**Gemini 2.0 系列已关停**（[changelog](https://ai.google.dev/gemini-api/docs/changelog)） | 隐私=内容发云端 |
| **Mistral OCR** | 强（文档优化） | 结构化文本 | API | 面向文档理解 |
| **Kimi / 通义 / 百度 / 腾讯云** | 中文强 | 文本/JSON | API | 国内合规/延迟友好 |

### 2.4 横向结论

- **中文纯文字识别精度**：PaddleOCR（PP-OCRv5）≈ Surya 2 > 视觉大模型（文档任务）> EasyOCR > Windows.Media.Ocr ≈ Tesseract（干净印刷体尚可）。
- **结构化/版面**：视觉大模型（端到端）≈ PP-StructureV3/MinerU/Docling（管线）> 纯 OCR（无版面）。
- **离线/隐私**：A/B 层全离线；C 层需网络（开源权重本地部署除外，但显存要求高）。
- **成本**：A/B 免费；C 层按量计费。
- **集成难度（Windows 桌面/Electron）**：Windows.Media.Ocr 最简单（系统 API）但中文依赖语言包；Tesseract 有现成 WASM/Node 绑定；PaddleOCR/RapidOCR 需 ONNX 运行时嵌入；视觉大模型走 HTTP。

## 3. 业界「PDF → 结果」管线现状

主流做法 = **分层决策**：能取文本层就绝不 OCR；缺文本层才栅格化 OCR；最后用版面模型恢复阅读顺序与结构。

1. **文本层提取**：PyMuPDF `Page.get_text()` / pdfplumber / pdfjs —— 快、准、零识别错误；盲区是表格结构、无文本层扫描件（[PyMuPDF 文档](https://pymupdf.readthedocs.io)）。
2. **栅格化 + OCR**：`pdf2image`/pdfjs 渲染 → Tesseract/PaddleOCR/Windows OCR —— 只用于扫描页。
3. **完整管线（开源事实标准）**：
   - **MinerU**（上海 AI Lab）：PyMuPDF 解析结构 + PaddleOCR 识别 + DocLayout-YOLO/LayoutLMv3 版面 + 公式/表格重建，输出 Markdown/JSON（[github.com/opendatalab/MinerU](https://github.com/opendatalab/MinerU)）；
   - **Docling**（IBM）：LayoutModel + TableFormer 表格 + 可插拔 OCR，输出 Markdown/HTML/JSON（[github.com/docling-project/docling](https://github.com/docling-project/docling)）；
   - **Marker/Surya**：检测+识别+版面+表格+阅读顺序 → 干净 Markdown（[marker](https://github.com/VikParuchuri/marker)）；
   - **PaddleOCR PP-StructureV3 / PP-ChatOCRv3**：版面+表格+公式+文档问答一体（[PP-StructureV3](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PP-StructureV3.md)）。
4. **视觉大模型直接读 PDF**：Qwen2.5-VL/Gemini/GPT-4o 直接把 PDF/页面图喂进模型，端到端输出结构化结果——管线最简，但隐私与成本是硬约束。

**业界共识**（多来源一致）：优先原生文本层提取，OCR 只兜底缺失/低质量页面，不要默认整份栅格化；中文复杂版面首选 PaddleOCR 系或 MinerU。

## 4. 本项目当前「导入 PDF → 出结果」流程（#73/#82 实现）

```
选择文件 → resume-import.start
  ├─ 读文件（≤20MB，页数≤10）
  ├─ extractPdfPages：pdfjs 提取文本层（页码标记 + 字符坐标 items）
  ├─ routePdfPages 逐页智能路由（#82）：
  │    质量分析（硬异常/软分阈值 40/15）→
  │      文本页 → 直接文本；双栏页 → 坐标重排 reflowTwoColumn
  │      扫描/异常页 → 栅格化（pdf-raster 隐藏窗口 pdfjs→PNG）→ Windows.Media.Ocr
  │      （本机缺 zh-Hans 语言包 → ENGINE_FAIL blocker）
  ├─ draftToResume：本地规则映射（字段级来源状态 + 未映射原文）
  └─ Agent 结构化（#77，可降级）：提示词约束「只映射原文」→ schema 校验→修正一轮
        （#84 遗留已修：decide IPC 补注册；#85 决策中：本地 vs Agent 结果取舍）
确认 → 建新基准简历（不入库覆盖）
```

现状评价：流程分层合理（文本优先、OCR 兜底、Agent 只做约束映射）；主要短板是
① OCR 引擎只有 Windows.Media.Ocr 且依赖语言包；② 无版面分析（多栏/表格靠坐标重排，能力有限）；
③ 姓名规则漏提取（#85 本地基准已记录「侯 祥 晨」案例）。

## 5. 针对本项目的选型建议（供 #85 决策）

| 方案 | 改动量 | 收益 | 代价 |
| --- | --- | --- | --- |
| **保持现状 + 装语言包** | 0 代码 | 立即可用 | 中文精度中等；无版面 |
| **接入 RapidOCR（ONNX）** | 中（替代/并列 Windows OCR） | 中文强、离线、不依赖系统语言包 | 新增 ~数十 MB 模型 + ONNX 运行时 |
| **接入 PaddleOCR PP-StructureV3 子集** | 大 | 版面/表格/公式全链路 | Python/Paddle 依赖重，Electron 集成难 |
| **视觉大模型 API（Qwen2.5-VL/Mistral OCR）** | 中 | 端到端文档理解最强 | 隐私（简历内容上云）+ 成本 + 依赖 Key |
| **保持本地识别 + Agent 仅补漏**（#85 方向） | 小 | 快（<10s）、隐私、成本 0 | 姓名等规则缺口需补 |

优先级建议：① 先装语言包解 OCR blocker；② 本地规则补姓名去空格；③ 若扫描件质量不达标再评估 RapidOCR；④ 视觉大模型仅用于「用户显式选择增强」时。

## 复现与验证

- 本地识别基准（无 Agent）：`docs/benchmarks/local-no-agent-zhangwei.md`
- OCR 冒烟/性能：`scripts/ocr-smoke.mjs`（#79）
- Kimi 多模态对比脚本：`scripts/ocr-benchmark-kimi.mjs`（#80）
