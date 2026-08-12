# ASR 选 sherpa-onnx-node

面试语音输入用 sherpa-onnx 官方 Node addon（Windows x64 预编译免编译）+ 流式中文模型（streaming-zipformer-zh-int8-2025-06-30，约 160MB）+ Silero VAD（静音≥1s 切句）；CPU 即可，无需 GPU。

**落选方案**：faster-whisper（Python sidecar，进程桥接重）；whisper.cpp（Node 绑定需编译）；Vosk（中文模型 1.3GB 且质量差）。质量优先时可同 runtime 换 SenseVoice int8。触发方式：PTT 按键说话（避免噪音误触发）。关联 ticket #3、#10。
