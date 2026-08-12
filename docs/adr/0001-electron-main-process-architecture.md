# Electron 主进程合一架构，IPC 通信，better-sqlite3

应用采用 Electron 主进程承载全部业务服务（agent / crawl / resume / asr / interview），渲染进程（Vue 3）经 contextBridge 类型化 IPC 与主进程通信，SQLite 由主进程直连（better-sqlite3）。

**考虑过的方案**：utilityProcess 拆分（ASR/爬虫）隔离崩溃——MVP 复杂度不值；本地 HTTP（Express）——多一层服务管理且无端口/安全收益。**例外**：pi SDK 要求 Node ≥22.19（ESM），若目标 Electron 内置 Node 不满足，仅 agent-service 移入 utilityProcess（独立 Node），其余结构不变。关联 ticket #6。
