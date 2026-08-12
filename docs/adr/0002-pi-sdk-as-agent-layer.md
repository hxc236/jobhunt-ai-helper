# 以 pi SDK 作为 agent 集成层

简历优化、面试官、学习三个模块通过 `@earendil-works/pi-coding-agent` 的 `createAgentSession` 内嵌进 Electron 主进程，而非 pi CLI RPC 子进程或 LLM API 直连——保留 skills（teach）加载、流式事件、steer/followUp 能力。

会话策略：简历优化每次任务新建 inMemory session；面试一次面试一个长驻 session（steer 打断 / followUp 排队）；学习用 cwd=教学工作区 + continueRecent 跨会话续接 + `/skill:teach` 显式触发。

**锁定代价**：Node ≥22.19、纯 ESM 打包；认证用 `ModelRuntime.create({authPath, modelsPath})` 指向应用自有目录，不依赖用户 `~/.pi/agent`。关联 ticket #2、#6。
