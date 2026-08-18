# Moonshot Kimi 2.6 多模态识图对比基准（#80）

三路径对比（固定提示 + 相同合成/匿名化夹具），为未来 ADR 提供证据；**不接入正式应用**
（多模态图片输入、PDF MCP、供应商 PDF 接口均不进正式业务路径，#73 OCR and multimodal boundary）。

## 三路径

| 路径 | 说明 |
| --- | --- |
| A 纯 Windows OCR | `resources/win-ocr.ps1` 真实调用系统中文 OCR（与 #79 同一命令） |
| B Kimi 2.6 直接识图 | 页面 PNG → `moonshotai-cn/kimi-k2.6`（独立 Pi 认证） |
| C OCR 文本 + 图片复核 | A 的输出文本 + 页面 PNG → Kimi 2.6 |

固定结构化提示与关键字段期望定义在 `scripts/ocr-benchmark-kimi.mjs` 内
（与 `ocr-smoke.mjs` 共用 `src/main/services/fixtures/ocr/` 夹具）。

## 运行（可重复）

```bash
node scripts/ocr-benchmark-kimi.mjs --pi-home <独立 pi 目录> [--samples page1.png page2.png page3.png]
# 或：PI_INDEPENDENT_HOME=<目录> node scripts/ocr-benchmark-kimi.mjs
```

前置条件（独立 Pi）：
- 目录下 `agent/auth.json` 含 `moonshotai-cn` 的 api_key 凭据（pi 凭据格式）；
- 该独立 Pi 可用模型 `moonshotai-cn/kimi-k2.6`（对应 API 模型名可用 `--model` 覆盖）。

报告记录：模型 ID、日期、关键字段正确性、正文漏失/阅读顺序（other 数组核对）、
每路径耗时、usage tokens（成本 = tokens × Moonshot 单价）。报告追加到
`.checkpoint/ocr-benchmark-kimi.md`（gitignore；不含认证信息与私人材料）。

## 认证与隐私边界（#80 验收）

- 只用独立 Pi 的全局 Moonshot 认证；**不读不写项目 userData/pi 的 auth**，不向仓库写 API Key；
- 只发送合成/匿名化页面；运行记录不含认证信息与私人真实简历；
- 独立认证不可用 → 明确停止并记录 blocker（已实测：本机无独立 Pi 认证，报告为占位证据），
  **不改用项目认证**；
- 对比结论若显示多模态在准确率/耗时/成本/隐私上全面占优，通过独立 ADR 改变默认路径，
  不在本规格实现中隐藏切换（#73 Further Notes）。

## 当前状态（2026-08）

Blocker：本机无独立 Pi（moonshotai-cn/kimi-k2.6）认证。占位报告见
`.checkpoint/ocr-benchmark-kimi.md`。Windows OCR 侧另见 #79（缺 zh-Hans 语言包 → ENGINE_FAIL）。
两条路径的真实数据待环境就绪后补齐。
