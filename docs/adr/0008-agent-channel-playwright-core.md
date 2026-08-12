# Agent 通道引入 playwright-core（打破 ADR-0006 零依赖原则）

BOSS 采集的 Agent 通道（登录/异常/复杂交互的决策循环）用 `playwright-core`（纯 JS，不下载浏览器）`connectOverCDP` 连接应用自带 Chromium——启动参数 `remote-debugging-port=0`（只绑 127.0.0.1、随机端口、端口号写 userData/DevToolsActivePort，连接用完即关）。

**取舍**：ADR-0006 的零依赖原则是"手动低频采集不值 150MB 浏览器"；playwright-core 无浏览器（复用应用内置 Chromium），几 MB，换来成熟的选择器/等待/事件 API——比 Electron 内置 `webContents.debugger` 手写 CDP 命令的开发量与出错率低得多。安全面：调试端口只绑本机回环 + 随机端口，本机进程本就可完全控制用户会话，不新增实质威胁。

**边界**：Agent 通道只做正常浏览器交互（点击/输入/等待/重试），不绕过任何验证码/风控；解决不了的场景交还用户（留痕标"需人工介入"）。关联 ticket #59、#50。
