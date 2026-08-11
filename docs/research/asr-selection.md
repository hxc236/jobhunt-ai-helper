# 本地离线语音识别（中文）选型调研

关联 ticket: [hxc236/jobhunt-ai-helper#3 — 语音 ASR 选型调研](https://github.com/hxc236/jobhunt-ai-helper/issues/3)
技术栈约束: Electron 主进程（Node/TS 运行时）、单机 Windows、模拟面试短句轮流问答、实时性要求中等、尽可能 CPU 即可。

## TL;DR 结论

| 方案 | Node/TS 集成 | 中文质量 | 模型体积 | Windows 部署 | 实时性 | 需 GPU |
|---|---|---|---|---|---|---|
| **sherpa-onnx（官方 node binding）** | ★★★★★ 官方 npm 预编译 | ★★★★（streaming Zipformer-zh int8 CER 低、可选 SenseVoice/Paraformer 更高） | 21 MB ~ 160 MB（int8） | ★★★★★ npm 装即用 | ★★★★★ 流式 + Silero VAD | 否 |
| faster-whisper | ★★ Python-only，需 sidecar | ★★★（whisper 系，中文一般） | 39 MB ~ 3 GB | ★★★ 需打包 Python | ★★ 非流式（整段转写） | 否（int8 CPU 可跑） |
| whisper.cpp | ★★★ 官方 JS 绑定是 WASM；原生需第三方/自编译 | ★★★（whisper 系） | 75 MB ~ 3 GB | ★★★ 官方发 Win 二进制，node 绑定要编译 | ★★ stream 示例是 demo 级 | 否 |
| Vosk | ★★★★ 官方 npm + 自带 DLL | ★★（Kaldi 旧模型，WER 明显差） | 中文 1.3 GB 起 | ★★★★ 装即用 | ★★★★★ 流式 | 否 |
| FunASR | ★★ Python-only；新 llama.cpp runtime 单二进制可作 sidecar | ★★★★★（SenseVoice CER 7.81%） | 228 MB（int8 onnx）/ GGUF q8 | ★★★★（新 runtime 有 Win x64 exe） | ★★★★ 流式 paraformer / WebSocket | 否（Nano 需 GPU） |

**推荐: sherpa-onnx + 官方 Node.js addon（npm 包 `sherpa-onnx-node`），中文流式模型 `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`（int8，解压约 160 MB）。**

理由: 唯一在 Electron 主进程内直接可用的官方原生绑定（Windows x64 预编译、无需编译工具链）；流式识别 + 内置 Silero VAD 天然匹配"短句轮流问答"；同一 runtime 内可随时换 SenseVoice / Paraformer / Whisper 模型做质量升级，无需改架构。备选: 若纯中文质量优先且接受 sidecar 进程，FunASR 的 llama.cpp runtime（SenseVoice GGUF）或 sherpa-onnx 跑 SenseVoice int8（228 MB，非流式 + VAD）是最佳质量档。

---

## 1. sherpa-onnx（含 Node.js binding）

官方仓库: https://github.com/k2-fsa/sherpa-onnx

### Node/TS 集成（核心优势）

- 官方提供 Node.js binding，基于 node-addon-api、支持多线程，示例与用法见 `nodejs-addon-examples/`:
  https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
  （其 README 明确: "It uses node-addon-api to wrap sherpa-onnx for NodeJS and it supports multiple threads"，要求 Node >= 16）
- npm 包 `sherpa-onnx-node` 通过 optionalDependencies 分发各平台预编译二进制，Windows 由 `sherpa-onnx-win-x64` 提供（含 `sherpa-onnx.node`、`onnxruntime.dll`、`sherpa-onnx-c-api.dll` 等），即 `npm install` 开箱即用、无需 node-gyp/VS 工具链:
  https://www.npmjs.com/package/sherpa-onnx-node
  https://www.npmjs.com/package/sherpa-onnx-win-x64
- 仓库内有专门的 Windows CI（`.github/workflows/test-nodejs-addon-npm-win-x86.yaml`），Windows 是受支持平台
- 已有真实 Electron 应用用其 JS API（如 LOL 助手 lol-wom-electron）: https://github.com/l1veIn/lol-wom-electron
- 另有 WASM 方案 `nodejs-examples`（不支持多线程）与纯 WASM 浏览器方案，但 Node 场景应直接用原生 addon

### 流式 / 实时能力

- Node addon 同时提供流式（online/streaming）与非流式（offline）识别示例:
  `test_asr_streaming_transducer.js`、`test_asr_streaming_transducer_microphone.js`、`test_asr_streaming_ctc.js`、`test_asr_streaming_paraformer.js`
- 内置 Silero VAD（静音检测）: `test_vad_microphone.js`，以及 VAD + 非流式模型（SenseVoice/Paraformer/Whisper/transducer）麦克风示例:
  https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
- 中文标点恢复模型（离线/在线）也有 Node 示例（`test_offline_punctuation.js` 等），可直接给转写文本加标点

### 中文模型（体积 = GitHub release `asr-models` 资产压缩包大小，解压大小见各 docs 页）

| 模型 | 类型 | 压缩包/解压体积 | 说明 |
|---|---|---|---|
| `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` | 流式 transducer | 132 MB / encoder 154 MB + decoder 4.9 MB + joiner 1 MB（int8） | Zipformer-Large（multi zh-hans），中文主力推荐 |
| `sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01` | 流式 CTC | 21 MB | 极小体积档 |
| `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23` | 流式 | 74 MB / int8 encoder 21 MB | 小模型，WenetSpeech 训练 |
| `sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13` | 流式 | 62 MB | 中英混说支持更好 |
| `sherpa-onnx-streaming-zipformer-small/bilingual-zh-en-2023-02-16/20` | 流式 | 458 / 511 MB | 中英双语 |
| `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | 非流式 | 163 MB / model.int8.onnx 228 MB | SenseVoice，中英日韩粤，带情感/标点等富信息，质量档最高 |
| `sherpa-onnx-paraformer-zh-int8-2025-10-07` | 非流式 | 228 MB（model.int8.onnx） | FunASR Paraformer 220M 参数导出 |
| `sherpa-onnx-paraformer-zh-small-2024-03-09` | 非流式 | 78 MB | Paraformer 小模型 |
| `sherpa-onnx-whisper-tiny/base/small` | 非流式 | 116 / 207 / 639 MB | whisper 导出 |

来源:
- release 资产（体积）: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- 流式 zipformer 中文模型文档（解压体积、WenetSpeech 训练说明）: https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/pretrained_models/online-transducer/zipformer-transducer-models.rst
- SenseVoice 文档（228 MB int8 / 894 MB fp32、支持语言、Windows x64/x86/arm64 平台声明）: https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/sense-voice/index.rst 、`pretrained.rst`
- Paraformer 文档: https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/pretrained_models/offline-paraformer/paraformer-models.rst

### GPU 要求

- 不需要 GPU，纯 CPU（onnxruntime）即可实时；官方文档按 CPU 场景给出示例。可选 CUDA 等加速，但本项目无此需求。

---

## 2. faster-whisper（Python）

官方仓库: https://github.com/SYSTRAN/faster-whisper

- 用 CTranslate2 重写 OpenAI Whisper，README 声明比 openai/whisper **快最多 4 倍**、CPU/GPU 均支持 int8 量化；音频解码用 PyAV 内置 FFmpeg，无需系统安装 FFmpeg
- 官方基准（13 分钟音频，i7-12700K 8 线程）: small int8 用时 1m42s（约 7.6x 实时）、fp32 2m37s; whisper.cpp fp32 为 2m05s
- **纯 Python**（要求 Python 3.9+，`pip install faster-whisper`），无任何官方 Node/TS 绑定
- 模型为 OpenAI Whisper 系列（tiny 39M / base 74M / small 244M / medium 769M / large-v3 1550M 参数）: https://github.com/openai/whisper
- 非流式（整段转写），"实时"需自行做 VAD + 切段，官方不提供流式 API
- 中文质量 = Whisper 系水平（FunASR 自有基准中 Whisper-large-v3 中文 CER 20.02%，见 §5；whisper 训练数据偏英文与网络噪声，对话场景无明显优势）
- 集成方式: 只能以 sidecar（Python 子进程 / PyInstaller 打包 + IPC）接入 Electron —— 引入第二运行时，部署体积与复杂度明显上升
- GPU 可选（需 cuBLAS/cuDNN），CPU int8 可跑

来源: https://github.com/SYSTRAN/faster-whisper

---

## 3. whisper.cpp（含 Node 方案）

官方仓库: https://github.com/ggml-org/whisper.cpp

### Node 绑定现状（关键结论）

- 官方 JS 绑定在 `bindings/javascript/`，是 **emscripten/WASM 方案**（非原生 addon），API 自己标注 "very rudimentary"，npm 包名 `whisper.cpp`:
  https://github.com/ggml-org/whisper.cpp/tree/master/bindings/javascript
  https://www.npmjs.com/package/whisper.cpp
  - WASM 无 AVX 等原生优化，性能低于原生；Node 16.4 之前需开 `--experimental-wasm-threads --experimental-wasm-simd` 实验 flag
- 官方没有原生（node-addon）绑定。第三方原生方案:
  - `whisper-node`（ariym 维护的 fork，npm 包 `whisper-node`）: 编译 whisper.cpp 为原生 addon；README 注明 Windows 需要安装 `make`（gnuwin32），即 Windows 上要配编译环境: https://github.com/ariym/whisper-node
  - `nodejs-whisper`（npm 0.3.1）: 包装 whisper.cpp CLI 二进制，需自带编译好的 whisper.cpp 可执行文件 + ffmpeg: https://www.npmjs.com/package/nodejs-whisper
- whisper.cpp 官方 release 提供 Windows 预编译 CLI 二进制（`whisper-bin-x64.zip`）: https://github.com/ggml-org/whisper.cpp/releases —— 若走"spawn 子进程"路线可免编译

### 实时性 / 质量 / 体积

- 官方 `stream` 示例: 每 500ms 采样并连续转写（step 500ms / length 5s 窗口），属 demo 级实现，非低延迟流式引擎: https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream
- 模型 = Whisper 系 GGML 版（ggml-tiny ~75 MB 起，large-v3 约 3 GB），中文质量同 Whisper 系（见 §2/§5 的 CER 对比）
- CPU 原生性能在 Whisper 系实现里最好（faster-whisper 基准中 fp32 2m05s / 13min 音频），但优势会被"Node 集成路径绕"抵消
- GPU 可选（CUDA/OpenVINO/CoreML），不需要

---

## 4. Vosk

官方仓库: https://github.com/alphacep/vosk-api ；模型页: https://alphacephei.com/vosk/models

- 官方 Node.js 绑定，npm 包 `vosk`（0.3.39，FFI-NAPI 封装），Windows 下直接加载包内 `lib/win-x86_64/libvosk.dll`，**npm install 即用、无需编译**: https://www.npmjs.com/package/vosk 、https://github.com/alphacep/vosk-api/tree/master/nodejs
- 流式 API（partial results），官方称"zero-latency response with streaming API"；支持可配置词表、说话人识别
- 但**中文模型不小、质量旧**: 模型页显示仅两个中文模型——
  - `vosk-model-cn-0.22`: 1.3 GB，WER 13.98（SpeechIO-02）/ 7.43（THCHS）
  - `vosk-model-cn-kaldi-multicn-0.15`: 1.5 GB，WER 17.44（SpeechIO-02）
  （README 中"models are small (50 Mb)"指其他语言，不含中文）
- Kaldi 时代模型，无标点，口语/对话场景识别质量明显落后于 Zipformer/Paraformer/SenseVoice/Whisper 系
- CPU 即可，不需要 GPU

---

## 5. FunASR（及其他值得考虑者）

官方仓库: https://github.com/modelscope/FunASR

- 阿里达摩院工业级 ASR 工具包，Python 生态（`pip install funasr` + torch/torchaudio），主打 Paraformer（离线/流式）、SenseVoice、Fun-ASR-Nano（LLM-ASR，官方明确**需要 GPU**）
- **无官方 Node SDK**。部署路径按其官方 deployment matrix:
  - OpenAI 兼容 HTTP API 服务（sidecar）: https://github.com/modelscope/FunASR/tree/master/examples/openai_api
  - WebSocket 流式 runtime（docker: `funasr-runtime-sdk-online-cpu`）
  - **llama.cpp runtime（v0.2.0）**: SenseVoice/Paraformer 的**单文件自包含二进制**，官方发布 Windows x64 包（`funasr-llamacpp-windows-x64-vulkan.zip` / `-cuda.zip`），GGUF 模型 + 内置 FSMN-VAD，**无需 Python**，可作 Electron sidecar 子进程: https://github.com/modelscope/FunASR/releases/tag/runtime-llamacpp-v0.2.0
- 官方自有基准（184 段长音频 / 192 min，中文 CER）:
  - SenseVoice-Small: **7.81%**（CPU 17x 实时）
  - Paraformer-Large: 10.18%（CPU 15x 实时）
  - Whisper-large-v3: 20.02%（CPU 不可用基准）
  - 来源: https://github.com/modelscope/FunASR （README "Benchmark" 节；完整报告 https://modelscope.github.io/FunASR/benchmark.html ）
- 与 sherpa-onnx 的交叉点: SenseVoice 与 Paraformer 都有官方 ONNX 导出，**sherpa-onnx 可直接运行这两个模型**（Node addon 示例含 `test_asr_non_streaming_sense_voice.js`、`test_asr_non_streaming_paraformer.js`）——即"FunASR 模型质量 + Node 原生运行时"可以兼得

### 其他值得一提

- **transformers.js（@huggingface/transformers v4）**: 纯 JS 跑 Whisper（依赖 onnxruntime-node，可在 Electron 主进程运行），免原生编译，但 CPU 性能低于原生实现，中文质量同 Whisper 系: https://www.npmjs.com/package/@huggingface/transformers
- sherpa-onnx 本身支持的 Moonshine、NeMo Parakeet、Qwen3-ASR 等模型不在本次选型范围（均为非流式，且中文并非其主打）

---

## 6. 结论与推荐

### 推荐方案: sherpa-onnx + Node addon

1. **集成最顺**: `sherpa-onnx-node` 官方 npm 包 + `sherpa-onnx-win-x64` 预编译二进制，Electron 主进程直接 `require`，无 Python 运行时、无编译工具链、无 sidecar IPC。这是五个候选中唯一"官方、原生、预编译、Windows 受 CI 保障"的 Node 方案。
2. **面试场景匹配**: 流式 Zipformer 模型 + Silero VAD 支持"说完即识别、短句轮流问答"；中等实时性要求下 CPU 完全够用（int8 模型 + onnxruntime 多线程）。
3. **模型体积可控**: 首推 `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`（解压约 160 MB）；要更小可用 `small-ctc-zh-int8-2025-04-01`（21 MB）或 `zh-14M`（74 MB 压缩包），代价是质量下降。
4. **质量可升级路径**: 同一 runtime 换 SenseVoice int8（228 MB，非流式，配 VAD 用）即可拿到中文最高质量档（FunASR 基准 CER 7.81%），或 Paraformer int8（228 MB）。
5. 不需要 GPU；Windows 单机部署 = 复制 node_modules + 模型目录。

### 各方案一句话评价

- **faster-whisper**: 模型/性能好，但纯 Python 决定它在 Electron 里只能是"第二运行时 sidecar"，集成成本最高，不建议。
- **whisper.cpp**: 引擎性能最好，但官方 Node 绑定是 WASM（慢且 API 简陋），原生绑定全是第三方且 Windows 要编译环境；除非接受 CLI sidecar 或编译，否则性价比低。
- **Vosk**: 装起来最容易，但中文模型 1.3 GB 起步且 WER 明显差，质量维度出局。
- **FunASR**: 中文质量最强（SenseVoice），但官方 Node 集成仍要绕 sidecar（llama.cpp runtime 是最新且最省事的路）；其模型可被 sherpa-onnx 直接运行，故"FunASR 模型 + sherpa-onnx Node 运行时"是质量与集成的最优组合。
